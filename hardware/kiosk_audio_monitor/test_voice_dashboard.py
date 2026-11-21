import json
from pathlib import Path
import subprocess
import sys
import threading
import unittest
import urllib.error
import urllib.request

from voice_dashboard import EventHub, LabServer, Worker


class FakeWorker:
    def __init__(self, hub):
        self.active = False
        self.hub = hub

    def running(self):
        return self.active

    def start(self):
        self.active = True
        self.hub.publish({"event": "ready", "message": "QA fixture"})

    def stop(self):
        self.active = False
        self.hub.publish({"event": "stopped", "message": "QA fixture stopped"})


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.server = LabServer(("127.0.0.1", 0))
        self.server.worker = FakeWorker(self.server.hub)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.closed.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, path, *, headers=None, post=False):
        return urllib.request.urlopen(urllib.request.Request(self.base + path, headers=headers or {}, data=b"{}" if post else None), timeout=3)

    def test_control_requires_origin_and_token_and_never_exposes_task_files(self):
        with self.request("/api/state") as response:
            state = json.load(response)
        self.assertEqual(state["app"], "switch-voice-lab-v1")
        for path, headers, post in [("/api/start", {"Content-Type": "application/json"}, True), ("/api/state", {"Origin": "https://other.example"}, False), ("/api/state", {"Host": "other.example"}, False)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path, headers=headers, post=post)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/order-agent/.env")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
        headers = {"X-Voice-Token": state["token"], "Content-Type": "application/json"}
        with self.request("/api/start", headers=headers, post=True) as response:
            self.assertTrue(json.load(response)["running"])
        with self.request("/api/stop", headers=headers, post=True) as response:
            self.assertFalse(json.load(response)["running"])

    def test_history_only_contains_accepted_turns_and_sse_replays_by_cursor(self):
        self.server.hub.publish({"event": "transcript", "text": "후보"})
        self.server.hub.publish({"event": "turn.ignore", "text": "의논"})
        final = self.server.hub.publish({"event": "turn.accept", "text": "아메리카노 주세요"})
        snapshot = self.server.snapshot()
        self.assertEqual([r["text"] for r in snapshot["accepted"]], ["아메리카노 주세요"])
        with self.request("/api/events?after=2") as response:
            self.assertEqual(response.readline().decode().strip(), f"id: {final['id']}")
            data = json.loads(response.readline().decode().removeprefix("data: "))
            self.assertEqual(data["text"], "아메리카노 주세요")

    def test_worker_start_is_idempotent_and_stop_only_ends_owned_process(self):
        hub = EventHub()
        command = [sys.executable, "-u", "-c", "import json,time;print(json.dumps({'event':'ready'}),flush=True);time.sleep(30)"]
        worker = Worker(hub, command)
        try:
            worker.start()
            pid = worker.process.pid
            worker.start()
            self.assertEqual(worker.process.pid, pid)
            with hub.condition:
                hub.condition.wait_for(lambda: any(r.get("event") == "ready" for r in hub.events), timeout=3)
            self.assertTrue(any(r.get("event") == "ready" for r in hub.events))
            worker.stop()
            self.assertIsNotNone(worker.process.poll())
        finally:
            worker.stop()


def fixture():
    """Browser test fixture: stdin events, ephemeral port, no microphone/API."""
    server = LabServer(("127.0.0.1", 0))
    server.worker = FakeWorker(server.hub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(json.dumps({"base": f"http://127.0.0.1:{server.server_port}"}), flush=True)
    try:
        for line in sys.stdin:
            if line.strip() == "stop":
                break
            server.hub.publish(json.loads(line))
    finally:
        server.closed.set()
        with server.hub.condition:
            server.hub.condition.notify_all()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    if "--fixture" in sys.argv:
        fixture()
    else:
        unittest.main()
