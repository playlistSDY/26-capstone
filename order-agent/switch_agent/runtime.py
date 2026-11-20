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

    async def reply(self, text):
        async with self.lock:
            self.store.begin_turn(text)
            start_revision = self.store.revision
            try:
                result = await Runner.run(
                    self.agent, self.history + [{"role": "user", "content": text}],
                    context=self.store, max_turns=12,
                    run_config=RunConfig(tracing_disabled=True),
                )
                self.history = result.to_input_list()
                if self.store.final_confirmation_text:
                    answer = self.store.final_confirmation_text
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
                if not self.history or self.history[-1].get("role") != "assistant" or self.history[-1].get("content") != answer:
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
