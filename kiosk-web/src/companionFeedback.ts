import type { AttendantState } from "./attendantState";
import { attendantLabels } from "./attendantState";
export function waitingState(state: AttendantState) {
  return ["thinking", "buffering", "transcribing", "offline"].includes(state);
}
/** Only describe observable waiting; never invent a successful tool step. */
export function companionFeedback(state: AttendantState, elapsedMs: number) {
  const step = Math.floor(Math.max(0, elapsedMs) / 7000);
  const messages: Partial<Record<AttendantState, string[]>> = {
    thinking: [
      "생각하는 중이에요",
      "말씀하신 내용을 확인하고 있어요",
      "답변을 기다리고 있어요. 조금만 기다려 주세요",
    ],
    buffering: [
      "안내 음성을 준비하고 있어요",
      "음성 응답을 기다리고 있어요",
      "글로 먼저 보셔도 돼요. 음성을 기다리고 있어요",
    ],
    transcribing: [
      "말씀을 글로 확인하고 있어요",
      "말씀하신 내용을 전달받고 있어요",
      "음성 인식 결과를 기다리고 있어요",
    ],
    offline: [
      "연결을 확인하고 있어요",
      "서버 연결을 기다리고 있어요",
      "연결이 늦어지고 있어요",
    ],
  };
  if (state === "thinking" && elapsedMs >= 30000)
    return step % 2
      ? "응답이 늦어지고 있어요. 아직 기다리고 있어요"
      : "요청을 다시 보내지 않으셔도 돼요. 답변을 기다리고 있어요";
  const choices = messages[state];
  return choices ? choices[step % choices.length] : attendantLabels[state];
}
