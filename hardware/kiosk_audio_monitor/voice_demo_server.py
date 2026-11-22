"""Separate, invitation-protected web demo and native helper download.

The browser uses Web Serial, posting raw USB bytes to this same-origin proxy.
The upstream device credential never appears in HTML/JS or browser storage.
"""

import argparse
import base64
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import select
import socket
import threading
import time
from urllib.parse import urlsplit, parse_qs

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


class DemoServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, *, access, device_token, package, public_url, upstream=18734, stream_port=18736):
        if min(len(access), len(device_token)) < 32:
            raise ValueError("Separate demo invitation and device credentials are required")
        self.access, self.device_token = access, device_token
        self.package, self.public_url, self.upstream = Path(package), public_url.rstrip("/"), upstream
        self.stream_port = stream_port
        self.cookie_name = "switch_voice_" + hashlib.sha256(public_url.encode()).hexdigest()[:10]
        self.bad_auth = {}
        self.auth_lock = threading.Lock()
        super().__init__(address, Handler)

    def signature(self, purpose, value):
        return hmac.new(self.access.encode(), (purpose + ":" + value).encode(), hashlib.sha256).hexdigest()

    def handle_error(self, *_):
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass

    def write_headers(self, status, content_type, size=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", 'serial=(self), microphone=(), camera=()')
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
        if size is not None:
            self.send_header("Content-Length", str(size))

    def send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.write_headers(status, "application/json; charset=utf-8", len(body))
        self.end_headers()
        self.wfile.write(body)

    def authenticated(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            value = cookie[self.server.cookie_name].value
            expiry, signature = value.split(".", 1)
            return int(expiry) > time.time() and hmac.compare_digest(signature, self.server.signature("cookie", expiry))
        except (KeyError, ValueError):
            return False

    def same_origin(self):
        origin = self.headers.get("Origin")
        public = urlsplit(self.server.public_url)
        allowed = {f"{public.scheme}://{public.netloc}"}
        if public.hostname in {"127.0.0.1", "localhost"}:
            allowed.add(f"http://127.0.0.1:{self.server.server_port}")
        return origin is None or origin in allowed

    def body(self, maximum=32768):
        size = int(self.headers.get("Content-Length", "-1"))
        if not 0 <= size <= maximum:
            raise ValueError("Invalid body size")
        data = self.rfile.read(size)
        if len(data) != size:
            raise ValueError("Incomplete body")
        return data

    def do_POST(self):
        if not self.same_origin():
            self.close_connection = True
            return self.send(403, {"error": "same_origin_required"})
        try:
            body = self.body(256 if self.path == "/api/auth" else 32768)
        except (ValueError, OSError):
            self.close_connection = True
            return self.send(400, {"error": "invalid_body"})
        if self.path == "/api/auth":
            # One owner, one test device. Rate limit incorrect invitations.
            with self.server.auth_lock:
                now = time.monotonic()
                failures = self.server.bad_auth.setdefault("recent", [])
                failures[:] = [t for t in failures if now - t < 60]
                if len(failures) >= 10:
                    return self.send(429, {"error": "try_later"})
                try:
                    access = json.loads(body).get("access", "")
                except (ValueError, AttributeError):
                    access = ""
                if not isinstance(access, str) or not hmac.compare_digest(access, self.server.access):
                    failures.append(now)
                    return self.send(401, {"error": "invitation_required"})
            expiry = str(int(time.time() + 86400))
            cookie = f"{self.server.cookie_name}={expiry}.{self.server.signature('cookie', expiry)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400"
            if self.server.public_url.startswith("https:"):
                cookie += "; Secure"
            self.write_headers(200, "application/json", 22)
            self.send_header("Set-Cookie", cookie)
            self.end_headers()
            self.wfile.write(b'{"authenticated":true}')
            return
        return self.proxy("POST", body)

    def do_DELETE(self):
        if not self.same_origin():
            return self.send(403, {"error": "same_origin_required"})
        self.proxy("DELETE")

    def proxy(self, method, body=None):
        if not self.authenticated():
            return self.send(401, {"error": "invitation_required"})
        path = urlsplit(self.path).path
        # A private demo proxy, never an arbitrary URL or local-service tunnel.
        if not path.startswith("/api/voice/") or len(path) > 180 or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_-" for c in path):
            return self.send(404, {"error": "not_found"})
        upstream_path = "/voice-api/" + path.removeprefix("/api/voice/")
        upstream = http.client.HTTPConnection("127.0.0.1", self.server.upstream, timeout=12)
        try:
            headers = {"Authorization": "Bearer " + self.server.device_token}
            for key in ["Content-Type", "X-Audio-Sequence"]:
                if self.headers.get(key):
                    headers[key] = self.headers[key]
            upstream.request(method, upstream_path, body, headers)
            response = upstream.getresponse()
            streaming = response.status == 200 and path.endswith("/events")
            if streaming:
                self.write_headers(200, "application/x-ndjson; charset=utf-8")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                for line in response:
                    self.wfile.write(line)
                    self.wfile.flush()
            else:
                data = response.read(65536)
                self.write_headers(response.status, "application/json; charset=utf-8", len(data))
                self.end_headers()
                self.wfile.write(data)
        except (OSError, http.client.HTTPException):
            self.close_connection = True
        finally:
            upstream.close()

    def download_ticket_valid(self, query):
        try:
            value = parse_qs(query)["ticket"][0]
            expiry, signature = value.split(".", 1)
            return time.time() < int(expiry) <= time.time() + 601 and hmac.compare_digest(signature, self.server.signature("download", expiry))
        except (KeyError, ValueError):
            return False

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path == "/api/voice/stream":
            return self.stream_proxy()
        if url.path == "/api/state":
            return self.send(200, {"authenticated": self.authenticated(), "app": "switch-voice-web-demo-v1"})
        if url.path.startswith("/api/voice/"):
            return self.proxy("GET")
        if url.path == "/download/installer.cmd":
            if not self.authenticated():
                return self.send(401, {"error": "invitation_required"})
            expiry = str(int(time.time() + 600))
            package_url = self.server.public_url + "/download/package.zip?ticket=" + expiry + "." + self.server.signature("download", expiry)
            digest = hashlib.sha256(self.server.package.read_bytes()).hexdigest()
            # A per-user helper install, no elevation or driver replacement.
            script = "$ErrorActionPreference='Stop'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; "
            script += "$dest=Join-Path $env:LOCALAPPDATA 'SWitchVoice'; New-Item -ItemType Directory -Force $dest|Out-Null; $zip=Join-Path $dest 'voice.zip'; "
            script += "Invoke-WebRequest -UseBasicParsing -Uri '" + package_url + "' -OutFile $zip; "
            script += "if((Get-FileHash $zip -Algorithm SHA256).Hash -ne '" + digest + "'){throw 'Download checksum mismatch'}; "
            script += "Expand-Archive -Force $zip $dest; Remove-Item $zip; $app=Join-Path $dest 'SWitch-Voice-ThinClient'; $python=Join-Path $app 'runtime\\python.exe'; $main=Join-Path $app 'hardware\\kiosk_audio_monitor\\voice_dashboard.py'; $config=Join-Path $app '연결설정.json'; "
            script += "$launchArgs='\"'+$main+'\" --remote-config \"'+$config+'\"'; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SWitch Voice.lnk')); $link.TargetPath=$python; $link.Arguments=$launchArgs; $link.WorkingDirectory=$app; $link.WindowStyle=7; $link.Save(); Start-Process -FilePath $python -ArgumentList $launchArgs -WorkingDirectory $app -WindowStyle Minimized"
            encoded = base64.b64encode(script.encode("utf-16le")).decode()
            body = ("@echo off\r\necho Installing SWitch Voice connection helper...\r\npowershell.exe -NoProfile -EncodedCommand " + encoded + "\r\nif errorlevel 1 pause\r\n").encode("ascii")
            self.write_headers(200, "application/octet-stream", len(body))
            self.send_header("Content-Disposition", 'attachment; filename="SWitch-Voice-Setup.cmd"')
            self.end_headers()
            return self.wfile.write(body)
        if url.path == "/download/package.zip":
            if not self.authenticated() and not self.download_ticket_valid(url.query):
                return self.send(401, {"error": "invitation_required"})
            self.write_headers(200, "application/zip", self.server.package.stat().st_size)
            self.send_header("Content-Disposition", 'attachment; filename="SWitch-Voice-ThinClient.zip"')
            self.end_headers()
            with self.server.package.open("rb") as source:
                while data := source.read(65536):
                    self.wfile.write(data)
            return
        files = {"/debug_view.js": (HERE / "web_demo/debug_view.js", "text/javascript; charset=utf-8"), "/": (HERE / "web_demo/index.html", "text/html; charset=utf-8"), "/app.js": (HERE / "web_demo/app.js", "text/javascript; charset=utf-8"), "/audio_stream.js": (HERE / "web_demo/audio_stream.js", "text/javascript; charset=utf-8"), "/styles.css": (HERE / "web_demo/styles.css", "text/css; charset=utf-8"), "/avatar.png": (HERE / "dashboard/avatar.png", "image/png"), "/font.woff2": (ROOT / "kiosk-web/public/assets/fonts/PretendardVariable.woff2", "font/woff2")}
        item = files.get(url.path)
        if not item:
            return self.send(404, {"error": "not_found"})
        data = item[0].read_bytes()
        self.write_headers(200, item[1], len(data))
        self.end_headers()
        self.wfile.write(data)

    def stream_proxy(self):
        if not self.authenticated() or not self.same_origin():
            return self.send(403, {"error": "invitation_required"})
        if self.headers.get("Upgrade", "").lower() != "websocket" or not self.headers.get("Sec-WebSocket-Key"):
            return self.send(400, {"error": "websocket_required"})
        self.close_connection = True
        upstream = None
        try:
            upstream = socket.create_connection(("127.0.0.1", self.server.stream_port), timeout=10)
            upstream.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            request = "GET /voice-api/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + self.headers["Sec-WebSocket-Key"] + "\r\nAuthorization: Bearer " + self.server.device_token + "\r\n\r\n"
            upstream.sendall(request.encode("ascii"))
            data = bytearray()
            while b"\r\n\r\n" not in data and len(data) < 16384:
                chunk = upstream.recv(4096)
                if not chunk:
                    raise OSError("Upstream handshake closed")
                data.extend(chunk)
            if not data.startswith(b"HTTP/1.1 101 "):
                return self.send(502, {"error": "stream_unavailable"})
            self.wfile.write(data)
            self.wfile.flush()
            # Forward frames without interpreting their content. Protocol,
            # ping/pong, masking and limits are handled by websockets upstream.
            self.connection.settimeout(15)
            upstream.settimeout(15)
            while True:
                readable, _, _ = select.select([self.connection, upstream], [], [], 1)
                for source in readable:
                    chunk = source.recv(65536)
                    if not chunk:
                        return
                    (upstream if source is self.connection else self.connection).sendall(chunk)
        except OSError:
            pass
        finally:
            if upstream:
                upstream.close()


def main():
    import signal
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=18735)
    parser.add_argument("--package", type=Path, required=True)
    args = parser.parse_args()
    server = DemoServer(("127.0.0.1", args.port), access=os.environ["VOICE_DEMO_ACCESS"], device_token=os.environ["VOICE_REMOTE_TOKEN"], package=args.package, public_url=os.environ["VOICE_DEMO_URL"])
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
