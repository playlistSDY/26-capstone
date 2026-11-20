import asyncio
from dataclasses import asdict
import json
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

from switch_agent.domain import OrderStore, Options, OrderError
from switch_agent.web import Bridge, handler_for, sync_cart


def cart():
    return {"lines": [], "place": "store", "screen": "menu"}


class FakeConversation:
    def __init__(self):
        self.store = OrderStore.demo()
        self.calls = 0

    async def reply(self, text, emit, defer_delivery):
        self.calls += 1
        self.store.begin_turn(text)
        self.store.add("latte", 1, Options(temperature="hot"))
        emit({"type": "text.delta", "text": "따뜻한 라떼 "})
        await asyncio.sleep(10 if text == "slow" else 0.01)
        emit({"type": "text.delta", "text": "담았어요."})
        return {"text": "따뜻한 라떼 담았어요.", "state": self.store.snapshot()}


class FakeSpeaker:
    def __init__(self): self.calls = 0
    async def warmup(self): pass
    async def disconnect(self): pass
    async def stream(self, text, emit):
        self.calls += 1
        emit({"type": "audio.delta", "pcm": "AAAAAA==", "sample_rate": 24000})
        await asyncio.sleep(0.01)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.bridge = Bridge(FakeConversation, FakeSpeaker)
        self.session = self.bridge.submit(self.bridge.create())["session_id"]

    def tearDown(self):
        self.bridge.close()

    def start(self, request_id="turn-1", text="라떼"):
        payload = {"request_id": request_id, "text": text, "cart": cart()}
        self.bridge.submit(self.bridge.turn(self.session, payload))
        return payload

    def finish(self):
        async def wait():
            record = self.bridge.sessions[self.session]["turns"]["turn-1"]
            await record["task"]
        self.bridge.submit(wait())

    def test_duplicate_request_replays_events_without_duplicate_mutation(self):
        payload = self.start()
        self.finish()
        self.bridge.submit(self.bridge.turn(self.session, payload))
        conversation = self.bridge.sessions[self.session]["conversation"]
        self.assertEqual(conversation.calls, 1)
        events = self.bridge.submit(self.bridge.events(self.session, "turn-1", 1))
        self.assertEqual([event["type"] for event in events["events"]], ["text.delta", "final"])
        self.assertTrue(events["done"])

    def test_interrupt_preserves_completed_mutation_and_stops_deltas(self):
        self.start(text="slow")
        result = self.bridge.submit(self.bridge.interrupt(self.session))
        self.assertEqual(len(result["state"]["lines"]), 1)
        events = self.bridge.submit(self.bridge.events(self.session, "turn-1", 0))["events"]
        self.assertEqual([event["type"] for event in events], ["text.delta", "interrupted"])
        self.assertIsNone(self.bridge.sessions[self.session]["conversation"].store.pending)

    def test_reused_id_with_changed_body_is_rejected(self):
        payload = self.start(); self.finish()
        payload["text"] = "다른 요청"
        self.assertFalse(self.bridge.submit(self.bridge.turn(self.session, payload))["ok"])

    def test_invalid_import_does_not_replace_kiosk_cart_with_old_state(self):
        payload = {"request_id": "turn-1", "text": "안녕", "cart": {"lines": [], "place": "bad", "screen": "menu"}}
        self.bridge.submit(self.bridge.turn(self.session, payload)); self.finish()
        event = self.bridge.submit(self.bridge.events(self.session, "turn-1", 0))["events"][-1]
        self.assertNotIn("state", event)
        self.assertEqual(event["type"], "error")

    def test_sync_same_cart_keeps_confirmation_but_touch_change_invalidates(self):
        s = OrderStore.demo()
        s.set_place("store"); s.add("latte", 1, Options(temperature="hot"))
        s.request_confirmation()
        original = {"screen": "menu", "place": "store", "lines": [{"id": s.lines[0].id, "productId": "latte", "quantity": 1, "options": asdict(s.lines[0].options)}]}
        sync_cart(s, original)
        self.assertIsNotNone(s.pending)
        original["lines"][0]["quantity"] = 2
        sync_cart(s, original)
        self.assertIsNone(s.pending)

    def test_tts_reads_only_emitted_text_and_caches_repeated_audio_request(self):
        self.start(); self.finish()
        first = self.bridge.submit(self.bridge.speech(self.session, "turn-1", "따뜻한 라떼"))
        second = self.bridge.submit(self.bridge.speech(self.session, "turn-1", "따뜻한 라떼"))
        async def finish_audio(): await first["task"]
        self.bridge.submit(finish_audio())
        self.assertIs(first, second)
        self.assertEqual(self.bridge.sessions[self.session]["speaker"].calls, 1)
        self.assertEqual([e["type"] for e in first["events"]], ["audio.delta", "audio.done"])
        with self.assertRaises(OrderError): self.bridge.submit(self.bridge.speech(self.session, "turn-1", "임의의 다른 문장"))

    def test_interrupt_after_generation_blocks_late_tts_and_delivery(self):
        self.start(); self.finish()
        self.bridge.submit(self.bridge.interrupt(self.session))
        with self.assertRaises(OrderError): self.bridge.submit(self.bridge.speech(self.session, "turn-1", "따뜻한 라떼"))
        with self.assertRaises(OrderError): self.bridge.submit(self.bridge.delivered(self.session, "turn-1"))

    def test_http_stream_and_origin_token_checks(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.bridge))
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            payload = {"request_id": "turn-1", "text": "라떼", "cart": cart()}
            url = base + f"/agent-api/sessions/{self.session}/turns"
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}))
            denied.exception.close()
            request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "X-Switch-Agent-Token": self.bridge.token})
            with urllib.request.urlopen(request) as response: self.assertTrue(json.load(response)["ok"])
            request = urllib.request.Request(url + "/turn-1/events?after=0", headers={"X-Switch-Agent-Token": self.bridge.token})
            with urllib.request.urlopen(request) as response: events = [json.loads(line) for line in response]
            self.assertEqual([event["type"] for event in events], ["text.delta", "text.delta", "final"])
            request = urllib.request.Request(base + "/agent-api/status", headers={"Origin": "https://example.com"})
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(request)
            denied.exception.close()
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == "__main__": unittest.main()
