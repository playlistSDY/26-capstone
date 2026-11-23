"""OpenAI Agents SDK conversation harness with authoritative order state."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from agents import Agent, ModelSettings, Runner, RunConfig

from .domain import OrderStore
from .tools import TOOLS
from .payments import METHODS
from .usage import counts, empty, add
from .language import LANGUAGES, translate


class Conversation:
    def __init__(self, store=None, model=None):
        self.store = store or OrderStore.demo()
        self.history = []
        self.session_usage = empty()
        self.last_usage = None
        self.lock = asyncio.Lock()
        self.prompt = Path(__file__).with_name("prompt.txt").read_text()
        model = model or os.environ.get("OPENAI_MODEL")
        if not model:
            raise ValueError("OPENAI_MODEL에 사용할 모델 ID를 설정해 주세요.")
        self.model_id = model if isinstance(model,str) else os.environ.get("OPENAI_MODEL", "")
        self.agent = Agent(
            name="SWitch 주문 점원", model=model, tools=TOOLS,
            instructions=self.instructions,
            model_settings=ModelSettings(parallel_tool_calls=False, store=False),
            # These tools end the current model turn. The host speaks their outcome.
            tool_use_behavior={"stop_at_tool_names": ["request_final_confirmation", "open_checkout", "select_payment_method", "retry_payment", "cancel_payment", "handoff_to_staff"]},
        )

    def instructions(self, ctx, agent):
        stage = ""
        if self.store.phase == "ordering" and (self.store.view == "review" or self.store.payment_ui.get("screen") == "cart"):
            stage = "\n현재 주문 확인 화면이다. 고객의 동의/진행 요청에는 open_checkout으로 다음 단계로 이동한다. 같은 요약을 다시 확인받지 않는다. 이용 방법만 바꾸면 반영 후 바로 이동한다."
        language = f"\n현재 선호 언어: {LANGUAGES.get(self.store.language, self.store.language)}. 응답과 안내는 이 언어로 한다. 손님이 다른 지원 언어를 원하거나 그 언어로 자연스럽게 말하면 set_language로 바꾼 뒤 그 언어로 계속 응대한다. 메뉴명 한 단어만으로 언어를 바꾸지 않는다.\n"
        return stage + self.prompt + language + "\n현재 서버 주문 상태 JSON\n" + json.dumps(self.store.snapshot(), ensure_ascii=False)

    async def reply(self, text, emit=None, defer_delivery=False):
        async with self.lock:
            self.store.begin_turn(text)
            start_revision = self.store.revision
            start_phase = self.store.phase
            spoken_parts = []
            result = None
            accounted = False
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
                                spoken_parts.append(event.data.delta)
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
                elif self.store.phase == "checkout" and self.store.payment_action:
                    action = self.store.payment_action
                    if action["kind"] == "cancel":
                        answer = "결제를 취소했어요. 다른 결제수단으로 하시겠어요?"
                    elif action["method"] == "card":
                        answer = "카드를 리더기에 넣어 주세요. 승인이 끝나면 알려드릴게요."
                    elif action["method"] in {"kakao", "naver"}:
                        answer = f"{METHODS[action['method']]} 앱의 결제코드를 스캐너에 보여 주세요."
                    else:
                        answer = f"{METHODS[action['method']]}를 켜고 휴대폰을 리더기에 대 주세요."
                elif self.store.phase == "checkout" and (start_phase != "checkout" or "checkout.opened" in str(result.final_output)):
                    answer = "카드로 하시겠어요, 다른 결제수단으로 하시겠어요?"
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
                try:
                    stopped = json.loads(str(result.final_output))
                    if isinstance(stopped, dict) and stopped.get("ok") is False:
                        answer = stopped["message"]
                except (ValueError, TypeError):
                    pass
                answer = translate(self.store.language, answer)
                last = self.history[-1] if self.history else {}
                content = last.get("content", "")
                previous_text = content if isinstance(content, str) else "".join(part.get("text", "") for part in content if isinstance(part, dict))
                if last.get("role") != "assistant" or previous_text != answer:
                    self.history.append({"role": "assistant", "content": answer})
                turn_usage = counts(result.context_wrapper.usage,self.model_id)
                add(self.session_usage, turn_usage)
                self.last_usage = {"turn":turn_usage,"session":dict(self.session_usage)}
                accounted = True
                return {"text": answer, "state": self.store.snapshot(), "usage":self.last_usage}
            except (Exception, asyncio.CancelledError) as failure:
                if not accounted:
                    reported = getattr(getattr(result,"context_wrapper",None),"usage",None)
                    turn_usage = counts(reported,self.model_id)
                    if isinstance(failure,asyncio.CancelledError): turn_usage["unreported_requests"] += 1
                    add(self.session_usage,turn_usage)
                    self.last_usage = {"turn":turn_usage,"session":dict(self.session_usage)}
                # Successful tool mutations are retained; do not blindly replay the turn.
                self.store.pending = self.store.confirmation_at_turn_start = None
                self.store.final_confirmation_text = None
                partial = "".join(spoken_parts).strip()
                if isinstance(failure, asyncio.CancelledError):
                    note = partial or "네, 말씀해 주세요."
                    self.history.extend([{"role": "user", "content": text}, {"role": "assistant", "content": note}])
                    self.history.append({"role": "developer", "content": "손님이 직전 안내 도중 끼어들었다. 직전 assistant는 일부만 전달된 안내다. 새 발화를 우선하고 실제 서버 장바구니·미확정 옵션을 기준으로 이어 간다. 이미 반영한 도구를 다시 실행하지 않는다."})
                    raise
                note = "응답을 끝내지 못했어요. 현재 주문을 확인한 뒤 이어갈게요."
                self.history.extend([{"role": "user", "content": text}, {"role": "assistant", "content": note}])
                if self.store.revision != start_revision:
                    self.history.append({"role": "developer", "content": "중단 전에 도구 변경이 반영됨. 같은 요청을 자동 재실행하지 말고 현재 서버 상태를 확인할 것."})
                raise
