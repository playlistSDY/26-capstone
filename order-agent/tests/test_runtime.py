"""Exercise the real SDK runner with scripted model outputs; never call OpenAI."""
import asyncio
from dataclasses import asdict
import json
import unittest

from agents import ModelResponse, Usage
from agents.models.interface import Model
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

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
        raise NotImplementedError
        yield


class RuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_executes_tool_and_keeps_context_between_turns(self):
        model = ScriptedModel([
            [call("set_order_type", {"place": "takeout"})],
            [call("add_item", {"product_id": "latte", "quantity": 1, "options": asdict(Options(temperature="hot"))})],
            [speech("따뜻한 라떼 한 잔 담았어요.")],
            [call("request_final_confirmation")],
            [call("open_checkout")],
        ])
        c = Conversation(model=model)
        self.assertIn("담았어요", (await c.reply("따뜻한 라떼 하나 포장해줘"))["text"])
        self.assertIn("이대로 결제할까요", (await c.reply("끝"))["text"])
        self.assertEqual((await c.reply("네"))["state"]["phase"], "checkout")
        self.assertTrue(any(item.get("role") == "user" and item.get("content") == "끝" for item in model.inputs[-1]))

    async def test_model_cannot_skip_confirmation(self):
        c = Conversation(model=ScriptedModel([[call("open_checkout")]]))
        result = await c.reply("그냥 결제해")
        self.assertEqual(result["state"]["phase"], "ordering")
        self.assertIn("최종", result["text"])

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


if __name__ == "__main__": unittest.main()
