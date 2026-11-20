"""OpenAI Agents SDK conversation harness with authoritative order state."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from agents import Agent, ModelSettings, Runner, RunConfig

from .domain import OrderStore
from .tools import TOOLS


class Conversation:
    def __init__(self, store=None, model=None):
        self.store = store or OrderStore.demo()
        self.history = []
        self.lock = asyncio.Lock()
        self.prompt = Path(__file__).with_name("prompt.txt").read_text()
        model = model or os.environ.get("OPENAI_MODEL")
        if not model:
            raise ValueError("OPENAI_MODEL에 사용할 모델 ID를 설정해 주세요.")
        self.agent = Agent(
            name="SWitch 주문 점원", model=model, tools=TOOLS,
            instructions=self.instructions,
            model_settings=ModelSettings(parallel_tool_calls=False, store=False),
            # These tools end the current model turn. The host speaks their outcome.
            tool_use_behavior={"stop_at_tool_names": ["request_final_confirmation", "open_checkout", "handoff_to_staff"]},
        )

    def instructions(self, ctx, agent):
        return self.prompt + "\n현재 서버 주문 상태 JSON\n" + json.dumps(self.store.snapshot(), ensure_ascii=False)

    async def reply(self, text, emit=None, defer_delivery=False):
        async with self.lock:
            self.store.begin_turn(text)
            start_revision = self.store.revision
            try:
                kwargs = dict(context=self.store, max_turns=12, run_config=RunConfig(tracing_disabled=True))
                inputs = self.history + [{"role": "user", "content": text}]
                if emit is None:
                    result = await Runner.run(self.agent, inputs, **kwargs)
                else:
                    result = Runner.run_streamed(self.agent, inputs, **kwargs)
                    try:
                        async for event in result.stream_events():
                            if event.type == "raw_response_event" and event.data.type == "response.output_text.delta":
                                emit({"type": "text.delta", "text": event.data.delta})
                    except asyncio.CancelledError:
                        result.cancel()
                        async for _ in result.stream_events():
                            pass
                        raise
                self.history = result.to_input_list()
                if self.store.final_confirmation_text:
                    answer = self.store.final_confirmation_text
                    if not defer_delivery:
                        self.store.delivered()
                elif self.store.phase == "checkout":
                    answer = "확인 감사합니다. 가상 결제 화면으로 넘어갈게요."
                elif self.store.phase == "handoff":
                    answer = "지금까지의 주문과 도움이 필요한 내용을 정리했어요. 아직 실제 직원 호출에는 연결되지 않았어요."
                else:
                    answer = str(result.final_output)
                    # A stopped tool may return validation JSON rather than speech.
                    try:
                        tool_result = json.loads(answer)
                        if isinstance(tool_result, dict) and tool_result.get("ok") is False:
                            answer = tool_result["message"]
                    except (ValueError, TypeError):
                        pass
                last = self.history[-1] if self.history else {}
                content = last.get("content", "")
                previous_text = content if isinstance(content, str) else "".join(part.get("text", "") for part in content if isinstance(part, dict))
                if last.get("role") != "assistant" or previous_text != answer:
                    self.history.append({"role": "assistant", "content": answer})
                return {"text": answer, "state": self.store.snapshot()}
            except (Exception, asyncio.CancelledError):
                # Successful tool mutations are retained; do not blindly replay the turn.
                self.store.pending = self.store.confirmation_at_turn_start = None
                self.store.final_confirmation_text = None
                note = "응답을 끝내지 못했어요. 현재 주문을 확인한 뒤 이어갈게요."
                self.history.extend([{"role": "user", "content": text}, {"role": "assistant", "content": note}])
                if self.store.revision != start_revision:
                    self.history.append({"role": "developer", "content": "중단 전에 도구 변경이 반영됨. 같은 요청을 자동 재실행하지 말고 현재 서버 상태를 확인할 것."})
                raise
