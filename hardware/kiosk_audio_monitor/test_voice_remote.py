import http.client
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from voice_relay import configuration
from voice_remote_server import VoiceServer


TOKEN = "fixture-device-token-" * 3
FAKE_WORKER = """
import json, os, sys
print(json.dumps({'event':'started', 'message':'fixture'}), flush=True)
while True:
    data = os.read(sys.stdin.fileno(), 8192)
    if not data: break
    print(json.dumps({'event':'turn.accept', 'text':'아이스 라떼', 'bytes':len(data)}, ensure_ascii=False), flush=True)
"""


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.server = VoiceServer(("127.0.0.1", 0), TOKEN, [sys.executable, "-u", "-c", FAKE_WORKER])
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.client = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        self.headers = {"Authorization": "Bearer " + TOKEN}

    def tearDown(self):
        self.client.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, method, path, body=b"", headers=None):
        self.client.request(method, "/voice-api" + path, body, self.headers if headers is None else headers)
        response = self.client.getresponse()
        return response.status, json.loads(response.read())

    def test_unauthenticated_cannot_start_billable_work(self):
        self.assertEqual(self.call("POST", "/session", headers={})[0], 401)
        self.assertIsNone(self.server.session)

    def test_stream_delivers_unicode_and_closes_owned_worker(self):
        status, state = self.call("POST", "/session", b"{}")
        self.assertEqual(status, 201)
        path = "/session/" + state["session"]
        self.assertEqual(self.call("POST", "/session", b"{}")[0], 409)
        events = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        events.request("GET", "/voice-api" + path + "/events", headers=self.headers)
        stream = events.getresponse()
        self.assertEqual(stream.status, 200)
        self.assertEqual(json.loads(stream.readline())["event"], "started")
        status, state = self.call("POST", path + "/audio", b"\x00\x01" * 2048, {**self.headers, "Content-Type": "application/octet-stream", "X-Audio-Sequence": "0"})
        self.assertEqual(status, 200)
        row = json.loads(stream.readline())
        self.assertEqual(row["text"], "아이스 라떼")
        self.assertEqual(row["bytes"], 4096)
        self.assertEqual(self.call("DELETE", path)[0], 200)
        self.assertIsNotNone(self.server.session.child.poll())
        self.assertEqual(self.call("POST", path + "/audio", b"x")[0], 410)
        events.close()

    def test_duplicate_or_missing_audio_sequence_discards_session(self):
        _, state = self.call("POST", "/session", b"{}")
        path = "/session/" + state["session"] + "/audio"
        headers = {**self.headers, "Content-Type": "application/octet-stream", "X-Audio-Sequence": "1"}
        self.assertEqual(self.call("POST", path, b"x", headers)[0], 409)
        self.assertTrue(self.server.session.closed.is_set())
        self.assertIsNotNone(self.server.session.child.poll())

    def test_idle_device_releases_exclusive_session(self):
        self.call("POST", "/session", b"{}")
        self.server.session.last_upload = time.monotonic() - 7
        self.assertTrue(self.server.session.closed.wait(2))
        _, state = self.call("POST", "/session", b"{}")
        self.assertIn("session", state)

    def test_tls_required_except_loopback_and_config_does_not_load_env(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.json"
            for url in ["http://example.com/voice-api", "https://user:pass@example.com/voice-api", "https://example.com/?token=x"]:
                path.write_text(json.dumps({"server_url": url, "device_token": TOKEN}))
                with self.assertRaises(ValueError):
                    configuration(path)
            path.write_text(json.dumps({"server_url": "http://127.0.0.1:18734/voice-api", "device_token": TOKEN}))
            self.assertEqual(configuration(path)[1].hostname, "127.0.0.1")

    @unittest.skipUnless(os.name == "posix", "PTY fixture requires POSIX")
    def test_real_thin_relay_uses_serial_and_cooperative_stop(self):
        import pty
        master, slave = pty.openpty()
        process = None
        try:
            with tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / "config.json"
                config.write_text(json.dumps({"server_url": f"http://127.0.0.1:{self.server.server_port}/voice-api", "device_token": TOKEN, "serial_port": os.ttyname(slave)}))
                # PTYs have neither modem pins nor macOS USB speed ioctls.
                # Keep real pySerial reads, exclusivity and input buffering.
                wrapper = "import runpy,serial;serial.Serial._update_dtr_state=lambda self:None;serial.Serial._update_rts_state=lambda self:None;serial.Serial._set_special_baudrate=lambda self,*args:None;runpy.run_path(" + repr(str(Path(__file__).with_name("voice_relay.py"))) + ",run_name='__main__')"
                process = subprocess.Popen([sys.executable, "-u", "-c", wrapper, "--config", str(config)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")
                connected = False
                for _ in range(5):
                    line = process.stdout.readline()
                    self.assertTrue(line, "Relay exited before connection")
                    row = json.loads(line)
                    if row["event"] == "remote.connected":
                        connected = True
                        break
                self.assertTrue(connected)
                os.write(master, b"fixture-usb-audio" * 256)
                while True:
                    row = json.loads(process.stdout.readline())
                    if row["event"] == "turn.accept":
                        break
                self.assertEqual(row["text"], "아이스 라떼")
                self.assertEqual(row["processing"], "server")
                process.stdin.write("stop\n")
                process.stdin.flush()
                output, errors = process.communicate(timeout=5)
                self.assertEqual(process.returncode, 0, errors)
                self.assertTrue(self.server.session.closed.is_set())
                self.assertIsNotNone(self.server.session.child.poll())
        finally:
            if process and process.poll() is None:
                process.kill()
                process.communicate(timeout=2)
            if process:
                for pipe in [process.stdin, process.stdout, process.stderr]:
                    pipe.close()
            os.close(master)
            os.close(slave)


if __name__ == "__main__":
    unittest.main()
