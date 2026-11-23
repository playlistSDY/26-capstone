"""Loopback-only kiosk host, persisted settings, receipt rasterization and Windows spool handoff."""
import argparse
import base64
import json
import logging
import os
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import urllib.request
import queue
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode

from receipt_renderer import render_receipt, validate_document

APP_ID = "switch-kiosk-local-v1"
DEFAULTS = {"printerName": "", "autoPrint": False, "variant": "receipt",
            "fontScale": 1.0, "offsetXmm": 0.0, "soundEnabled": True, "soundVolume": 75}


def browser_arguments(browser, profile, port, show_settings, version=None):
    query = {"kiosk": "1"}
    if show_settings:
        query["printerSetup"] = "1"
    if version:
        query["appVersion"] = version
    return [str(browser), f"--user-data-dir={profile}", "--no-first-run", "--no-default-browser-check",
            "--disable-background-networking", "--disable-background-mode", "--disable-component-update", "--disable-sync",
            # CfT's buttonless product banner otherwise remains visible even in kiosk mode.
            # https://github.com/chromium/chromium/blob/main/components/infobars/core/infobar_manager.cc
            "--disable-infobars", "--kiosk", f"http://127.0.0.1:{port}/?" + urlencode(query)]


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def close_owned_browser(process):
    """Close only a browser process we launched, including its Windows children."""
    if process.poll() is not None:
        return
    if sys.platform == "win32":
        for force in [False, True]:
            try:
                subprocess.run(["taskkill.exe", "/PID", str(process.pid), "/T"] + (["/F"] if force else []),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
                               creationflags=0x08000000)
                process.wait(timeout=3)
                return
            except (OSError, subprocess.TimeoutExpired):
                pass
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


class OwnedKioskWindows:
    def __init__(self, browser, profile, port, version=None):
        self.browser, self.profile, self.port = browser, profile, port
        self.version = version
        self.lock = threading.RLock()
        self.processes = []
        self.closed = False

    def open(self, show_settings=False):
        with self.lock:
            if self.closed:
                raise ApiError("키오스크를 종료하고 있어요.", 503)
            self.processes = [p for p in self.processes if p.poll() is None]
            process = subprocess.Popen(browser_arguments(self.browser, self.profile, self.port, show_settings, self.version),
                                       creationflags=0x00000008)
            self.processes.append(process)

    def close(self):
        with self.lock:
            self.closed = True
            for process in reversed(self.processes):
                try:
                    close_owned_browser(process)
                except Exception:
                    logging.exception("Could not close owned kiosk browser")
            self.processes.clear()


class WindowsPrinter:
    def __init__(self, root):
        self.script = (root / "windows_print.ps1").read_text(encoding="utf-8")
        self._lock = threading.RLock()
        self._process = None
        self._responses = None
        self._printer_cache = None
        self._closed = False
        self._reader_thread = None

    def _start(self):
        if self._closed:
            raise ApiError("키오스크를 종료하고 있어요.", 503)
        if self._process and self._process.poll() is None:
            return
        command = base64.b64encode(self.script.encode("utf-16-le")).decode("ascii")
        process = subprocess.Popen(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", bufsize=1, creationflags=0x08000000)
        responses = queue.Queue()
        self._process, self._responses = process, responses
        def read():
            try:
                for line in process.stdout:
                    try:
                        responses.put(json.loads(line.lstrip("\ufeff")))
                    except ValueError:
                        logging.warning("Windows print worker: %s", line.strip())
            except (OSError, ValueError):
                pass
            finally:
                responses.put({"error": "Windows 인쇄 프로세스가 종료됐어요."})
        self._reader_thread = threading.Thread(target=read, daemon=True)
        self._reader_thread.start()

    def close(self):
        with self._lock:
            process, self._process = self._process, None
            reader, self._reader_thread = self._reader_thread, None
            if process:
                try:
                    if process.stdin:
                        process.stdin.close()  # EOF lets the persistent worker exit normally.
                    process.wait(timeout=3)
                except (OSError, subprocess.TimeoutExpired):
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
                finally:
                    if reader and reader is not threading.current_thread():
                        reader.join(timeout=1)
                    if process.stdout:
                        process.stdout.close()

    def shutdown(self):
        with self._lock:
            self._closed = True
            self.close()

    def warmup(self):
        try:
            self.call("ping")
        except Exception:
            logging.exception("Windows print worker warmup failed")

    def call(self, action, request=None):
        if sys.platform != "win32":
            raise ApiError("프린터 출력은 Windows 로컬 실행에서 사용할 수 있어요.", 503)
        with self._lock:
            self._start()
            nonce = uuid.uuid4().hex
            try:
                # ASCII JSON escapes keep Unicode paths portable across Windows console codepages.
                self._process.stdin.write(json.dumps({"id": nonce, "action": action, "request": str(request) if request else None}, ensure_ascii=True) + "\n")
                self._process.stdin.flush()
                deadline = time.monotonic() + 45
                while True:
                    data = self._responses.get(timeout=max(.01, deadline - time.monotonic()))
                    if data.get("error"):
                        raise ApiError(data["error"], 502)
                    if data.get("id") == nonce:
                        return data["result"]
                    if time.monotonic() >= deadline:
                        raise queue.Empty()
            except queue.Empty:
                self.close()
                raise ApiError("인쇄 응답이 지연되고 있어요. 대기열을 확인한 뒤 수동 재출력해 주세요.", 504)
            except (OSError, BrokenPipeError):
                self.close()
                raise ApiError("인쇄 프로세스 연결이 끊겼어요. 대기열을 확인해 주세요.", 502)

    def printers(self, force=False):
        with self._lock:
            if not force and self._printer_cache and time.monotonic() - self._printer_cache[0] < 30:
                return self._printer_cache[1]
            data = self.call("printers")
            result = data if isinstance(data, list) else []
            self._printer_cache = (time.monotonic(), result)
            return result

    def print(self, request):
        return self.call("print", request)


class FilePrinter:
    """Explicit development adapter. Never selected automatically on Windows."""
    def printers(self, force=False):
        return [{"name": "개발용 PNG 저장", "driver": "파일 출력 (종이 출력 없음)", "port": "FILE",
                 "offline": False, "virtual": False, "status": 0}]

    def print(self, request):
        return {"state": "file-saved"}


class KioskService:
    def __init__(self, root, data, adapter=None):
        self.root, self.data = Path(root), Path(data)
        self.data.mkdir(parents=True, exist_ok=True)
        (self.data / "receipts").mkdir(exist_ok=True)
        self.token = secrets.token_urlsafe(32)
        self.stopping = threading.Event()
        self._lifecycle_lock = threading.Lock()
        self._closed = False
        self.windows = None
        release = self.root.parent / "release.json"
        self.version = json.loads(release.read_text(encoding="utf-8"))["version"] if release.exists() else "legacy"
        self.lock = threading.RLock()
        self.adapter = adapter or WindowsPrinter(self.root)
        self.database = self.data / "jobs.sqlite3"
        with self.connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, created REAL NOT NULL, value TEXT NOT NULL)")
            # A crash during spool handoff is uncertain, never safe to replay automatically.
            db.execute("UPDATE jobs SET state='uncertain' WHERE state='processing'")

    def connect(self):
        return sqlite3.connect(self.database, timeout=10)

    def begin_shutdown(self):
        with self._lifecycle_lock:
            first = not self.stopping.is_set()
            self.stopping.set()
            return first

    def require_running(self):
        if self.stopping.is_set():
            raise ApiError("키오스크를 종료하고 있어요.", 503)

    def close(self):
        self.begin_shutdown()
        with self.lock:  # Finish spool handoff and commit its result before closing the worker.
            if self._closed:
                return
            self._closed = True
            try:
                if hasattr(self.adapter, "shutdown"):
                    self.adapter.shutdown()
            finally:
                if self.windows:
                    self.windows.close()

    def settings(self):
        with self.connect() as db:
            row = db.execute("SELECT value FROM settings WHERE id=1").fetchone()
        return {**DEFAULTS, **(json.loads(row[0]) if row else {})}

    def save_settings(self, incoming):
        self.require_running()
        if not isinstance(incoming, dict):
            raise ApiError("설정 형식이 올바르지 않아요.")
        s = {**self.settings(), **{k: v for k, v in incoming.items() if k in DEFAULTS}}
        if type(s["autoPrint"]) is not bool or type(s["soundEnabled"]) is not bool:
            raise ApiError("자동 출력 및 효과음 설정이 올바르지 않아요.")
        if s["variant"] not in ["receipt", "pickup"]:
            raise ApiError("영수증 종류를 확인해 주세요.")
        for key, low, high in [("fontScale", .8, 1.3), ("offsetXmm", -3, 3), ("soundVolume", 0, 100)]:
            if type(s[key]) not in [int, float] or not low <= s[key] <= high:
                raise ApiError("인쇄 크기·보정·효과음 볼륨 범위를 확인해 주세요.")
        if not isinstance(s["printerName"], str) or len(s["printerName"]) > 200:
            raise ApiError("프린터 이름이 올바르지 않아요.")
        if s["printerName"]:
            choices = {p["name"]: p for p in self.adapter.printers()}
            p = choices.get(s["printerName"])
            if not p or p.get("virtual"):
                raise ApiError("Windows에 등록된 실제 프린터를 선택해 주세요.")
        elif s["autoPrint"]:
            raise ApiError("자동 출력을 켜려면 프린터를 선택해 주세요.")
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO settings VALUES (1,?)", (json.dumps(s, ensure_ascii=False),))
        return s

    def jobs(self):
        with self.connect() as db:
            rows = db.execute("SELECT id,state,created,value FROM jobs ORDER BY created DESC LIMIT 30").fetchall()
        return [{"id": r[0], "state": r[1], "createdAt": r[2], **json.loads(r[3])} for r in rows]

    def print_job(self, payload):
        self.require_running()
        if not isinstance(payload, dict):
            raise ApiError("출력 요청이 올바르지 않아요.")
        key = payload.get("requestId")
        if not isinstance(key, str) or not 1 <= len(key) <= 180:
            raise ApiError("출력 요청 번호를 확인해 주세요.")
        variant = payload.get("variant", "receipt")
        if variant not in ["receipt", "pickup"]:
            raise ApiError("영수증 종류가 올바르지 않아요.")
        try:
            doc = validate_document(payload.get("document"))
        except ValueError as e:
            raise ApiError(str(e))
        with self.lock:
            self.require_running()
            with self.connect() as db:
                old = db.execute("SELECT state,value FROM jobs WHERE id=?", (key,)).fetchone()
                if old:
                    return {"id": key, "state": old[0], "duplicate": True, **json.loads(old[1])}
            settings = self.settings()
            if payload.get("kind") == "auto":
                variant = settings["variant"]
            if payload.get("kind") == "auto" and not settings["autoPrint"]:
                raise ApiError("자동 출력이 꺼져 있어요.", 409)
            # Printer enumeration can block on WMI/network queues. Selection is validated
            # when settings are saved; the native print call validates the named driver.
            if not settings["printerName"] or any(word in settings["printerName"].lower() for word in ["pdf", "xps", "onenote", "fax"]):
                raise ApiError("설정에서 출력할 프린터를 선택해 주세요.", 409)
            details = {"orderId": doc["id"], "number": doc["number"], "printerName": settings["printerName"]}
            with self.connect() as db:
                db.execute("INSERT INTO jobs VALUES (?,?,?,?)", (key, "processing", time.time(), json.dumps(details)))
            try:
                file_id = uuid.uuid4().hex
                image = self.data / "receipts" / f"{file_id}.png"
                started = time.monotonic()
                size = render_receipt(doc, variant, settings, self.root / "fonts" / "Pretendard.ttf", image)
                rendered = time.monotonic()
                request = image.with_suffix(".json")
                request.write_text(json.dumps({"imagePath": str(image.resolve()), "printerName": settings["printerName"],
                                                "offsetXmm": settings["offsetXmm"], "jobId": file_id}), encoding="utf-8")
                result = self.adapter.print(request)
                details.update({"renderMs": round((rendered - started) * 1000), "spoolMs": round((time.monotonic() - rendered) * 1000)})
                state = result["state"]
                details.update(size)
            except Exception as e:
                state = "uncertain" if isinstance(e, ApiError) and e.status == 504 else "error"
                details["message"] = str(e)
                logging.exception("Print job failed")
            with self.connect() as db:
                db.execute("UPDATE jobs SET state=?,value=? WHERE id=?", (state, json.dumps(details, ensure_ascii=False), key))
            return {"id": key, "state": state, **details}


def handler_for(service, web_root, port, dev=False):
    allowed_origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    if dev:
        allowed_origins |= {"http://127.0.0.1:5173", "http://localhost:5173"}

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def end_headers(self):
            # Only the entry page must always revalidate. Hashed menu assets can
            # keep their cache so slow kiosks do not reload every image/font.
            if urlsplit(self.path).path in ["/", "/index.html"]:
                self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.send_header("Expires", "0")
            super().end_headers()

        def permitted(self):
            if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
                raise ApiError("허용되지 않은 호스트예요.", 403)
            origin = self.headers.get("Origin")
            if origin and origin not in allowed_origins:
                raise ApiError("허용되지 않은 요청 출처예요.", 403)
            if self.command == "POST" and self.headers.get("X-Switch-Token") != service.token:
                raise ApiError("연결을 새로고침한 뒤 다시 시도해 주세요.", 403)

        def send_json(self, value, code=200):
            data = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            try:
                self.permitted()
                route = urlsplit(self.path).path
                if sys.platform == "win32" and route in ["/", "/index.html"]:
                    query = parse_qs(urlsplit(self.path).query)
                    if query.get("kiosk") != ["1"]:
                        query["kiosk"] = ["1"]
                        self.send_response(302)
                        self.send_header("Location", "/?" + urlencode(query, doseq=True))
                        self.end_headers()
                        return
                if route == "/api/status":
                    return self.send_json({"app": APP_ID, "version": service.version, "token": service.token, "platform": sys.platform,
                                           "stopping": service.stopping.is_set(), "windowControl": service.windows is not None,
                                           "fileMode": isinstance(service.adapter, FilePrinter), "settings": service.settings()})
                if route == "/api/printers":
                    return self.send_json({"printers": service.adapter.printers(force=True)})
                if route == "/api/jobs":
                    return self.send_json({"jobs": service.jobs()})
                if route.startswith("/api/"):
                    raise ApiError("없는 API예요.", 404)
                if route in ["/", "/index.html"] and "If-Modified-Since" in self.headers:
                    # An old/future timestamp must never turn the entry page into
                    # a 304 that preserves a previous release's script URL.
                    del self.headers["If-Modified-Since"]
                self.path = route
                super().do_GET()
            except ApiError as e:
                self.send_json({"error": str(e)}, e.status)

        def do_POST(self):
            try:
                self.permitted()
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise ApiError("JSON 요청이 필요해요.", 415)
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= 300000:
                    raise ApiError("요청이 비어 있거나 너무 커요.", 413)
                value = json.loads(self.rfile.read(length))
                if self.path == "/api/settings":
                    return self.send_json({"settings": service.save_settings(value)})
                if self.path == "/api/print":
                    return self.send_json(service.print_job(value))
                if self.path == "/api/shutdown":
                    first = service.begin_shutdown()
                    self.send_json({"stopping": True})
                    if first:
                        def finish_shutdown():
                            try:
                                service.close()
                            except Exception:
                                logging.exception("Kiosk cleanup failed")
                            finally:
                                self.server.shutdown()
                        threading.Thread(target=finish_shutdown, daemon=True).start()
                    return
                if self.path == "/api/window":
                    service.require_running()
                    if not service.windows:
                        raise ApiError("이 실행 환경에서는 전용 창을 열 수 없어요.", 503)
                    if not isinstance(value, dict) or type(value.get("settings", False)) is not bool:
                        raise ApiError("창 요청 형식이 올바르지 않아요.")
                    service.windows.open(value.get("settings", False))
                    return self.send_json({"opened": True})
                raise ApiError("없는 API예요.", 404)
            except (ValueError, TypeError) as e:
                self.send_json({"error": "요청 값을 확인해 주세요."}, 400)
            except ApiError as e:
                self.send_json({"error": str(e)}, e.status)
            except Exception:
                logging.exception("API failure")
                self.send_json({"error": "로컬 처리 중 오류가 발생했어요. 실행 창의 로그를 확인해 주세요."}, 500)

        def log_message(self, fmt, *args):
            logging.info(fmt, *args)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18731)
    parser.add_argument("--data", type=Path)
    parser.add_argument("--file-mode", action="store_true")
    parser.add_argument("--dev", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--settings", action="store_true")
    parser.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    data = args.data or (Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "SWitch/Kiosk")
    data.mkdir(parents=True, exist_ok=True)
    status = None
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{args.port}/api/status", timeout=1) as response:
            status = json.load(response)
    except Exception:
        pass
    if status and status.get("app") != APP_ID:
        raise RuntimeError("Port is in use by another application.")
    if args.stop:
        if status:
            request = urllib.request.Request(f"http://127.0.0.1:{args.port}/api/shutdown", data=b"{}", method="POST",
                                             headers={"Content-Type":"application/json", "X-Switch-Token":status["token"]})
            urllib.request.urlopen(request, timeout=3).close()
        return
    if status:
        if not args.no_browser and status.get("windowControl"):
            request = urllib.request.Request(f"http://127.0.0.1:{args.port}/api/window",
                data=json.dumps({"settings": args.settings or not status["settings"]["printerName"]}).encode(), method="POST",
                headers={"Content-Type": "application/json", "X-Switch-Token": status["token"]})
            urllib.request.urlopen(request, timeout=10).close()
        print("Existing local backend reused.", flush=True)
        return
    logging.basicConfig(filename=data / "backend.log", level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    service = KioskService(root, data, FilePrinter() if args.file_mode else None)
    browser = root.parent / "browser/chrome-win64/chrome.exe"
    if sys.platform == "win32" and browser.exists():
        service.windows = OwnedKioskWindows(browser, data / "BrowserProfile", args.port, service.version)
    web = root.parent / "web"
    if not web.exists():
        web = root.parent / "dist"
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(service, web, args.port, args.dev))
    server.daemon_threads = True
    print(f"SWitch local kiosk: http://127.0.0.1:{args.port}/", flush=True)
    print(f"Settings / logs: {data}", flush=True)
    print("Home screen: tap the top-right corner 5 times, then confirm to exit.", flush=True)
    try:
        if sys.platform == "win32" and isinstance(service.adapter, WindowsPrinter):
            threading.Thread(target=service.adapter.warmup, daemon=True).start()
        if not args.no_browser:
            if service.windows:
                service.windows.open(args.settings or not service.settings()["printerName"])
            else:
                print("Bundled browser unavailable; open the local address manually.", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            service.close()
        finally:
            logging.shutdown()


if __name__ == "__main__":
    main()
