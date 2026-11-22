import base64
import http.client
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest

from voice_demo_server import DemoServer
from voice_remote_server import VoiceServer
from test_voice_remote import FAKE_WORKER, TOKEN
import sys


ACCESS = "fixture-invitation-" * 3


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.package = Path(self.folder.name) / "test.zip"
        self.package.write_bytes(b"fixture-package")
        self.upstream = VoiceServer(("127.0.0.1", 0), TOKEN, [sys.executable, "-u", "-c", FAKE_WORKER])
        stream_port = self.upstream.start_stream(0)
        self.server = DemoServer(("127.0.0.1", 0), access=ACCESS, device_token=TOKEN, package=self.package, public_url="http://127.0.0.1", upstream=self.upstream.server_port, stream_port=stream_port)
        self.threads = []
        for server in [self.server, self.upstream]:
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
            thread.start()
            self.threads.append(thread)
        self.client = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        self.cookie = ""

    def tearDown(self):
        self.client.close()
        for server in [self.server, self.upstream]:
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join(timeout=2)
        self.folder.cleanup()

    def call(self, method, path, body=None, headers=None):
        self.client.request(method, path, body, {"Cookie": self.cookie, **(headers or {})})
        response = self.client.getresponse()
        result = (response.status, dict(response.getheaders()), response.read())
        if response.getheader("Set-Cookie"):
            self.cookie = response.getheader("Set-Cookie").split(";", 1)[0]
        return result

    def authenticate(self):
        status, headers, body = self.call("POST", "/api/auth", json.dumps({"access": ACCESS}), {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["authenticated"])
        self.assertIn("HttpOnly", headers['Set-Cookie'])

    def test_invitation_required_for_audio_downloads_and_installer(self):
        for path in ["/api/voice/health", "/download/package.zip", "/download/installer.cmd"]:
            self.assertEqual(self.call("GET", path)[0], 401)
        self.assertIsNone(self.upstream.session)
        self.authenticate()
        self.assertTrue(json.loads(self.call("GET", "/api/state")[2])["authenticated"])
        self.assertEqual(self.call("GET", "/download/package.zip")[2], b"fixture-package")

    def test_installer_uses_expiring_download_with_integrity_check(self):
        self.authenticate()
        status, headers, body = self.call("GET", "/download/installer.cmd")
        self.assertEqual(status, 200)
        encoded = re.search(rb"-EncodedCommand ([A-Za-z0-9+/=]+)", body)[1]
        script = base64.b64decode(encoded).decode("utf-16le")
        self.assertIn("Get-FileHash", script)
        self.assertIn("LOCALAPPDATA", script)
        self.assertNotIn(TOKEN, script)
        self.assertNotIn("ExecutionPolicy", script)
        self.assertLess(len(body), 8191)
        ticket = re.search(r"package.zip\?ticket=([^']+)", script)[1]
        self.cookie = ""
        self.assertEqual(self.call("GET", "/download/package.zip?ticket=" + ticket)[0], 200)
        self.assertEqual(self.call("GET", "/download/package.zip?ticket=0.invalid")[0], 401)

    def test_same_origin_proxy_preserves_audio_sequence_and_closes_session(self):
        self.authenticate()
        status, _, data = self.call("POST", "/api/voice/session", b"{}", {"Content-Type": "application/json"})
        self.assertEqual(status, 201)
        session = json.loads(data)["session"]
        path = "/api/voice/session/" + session
        self.assertEqual(self.call("POST", path + "/audio", b"fixture", {"Content-Type": "application/octet-stream", "X-Audio-Sequence": "0"})[0], 200)
        self.assertEqual(self.call("DELETE", path)[0], 200)
        self.assertIsNotNone(self.upstream.session.child.poll())
        self.assertEqual(self.call("POST", "/api/auth", b"{}", {"Origin": "https://untrusted.example"})[0], 403)

    def test_static_assets_never_contain_private_credentials(self):
        for path in ["/", "/app.js", "/audio_stream.js", "/styles.css", "/avatar.png", "/font.woff2"]:
            status, headers, body = self.call("GET", path)
            self.assertEqual(status, 200)
            self.assertNotIn(TOKEN.encode(), body)
            self.assertNotIn(ACCESS.encode(), body)
            self.assertIn("serial=(self)", headers["Permissions-Policy"])
        self.assertEqual(self.call("GET", "/../../order-agent/.env")[0], 404)

    def test_websocket_proxy_requires_cookie_origin_and_streams_binary(self):
        from websockets.sync.client import connect
        from websockets.exceptions import InvalidStatus
        url = f"ws://127.0.0.1:{self.server.server_port}/api/voice/stream"
        with self.assertRaises(InvalidStatus):
            connect(url, proxy=None)
        self.authenticate()
        with self.assertRaises(InvalidStatus):
            connect(url, additional_headers={"Cookie": self.cookie}, origin="https://untrusted.example", proxy=None)
        with connect(url, additional_headers={"Cookie": self.cookie}, origin=f"http://127.0.0.1:{self.server.server_port}", proxy=None) as stream:
            ready = json.loads(stream.recv(timeout=3))
            self.assertEqual(ready["event"], "stream.ready")
            self.assertEqual(json.loads(stream.recv(timeout=3))["event"], "started")
            stream.send(b"fixture" * 512)
            accepted = json.loads(stream.recv(timeout=3))
            self.assertEqual(accepted["text"], "아이스 라떼")
            self.assertEqual(accepted["bytes"], 7 * 512)
        self.assertTrue(self.upstream.session.closed.wait(3))


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        fixture = DemoTests()
        fixture.setUp()
        print(json.dumps({"base": f"http://127.0.0.1:{fixture.server.server_port}/", "access": ACCESS}), flush=True)
        try:
            for line in sys.stdin:
                if line.strip() == "stop":
                    break
        finally:
            fixture.tearDown()
    else:
        unittest.main()
