import asyncio
from dataclasses import asdict
import json
import os
from unittest.mock import patch
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

    def test_payment_result_uses_ui_receipt_without_calling_model(self):
        c = self.bridge.sessions[self.session]["conversation"]
        c.store.add("latte", 1, Options(temperature="hot"))
        rows = [{"id": l.id, "productId": l.product_id, "quantity": l.quantity, "options": asdict(l.options)} for l in c.store.lines]
        payload = {"request_id":"turn-1", "text":"결제 결과", "payment_event":True,
                   "cart":{"screen":"completed", "place":"store", "lines":rows,
                           "receipt":{"id":"order1", "number":"009", "total":4700, "method":"card"}}}
        self.bridge.submit(self.bridge.turn(self.session,payload)); self.finish()
        event = self.bridge.submit(self.bridge.events(self.session,"turn-1",0))["events"][-1]
        self.assertTrue(event["session_complete"])
        self.assertIn("009번",event["text"])
        self.assertEqual(c.calls,0)

    def test_end_deletes_session_and_rejects_late_turn(self):
        self.bridge.submit(self.bridge.end(self.session))
        self.assertNotIn(self.session, self.bridge.sessions)
        result = self.bridge.submit(self.bridge.turn(self.session,{"request_id":"late", "text":"네", "cart":cart()}))
        self.assertEqual(result["code"], "SESSION_EXPIRED")

    def test_duplicate_request_replays_events_without_duplicate_mutation(self):
        payload = self.start()
        self.finish()
        self.bridge.submit(self.bridge.turn(self.session, payload))
        conversation = self.bridge.sessions[self.session]["conversation"]
        self.assertEqual(conversation.calls, 1)
        events = self.bridge.submit(self.bridge.events(self.session, "turn-1", 1))
        self.assertEqual([event["type"] for event in events["events"]], ["text.delta", "final"])
        self.assertTrue(events["done"])
        self.assertGreaterEqual(events["events"][-1]["timing"]["response_ms"],0)

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

    def test_expired_session_is_reported_without_replaying_order(self):
        result = self.bridge.submit(self.bridge.turn("expired-session", {"request_id": "retry", "text": "그래", "cart": cart()}))
        self.assertEqual(result["code"], "SESSION_EXPIRED")
        self.assertFalse(result["ok"])
        self.assertEqual(self.bridge.sessions[self.session]["conversation"].calls, 0)

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

    def test_new_turn_during_cancellation_does_not_break_interrupt(self):
        async def scenario():
            session = self.bridge.sessions[self.session]
            async def active():
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    session["turns"]["new-turn"] = {"task": asyncio.current_task(), "audio": {}, "interrupted": False}
                    raise
            task = asyncio.create_task(active())
            session["turns"]["old-turn"] = {"task": task, "audio": {}, "interrupted": False}
            await asyncio.sleep(0)
            result = await self.bridge.interrupt(self.session)
            self.assertTrue(result["ok"])
            self.assertIn("new-turn", session["turns"])
            self.assertFalse(session["turns"]["new-turn"]["interrupted"])
        self.bridge.submit(scenario())

    def test_interrupt_after_generation_blocks_late_tts_and_delivery(self):
        self.start(); self.finish()
        self.bridge.submit(self.bridge.interrupt(self.session))
        with self.assertRaises(OrderError): self.bridge.submit(self.bridge.speech(self.session, "turn-1", "따뜻한 라떼"))
        self.assertTrue(self.bridge.submit(self.bridge.delivered(self.session, "turn-1"))["ok"])

    def test_configured_proxy_origin_is_allowed_without_allowing_arbitrary_origins(self):
        server = ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.bridge))
        worker = threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        url = f"http://127.0.0.1:{server.server_port}/agent-api/status"
        try:
            with patch.dict(os.environ,{"SWITCH_ALLOWED_ORIGINS":"https://temp.sdy.world"}):
                with urllib.request.urlopen(urllib.request.Request(url,headers={"Origin":"https://temp.sdy.world"})) as response:
                    self.assertTrue(json.load(response)["ready"])
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(urllib.request.Request(url,headers={"Origin":"https://unrelated.example"}))
                self.assertEqual(denied.exception.code,403)
                denied.exception.close()
        finally:
            server.shutdown();server.server_close();worker.join()

    def confirmation_record(self, name="confirm"):
        async def prepare():
            session = self.bridge.sessions[self.session]
            s = session["conversation"].store
            if not s.lines: s.add("latte",1,Options(temperature="hot"))
            s.set_place("store"); s.begin_turn("끝"); s.request_confirmation()
            task = asyncio.create_task(asyncio.sleep(0)); await task
            session["turns"][name] = {"task":task,"done":True,"audio":{},"interrupted":False,
                "events":[{"type":"final","text":s.final_confirmation_text,"needs_delivery":True}]}
            return s
        return self.bridge.submit(prepare())

    def test_visible_summary_can_be_confirmed_while_audio_is_interrupted(self):
        s = self.confirmation_record()
        self.bridge.submit(self.bridge.interrupt(self.session,"confirm","ㅇㅇ",True))
        self.assertTrue(s.pending["delivered"])
        s.begin_turn("ㅇㅇ"); s.checkout()
        self.assertEqual(s.phase,"checkout")

    def test_interruption_does_not_confirm_an_unseen_summary(self):
        for visible, text in [(False,"ㅇㅇ")]:
            s = self.confirmation_record()
            self.bridge.submit(self.bridge.interrupt(self.session,"confirm",text,visible))
            self.assertIsNone(s.pending)
            s.begin_turn(text)
            self.assertFalse(s.checkout()["payment_executed"])

    def test_late_interrupt_preserves_newer_confirmation(self):
        s = self.confirmation_record("old")
        self.confirmation_record("new")
        pending = s.pending.copy()
        self.bridge.submit(self.bridge.interrupt(self.session,"old"))
        self.assertEqual(s.pending,pending)
        self.assertFalse(self.bridge.sessions[self.session]["turns"]["new"]["interrupted"])

    def test_interrupt_before_turn_registration_prevents_old_request_execution(self):
        self.bridge.submit(self.bridge.interrupt(self.session,"early"))
        result = self.bridge.submit(self.bridge.turn(self.session,{"request_id":"early","text":"라떼","cart":cart()}))
        self.assertEqual(result["code"],"INTERRUPTED")
        self.assertEqual(self.bridge.sessions[self.session]["conversation"].calls,0)

    def test_manual_editor_and_navigation_are_authoritative_context(self):
        s = OrderStore.demo()
        ui = cart()
        ui["ui_context"] = {"category":"커피","overlay":None,"editor":{"product_id":"latte","quantity":2,"options":asdict(Options(temperature="ice",ice="less"))}}
        sync_cart(s,ui)
        self.assertEqual(s.snapshot()["ui_context"]["editor"]["quantity"],2)
        self.assertEqual(s.lines,[])
        s.add("latte",1,Options(temperature="hot"))
        with self.assertRaises(OrderError): s.request_confirmation()
        ui["lines"]=[{"id":s.lines[0].id,"productId":"latte","quantity":1,"options":asdict(Options(temperature="hot"))}]
        ui["ui_context"]["editor"]=None;ui["screen"]="cart"
        sync_cart(s,ui);s.request_confirmation()
        ui["screen"]="menu";sync_cart(s,ui)
        self.assertIsNone(s.pending)
        self.assertEqual(s.view,"menu")

    def test_audio_usage_is_counted_once_when_cached_audio_is_replayed(self):
        self.start();self.finish()
        session=self.bridge.sessions[self.session]
        async def stream(text,emit):
            emit({"type":"audio.delta","pcm":"AAAAAA==","sample_rate":24000})
            emit({"type":"audio.usage","counts":{"input_tokens":10,"output_tokens":30,"total_tokens":40,"requests":1}})
        session["speaker"].stream=stream
        first=self.bridge.submit(self.bridge.speech(self.session,"turn-1","따뜻한 라떼"))
        async def finish_audio(): await first["task"]
        self.bridge.submit(finish_audio())
        self.bridge.submit(self.bridge.speech(self.session,"turn-1","따뜻한 라떼"))
        self.assertEqual(session["tts_usage"]["total_tokens"],40)
        self.assertEqual(first["events"][-1]["usage"]["tts_session"]["total_tokens"],40)

    def test_touch_journal_is_added_to_context_once_even_when_cart_ends_empty(self):
        c=self.bridge.sessions[self.session]["conversation"];c.history=[]
        ui=cart();ui["ui_context"]={"editor":None,"events":[
            {"id":1,"kind":"add_item","source":"ui_or_device","before":None,"after":{"product_id":"americano"}},
            {"id":2,"kind":"remove_item","source":"ui_or_device","before":{"product_id":"americano"},"after":None}]}
        self.bridge.submit(self.bridge.turn(self.session,{"request_id":"turn-1","text":"방금 지운 거 뭐였어?","cart":ui}));self.finish()
        history=str(c.history)
        self.assertIn("remove_item",history);self.assertIn("americano",history)
        self.assertEqual(self.bridge.sessions[self.session]["last_ui_event"],2)
        self.assertNotIn("events",c.store.ui_context)

    def test_agent_requested_review_navigation_keeps_published_confirmation(self):
        s=OrderStore.demo();s.add("latte",1,Options(temperature="hot"));s.set_place("store")
        ui={"screen":"menu","place":"store","lines":[{"id":s.lines[0].id,"productId":"latte","quantity":1,"options":asdict(Options(temperature="hot"))}]}
        sync_cart(s,ui);s.request_confirmation()
        ui["screen"]="cart";sync_cart(s,ui)
        self.assertIsNotNone(s.pending)
        ui["screen"]="menu";sync_cart(s,ui)
        self.assertIsNone(s.pending)

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
