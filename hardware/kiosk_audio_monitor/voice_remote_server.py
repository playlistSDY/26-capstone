"""Authenticated PCM sidecar. All speech processing stays in owned workers.

Bind to loopback behind an HTTPS proxy; never expose an unprotected endpoint.
The test service deliberately admits only one live microphone at a time.
"""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import secrets
import subprocess
import sys
import threading
import time

from voice_dashboard import EventHub

HERE = Path(__file__).resolve().parent


class Session:
    def __init__(self, command):
        self.id = secrets.token_urlsafe(24)
        self.hub = EventHub()
        self.closed = threading.Event()
        self.ready = threading.Event()
        self.queue = queue.Queue(maxsize=4)
        self.upload_lock = threading.Lock()
        self.last_upload = time.monotonic()
        self.last_sequence = -1
        self.child = subprocess.Popen(command, cwd=HERE, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}, bufsize=0)
        threading.Thread(target=self.read, daemon=True).start()
        threading.Thread(target=self.write, daemon=True).start()
        threading.Thread(target=self.watch, daemon=True).start()

    def read(self):
        try:
            for line in self.child.stdout:
                try:
                    row = json.loads(line)
                    if not isinstance(row, dict) or not isinstance(row.get("event"), str):
                        continue
                except (ValueError, TypeError):
                    continue  # Do not expose tracebacks, paths or environment.
                if self.closed.is_set():
                    break
                self.hub.publish(row)
                if row["event"] == "started":
                    self.ready.set()
        finally:
            self.child.stdout.close()
            self.close()

    def write(self):
        try:
            while not self.closed.is_set():
                try:
                    data = self.queue.get(timeout=.1)
                except queue.Empty:
                    continue
                remaining = memoryview(data)
                while remaining:
                    written = self.child.stdin.write(remaining)
                    if not written:
                        raise OSError("Audio pipe closed")
                    remaining = remaining[written:]
                self.child.stdin.flush()
        except (OSError, ValueError):
            self.close()
        finally:
            self.child.stdin.close()

    def upload(self, sequence, data, *, wait=0):
        with self.upload_lock:
            if self.closed.is_set() or sequence != self.last_sequence + 1:
                self.close()
                return False
            try:
                self.queue.put(data, timeout=wait)
            except queue.Full:
                self.close()  # Discard this turn instead of building old audio.
                return False
            self.last_sequence = sequence
            self.last_upload = time.monotonic()
            return True

    def watch(self):
        while not self.closed.wait(.5):
            if time.monotonic() - self.last_upload > 6:
                self.close()

    def close(self):
        if self.closed.is_set():
            return
        self.closed.set()
        self.hub.publish({"event": "remote.closed", "message": "서버 음성 연결이 종료됐어요. 다시 시작해 주세요."})
        if self.child.poll() is None:
            try:
                self.child.terminate()
                self.child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=2)
            except ProcessLookupError:
                pass
        self.ready.set()


class VoiceServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, token, command=None):
        if len(token) < 32:
            raise ValueError("VOICE_REMOTE_TOKEN must contain at least 32 characters")
        self.token = token
        self.session = None
        self.lock = threading.Lock()
        self.command = command or [sys.executable, "-u", str(HERE / "serial_stt.py"), "--pcm-stdin", "--json-events"]
        self.stream_server = None
        super().__init__(address, Handler)

    def start_stream(self, port=18736):
        from websockets.sync.server import serve

        def authorize(connection, request):
            if request.path != "/voice-api/stream" or not hmac.compare_digest(request.headers.get("Authorization", ""), "Bearer " + self.token):
                return connection.respond(401, "Device token required\n")

        self.stream_server = serve(self.stream, "127.0.0.1", port, process_request=authorize, compression=None, max_size=32768, max_queue=8, ping_interval=5, ping_timeout=15, close_timeout=1)
        threading.Thread(target=self.stream_server.serve_forever, daemon=True).start()
        return self.stream_server.socket.getsockname()[1]

    def stream(self, websocket):
        from websockets.exceptions import ConnectionClosed
        with self.lock:
            if self.session and not self.session.closed.is_set():
                websocket.send(json.dumps({"event": "stream.error", "reason": "busy", "message": "다른 수음기가 사용 중이에요. 기존 테스트를 먼저 중지해 주세요."}))
                websocket.close(1013, "Microphone in use")
                return
            session = self.session = Session(self.command)
        sender = None
        try:
            if not session.ready.wait(8) or session.closed.is_set():
                websocket.close(1011, "Speech worker unavailable")
                return
            websocket.send(json.dumps({"event": "stream.ready", "session": session.id, "processing": "server"}))

            def send_events():
                cursor = 0
                try:
                    while not session.closed.is_set():
                        for row in session.hub.since(cursor):
                            websocket.send(json.dumps(row, ensure_ascii=False))
                            cursor = row["id"]
                        with session.hub.condition:
                            if session.hub.sequence <= cursor:
                                session.hub.condition.wait(timeout=.2)
                except ConnectionClosed:
                    pass
                finally:
                    websocket.close(1012, "Session ended")

            sender = threading.Thread(target=send_events, daemon=True)
            sender.start()
            sequence = 0
            while not session.closed.is_set():
                try:
                    data = websocket.recv(timeout=.5)
                except TimeoutError:
                    continue
                if not isinstance(data, bytes) or not data or not session.upload(sequence, data, wait=.25):
                    websocket.close(1013, "Audio stream overloaded")
                    break
                sequence += 1
        except ConnectionClosed:
            pass
        finally:
            session.close()
            if sender:
                sender.join(timeout=2)

    def server_close(self):
        if self.stream_server:
            self.stream_server.shutdown()
        if self.session:
            self.session.close()
        super().server_close()

    def handle_error(self, request, client_address):
        pass  # Ordinary client disconnects; no conversation or keys in logs.


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_):
        pass

    def send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
            self.close_connection = True
            self.send(401, {"error": "device_token_required"})
            return False
        return True

    def find_session(self, suffix):
        session = self.server.session
        if session and self.path == "/voice-api/session/" + session.id + suffix and not session.closed.is_set():
            return session
        self.send(410, {"error": "session_closed"})
        return None

    def do_POST(self):
        if not self.authorized():
            return
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            if not 0 <= size <= 32768:
                raise ValueError()
            data = self.rfile.read(size)
            if len(data) != size:
                raise ValueError()
        except (ValueError, OSError):
            self.close_connection = True
            return self.send(400, {"error": "bad_audio_body"})
        if self.path == "/voice-api/session":
            if data not in (b"", b"{}"):
                return self.send(400, {"error": "empty_body_required"})
            with self.server.lock:
                if self.server.session and not self.server.session.closed.is_set():
                    return self.send(409, {"error": "microphone_in_use"})
                session = self.server.session = Session(self.server.command)
            if not session.ready.wait(8) or session.closed.is_set():
                session.close()
                return self.send(503, {"error": "speech_worker_unavailable"})
            return self.send(201, {"session": session.id, "processing": "server", "format": "SWPCM01"})
        session = self.find_session("/audio")
        if not session:
            return
        try:
            sequence = int(self.headers.get("X-Audio-Sequence", "-1"))
        except ValueError:
            sequence = -1
        if not data or self.headers.get("Content-Type") != "application/octet-stream" or not session.upload(sequence, data):
            session.close()
            return self.send(409, {"error": "audio_stream_interrupted"})
        self.send(200, {"received": sequence})

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == "/voice-api/health":
            return self.send(200, {"app": "switch-voice-server-v1", "processing": "server"})
        session = self.find_session("/events")
        if not session:
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        cursor = 0
        try:
            while not session.closed.is_set():
                rows = session.hub.since(cursor)
                if rows:
                    for row in rows:
                        self.wfile.write(json.dumps(row, ensure_ascii=False).encode("utf-8") + b"\n")
                        cursor = row["id"]
                else:
                    self.wfile.write(b"\n")
                self.wfile.flush()
                with session.hub.condition:
                    if session.hub.sequence <= cursor:
                        session.hub.condition.wait(timeout=1)
        except OSError:
            pass
        finally:
            session.close()  # Browser/relay loss cannot leave inference running.

    def do_DELETE(self):
        if not self.authorized():
            return
        session = self.server.session
        if session and self.path == "/voice-api/session/" + session.id:
            session.close()
            return self.send(200, {"closed": True})
        self.send(410, {"error": "session_closed"})


def main():
    import signal
    parser = argparse.ArgumentParser(description="SWitch 서버 음성 처리기")
    parser.add_argument("--port", type=int, default=18734)
    parser.add_argument("--stream-port", type=int, default=18736)
    args = parser.parse_args()
    server = VoiceServer(("127.0.0.1", args.port), os.environ.get("VOICE_REMOTE_TOKEN", ""))
    server.start_stream(args.stream_port)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
