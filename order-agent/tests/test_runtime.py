"""Exercise the real SDK runner with scripted model outputs; never call OpenAI."""
import asyncio
from dataclasses import asdict
import json
import unittest

from agents import ModelResponse, Usage
from agents.models.interface import Model
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText, Response, ResponseTextDeltaEvent, ResponseCompletedEvent

from switch_agent.domain import Options, OrderStore
from switch_agent.runtime import Conversation
from switch_agent.tools import TOOLS


def call(name, arguments=None):
    return ResponseFunctionToolCall(id="fc_" + name, call_id="call_" + name, name=name, arguments=json.dumps(arguments or {}), type="function_call")


def speech(text):
    return ResponseOutputMessage(id="msg_test", role="assistant", status="completed", type="message", content=[ResponseOutputText(type="output_text", text=text, annotations=[])])


class ScriptedModel(Model):
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.inputs = []

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs, tracing, **kwargs):
        self.inputs.append(input)
        return ModelResponse(output=next(self.outputs), usage=Usage(), response_id=None)

    async def stream_response(self, *args, **kwargs):
        output = next(self.outputs)
        for item in output:
            if item.type == "message":
                text = item.content[0].text
                for index, delta in enumerate((text[:5], text[5:])):
                    yield ResponseTextDeltaEvent(type="response.output_text.delta", delta=delta, content_index=0, item_id=item.id, output_index=0, sequence_number=index, logprobs=[])
        yield ResponseCompletedEvent(type="response.completed", sequence_number=10, response=Response(id="resp_test", created_at=0, model="test", object="response", output=output, parallel_tool_calls=False, tool_choice="auto", tools=[], status="completed"))


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_executes_tool_and_keeps_context_between_turns(self):
        model = ScriptedModel([
            [call("set_order_type", {"place": "takeout"})],
            [call("add_item", {"product_id": "latte", "quantity": 1, "options": asdict(Options(temperature="hot")), "confirmed_options": ["temperature"], "use_defaults": True})],
            [speech("따뜻한 라떼 한 잔 담았어요.")],
            [call("request_final_confirmation")],
            [call("open_checkout")],
        ])
        c = Conversation(model=model)
        self.assertIn("담았어요", (await c.reply("따뜻한 라떼 하나 포장, 나머지는 기본으로 해줘"))["text"])
        self.assertEqual(sum(item.get("role") == "assistant" for item in c.history), 1)
        self.assertIn("이대로 결제할까요", (await c.reply("끝"))["text"])
        self.assertEqual((await c.reply("네"))["state"]["phase"], "checkout")
        self.assertTrue(any(item.get("role") == "user" and item.get("content") == "끝" for item in model.inputs[-1]))

    async def test_review_then_consent_with_method_opens_reader_command(self):
        s = OrderStore.demo(); s.add("latte",1,Options(temperature="hot")); s.set_place("store")
        c = Conversation(store=s, model=ScriptedModel([
            [call("request_final_confirmation")],
            [call("open_checkout", {"method":"card"})],
        ]))
        review = await c.reply("주문 다 한 것 같아")
        self.assertEqual(review["state"]["view"], "review")
        self.assertEqual(review["state"]["phase"], "ordering")
        pay = await c.reply("네 카드로 결제할게요")
        self.assertEqual(pay["state"]["payment_action"]["method"], "card")
        self.assertIn("리더기", pay["text"])
        self.assertFalse(s.payment_ui.get("receipt"))

    async def test_payment_status_question_is_not_replaced_by_method_question(self):
        s = OrderStore.demo(); s.phase = "checkout"
        c = Conversation(store=s, model=ScriptedModel([[speech("카드 승인을 기다리고 있어요.")]]))
        self.assertEqual((await c.reply("지금 뭐 해?"))["text"], "카드 승인을 기다리고 있어요.")

    async def test_home_order_asks_place_then_sets_menu_context(self):
        c = Conversation(model=ScriptedModel([
            [speech("드시고 가세요, 포장해 드릴까요?")],
            [call("set_order_type", {"place":"store"})],
            [speech("메뉴판을 열었어요. 원하시는 메뉴를 말씀해 주세요.")],
        ]))
        first = await c.reply("주문할게요")
        self.assertIsNone(first["state"]["place"])
        second = await c.reply("먹고 갈게요")
        self.assertEqual(second["state"]["place"], "store")
        self.assertEqual(second["state"]["phase"], "ordering")

    async def test_token_usage_includes_all_tool_roundtrips_and_session_total(self):
        class MeteredModel(ScriptedModel):
            async def get_response(self,*args,**kwargs):
                response=await super().get_response(*args,**kwargs)
                response.usage=Usage(requests=1,input_tokens=100,output_tokens=20,total_tokens=120)
                return response
        c=Conversation(model=MeteredModel([[call("set_order_type",{"place":"store"})],[speech("매장으로 해 드릴게요.")],[speech("천천히 고르세요.")]]))
        first=await c.reply("먹고 갈게요")
        self.assertEqual(first["usage"]["turn"]["total_tokens"],240)
        second=await c.reply("잠깐만")
        self.assertEqual(second["usage"]["turn"]["total_tokens"],120)
        self.assertEqual(second["usage"]["session"]["total_tokens"],360)

    async def test_committing_visible_editor_can_continue_to_order_review(self):
        s=OrderStore.demo();s.add("latte",1,Options(temperature="hot"));s.set_place("store")
        line=s.lines[0]
        s.ui_context={"editor":{"line_id":line.id,"product_id":"latte","quantity":2,"options":asdict(Options(temperature="ice"))}}
        c=Conversation(store=s,model=ScriptedModel([
            [call("edit_item",{"line_id":line.id,"quantity":2,"options":asdict(Options(temperature="ice"))})],
            [call("request_final_confirmation")]]))
        result=await c.reply("지금 화면에서 고른 대로 바꾸고 결제할게요")
        self.assertEqual(result["state"]["lines"][0]["quantity"],2)
        self.assertIsNone(s.ui_context["editor"])
        self.assertTrue(result["state"]["confirmation_pending"])

    async def test_order_type_correction_and_spoken_agreement_do_not_repeat_review(self):
        s=OrderStore.demo();s.add("latte",2,Options(temperature="hot"));s.add("americano",1,Options(temperature="ice",size="large"));s.set_place("takeout")
        c=Conversation(store=s,model=ScriptedModel([
            [call("request_final_confirmation")],
            [call("set_order_type",{"place":"store"})],
            [speech("매장으로 바꿨어요. 이대로 결제할까요?")],
            [call("open_checkout")]]))
        await c.reply("이대로 결제해줘",emit=lambda e:None,defer_delivery=True)
        await c.reply("아 매장에서 먹고갈래",emit=lambda e:None,defer_delivery=True)
        self.assertIsNone(s.pending)
        result=await c.reply("그래",emit=lambda e:None,defer_delivery=True)
        self.assertEqual(result["state"]["phase"],"checkout")
        self.assertEqual(result["state"]["place"],"store")
        self.assertNotIn("다시 확인",result["text"])

    async def test_model_cannot_skip_confirmation(self):
        c = Conversation(model=ScriptedModel([[call("open_checkout")]]))
        result = await c.reply("그냥 결제해")
        self.assertEqual(result["state"]["phase"], "ordering")
        self.assertIn("메뉴", result["text"])

    async def test_clear_order_removes_lines_and_invalidates_confirmation(self):
        s = OrderStore.demo(); s.set_place("store")
        s.add("latte", 1, Options(temperature="hot")); s.request_confirmation(); s.delivered()
        s.item_drafts["latte"] = {"next_option": "size"}
        c = Conversation(store=s, model=ScriptedModel([[call("clear_order")], [speech("주문을 비웠어요.")]]))
        result = await c.reply("전부 취소해 주세요")
        self.assertEqual(result["state"]["lines"], [])
        self.assertEqual(result["state"]["place"], "store")
        self.assertIsNone(s.pending)
        self.assertEqual(s.item_drafts, {})

    async def test_cancel_pending_item_keeps_cart(self):
        s = OrderStore.demo()
        s.add("latte", 1, Options(temperature="hot"))
        s.item_drafts["americano"] = {"next_option": "size"}
        c = Conversation(store=s, model=ScriptedModel([[call("cancel_pending_item", {"product_id": "americano"})], [speech("아메리카노는 취소했어요.")]]))
        await c.reply("담기 전 아메리카노는 취소해줘")
        self.assertEqual(s.item_drafts, {})
        self.assertEqual(len(s.lines), 1)

    async def test_failed_mutation_returns_result_for_model_recovery(self):
        model = ScriptedModel([
            [call("add_item", {"product_id": "latte", "quantity": 1, "options": asdict(Options())})],
            [speech("따뜻하게 드릴까요, 차갑게 드릴까요?")],
        ])
        c = Conversation(model=model)
        result = await c.reply("라떼 하나")
        self.assertEqual(result["state"]["lines"], [])
        self.assertIn("차갑게", result["text"])

    async def test_model_error_preserves_committed_changes_and_clears_confirmation(self):
        model = ScriptedModel([[call("set_order_type", {"place": "store"})]])
        c = Conversation(model=model)
        with self.assertRaises(RuntimeError): await c.reply("매장에서 먹을게")
        self.assertEqual(c.store.place, "store")
        self.assertIsNone(c.store.pending)
        self.assertIn("자동 재실행", c.history[-1]["content"])

    async def test_tools_have_strict_schemas(self):
        for tool in TOOLS:
            self.assertTrue(tool.strict_json_schema)
            self.assertFalse(tool.params_json_schema["additionalProperties"])

    async def test_streaming_emits_deltas_and_preserves_final_text(self):
        c = Conversation(model=ScriptedModel([[speech("천천히 고르세요. 기다릴게요.")]]))
        events = []
        result = await c.reply("잠깐만", emit=events.append)
        self.assertEqual("".join(event["text"] for event in events), result["text"])
        self.assertEqual(len(events), 2)

    async def test_method_selection_does_not_wait_for_playback_ack(self):
        s = OrderStore.demo()
        s.set_place("store"); s.add("latte", 1, Options(temperature="hot"))
        c = Conversation(store=s, model=ScriptedModel([[call("request_final_confirmation")]]))
        await c.reply("끝", emit=lambda event: None, defer_delivery=True)
        self.assertFalse(s.pending["delivered"])
        s.begin_turn("네")
        self.assertFalse(s.checkout()["payment_executed"])

    async def test_interruption_preserves_partial_spoken_recommendation(self):
        started = asyncio.Event()
        class PartialModel(ScriptedModel):
            async def stream_response(self,*args,**kwargs):
                yield ResponseTextDeltaEvent(type="response.output_text.delta",delta="루이보스 티는 카페인이 없어요.",content_index=0,item_id="partial",output_index=0,sequence_number=0,logprobs=[])
                started.set()
                await asyncio.Event().wait()
                if False: yield None
        c=Conversation(model=PartialModel([]))
        task=asyncio.create_task(c.reply("차 추천해줘",emit=lambda e:None))
        await started.wait();task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(any("루이보스" in str(item.get("content")) for item in c.history))
        self.assertTrue(any(item.get("role")=="developer" and "끼어들었다" in item.get("content","") for item in c.history))

    async def test_cancel_sdk_stream_retains_completed_tools_and_stops_run(self):
        started = asyncio.Event()

        class SlowStream(ScriptedModel):
            async def stream_response(self, *args, **kwargs):
                if self.outputs is not None:
                    async for event in super().stream_response(*args, **kwargs): yield event
                    self.outputs = None
                else:
                    started.set()
                    await asyncio.Event().wait()

        s = OrderStore.demo(); s.set_place("store")
        model = SlowStream([[call("add_item", {"product_id": "latte", "quantity": 1, "options": asdict(Options(temperature="hot")), "confirmed_options": ["temperature"], "use_defaults": True})]])
        c = Conversation(store=s, model=model)
        task = asyncio.create_task(c.reply("따뜻한 라떼", emit=lambda event: None))
        await asyncio.wait_for(started.wait(), timeout=2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(len(s.lines), 1)
        self.assertIsNone(s.pending)


if __name__ == "__main__": unittest.main()
