"""Loopback-only voice lab with a managed ESP worker and live SSE events."""

import argparse
from collections import deque
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
APP_ID = "switch-voice-lab-v1"


class EventHub:
    def __init__(self):
        self.condition = threading.Condition()
        self.events = deque(maxlen=1600)
        self.accepted = deque(maxlen=64)
        self.sequence = 0

    def publish(self, event):
        with self.condition:
            self.sequence += 1
            row = {**event, "id": self.sequence}
            row.setdefault("time", time.time())
            self.events.append(row)
            if row.get("event") == "turn.accept":
                self.accepted.append(row)
            self.condition.notify_all()
            return row

    def since(self, cursor):
        with self.condition:
            return [r for r in self.events if r["id"] > cursor]


class Worker:
    def __init__(self, hub, command=None):
        self.hub = hub
        self.command = command or [sys.executable, "-u", str(HERE / "serial_stt.py"), "--json-events"]
        self.process = None
        self.lock = threading.RLock()

    def running(self):
        return self.process is not None and self.process.poll() is None

    def start(self):
        with self.lock:
            if self.running():
                return
            child = subprocess.Popen(self.command, cwd=HERE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
            self.process = child
            self.hub.publish({"event": "worker.starting", "message": "ESP 수음기를 연결하고 있어요."})
            threading.Thread(target=self.read, args=(child,), daemon=True).start()

    def read(self, child):
        try:
            for line in child.stdout:
                if child is not self.process:
                    break
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict) or not isinstance(row.get("event"), str):
                        raise ValueError()
                except (ValueError, TypeError):
                    row = {"event": "worker.log", "message": line.strip()[:1500]}
                self.hub.publish(row)
        finally:
            child.stdout.close()
            child.stdin.close()
            code = child.wait()
            if child is self.process:
                self.hub.publish({"event": "worker.exited", "code": code, "message": "수음기를 종료했어요." if code == 0 else "연결을 확인하고 다시 시작해 주세요."})

    def stop(self):
        with self.lock:
            child = self.process
            if child is None or child.poll() is not None:
                return
            if any(Path(arg).name == "voice_relay.py" for arg in self.command):
                # Cooperative exit also works on Windows, where terminate()
                # skips finally blocks and would leave a server lease briefly.
                try:
                    child.stdin.write("stop\n")
                    child.stdin.flush()
                    child.wait(timeout=3)
                    return
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            child.terminate()
            try:
                child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                child.kill()  # Only the child this dashboard created.
                child.wait(timeout=2)


class LabServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (BrokenPipeError, ConnectionResetError)):
            return  # A browser reload is an ordinary SSE disconnect.
        super().handle_error(request, client_address)

    def __init__(self, address, *, command=None):
        self.hub = EventHub()
        self.worker = Worker(self.hub, command)
        self.token = secrets.token_urlsafe(32)
        self.closed = threading.Event()
        super().__init__(address, Handler)

    def snapshot(self):
        with self.hub.condition:
            return {"app": APP_ID, "token": self.token, "running": self.worker.running(), "cursor": self.hub.sequence, "events": list(self.hub.events), "accepted": list(self.hub.accepted)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def allowed(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origin = self.headers.get("Origin")
        return self.headers.get("Host") in hosts and (origin is None or origin in {"http://" + h for h in hosts})

    def send(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        from urllib.parse import urlsplit, parse_qs
        if not self.allowed():
            return self.send(403, {"error": "local_origin_required"})
        url = urlsplit(self.path)
        if url.path == "/api/state":
            return self.send(200, self.server.snapshot())
        if url.path == "/api/events":
            try:
                cursor = max(0, int(self.headers.get("Last-Event-ID") or parse_qs(url.query).get("after", [0])[0]))
            except ValueError:
                return self.send(400, {"error": "bad_cursor"})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                while not self.server.closed.is_set():
                    rows = self.server.hub.since(cursor)
                    if rows:
                        for row in rows:
                            data = json.dumps(row, ensure_ascii=False)
                            self.wfile.write(f"id: {row['id']}\ndata: {data}\n\n".encode())
                            cursor = row["id"]
                    else:
                        self.wfile.write(b": alive\n\n")
                    self.wfile.flush()
                    with self.server.hub.condition:
                        if self.server.hub.sequence <= cursor:
                            self.server.hub.condition.wait(timeout=2)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            return
        files = {"/": (HERE / "dashboard/index.html", "text/html; charset=utf-8"), "/app.js": (HERE / "dashboard/app.js", "text/javascript; charset=utf-8"), "/styles.css": (HERE / "dashboard/styles.css", "text/css; charset=utf-8"), "/avatar.png": (HERE / "dashboard/avatar.png", "image/png"), "/font.woff2": (ROOT / "kiosk-web/public/assets/fonts/PretendardVariable.woff2", "font/woff2")}
        item = files.get(url.path)
        if not item:
            return self.send(404, {"error": "not_found"})
        return self.send(200, item[0].read_bytes(), item[1])

    def do_POST(self):
        if not self.allowed() or self.headers.get("X-Voice-Token") != self.server.token:
            return self.send(403, {"error": "local_token_required"})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send(415, {"error": "json_required"})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 <= size <= 1024:
                raise ValueError()
            json.loads(self.rfile.read(size) or b"{}")
        except (ValueError, TypeError):
            return self.send(400, {"error": "bad_body"})
        if self.path == "/api/start":
            self.server.worker.start()
        elif self.path == "/api/stop":
            self.server.worker.stop()
        elif self.path == "/api/shutdown":
            self.server.worker.stop()
            self.send(200, {"stopping": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        else:
            return self.send(404, {"error": "not_found"})
        return self.send(200, {"running": self.server.worker.running()})


def main():
    parser = argparse.ArgumentParser(description="SWitch 음성 입력 웹 화면")
    parser.add_argument("--port", type=int, default=18733)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-start", action="store_true", help="수음기를 자동 시작하지 않음")
    parser.add_argument("--remote-config", type=Path, help="서버 수음 모드 설정 JSON (PC에서는 음성 추론하지 않음)")
    parser.add_argument("--stop", action="store_true", help="이 음성 화면과 수음기만 종료")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}/"
    if args.stop:
        with urllib.request.urlopen(url + "api/state", timeout=2) as response:
            state = json.load(response)
        if state.get("app") != APP_ID:
            raise SystemExit("SWitch 음성 화면을 찾을 수 없습니다.")
        request = urllib.request.Request(url + "api/shutdown", data=b"{}", headers={"Content-Type": "application/json", "X-Voice-Token": state["token"]})
        with urllib.request.urlopen(request, timeout=8):
            pass
        return
    command = [sys.executable, "-u", str(HERE / "voice_relay.py"), "--config", str(args.remote_config.resolve())] if args.remote_config else None
    try:
        server = LabServer(("127.0.0.1", args.port), command=command)
    except OSError:
        try:
            with urllib.request.urlopen(url + "api/state", timeout=2) as response:
                if json.load(response).get("app") != APP_ID:
                    raise RuntimeError("다른 프로그램이 포트를 사용하고 있습니다.")
        except Exception:
            raise SystemExit("웹 포트를 사용할 수 없습니다. --port로 다른 포트를 지정해 주세요.")
        if not args.no_browser:
            webbrowser.open(url)
        print("기존 음성 화면을 사용합니다:", url, flush=True)
        return
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    if not args.no_start:
        server.worker.start()
    if not args.no_browser:
        webbrowser.open(url)
    print("SWitch 음성 화면:", url, " / 종료: Ctrl+C", flush=True)
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.closed.set()
        with server.hub.condition:
            server.hub.condition.notify_all()
        server.worker.stop()
        server.server_close()


if __name__ == "__main__":
    main()
