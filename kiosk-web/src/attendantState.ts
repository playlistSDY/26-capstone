/** Supplied by an upstream input adapter; never infer microphone capture from chat activity. */
export type VoiceInputState = {
  phase: "off" | "listening" | "speech" | "transcribing" | "error";
  partial?: string;
};
export type AttendantState =
  | "offline"
  | "ready"
  | "typing"
  | "listening"
  | "hearing"
  | "transcribing"
  | "thinking"
  | "buffering"
  | "speaking"
  | "input-error";
export function attendantState({
  ready,
  busy,
  speaking,
  audioPending,
  typing,
  voice,
}: {
  ready: boolean;
  busy: boolean;
  speaking: boolean;
  audioPending: boolean;
  typing: boolean;
  voice?: VoiceInputState;
}): AttendantState {
  if (!ready) return "offline";
  if (voice?.phase === "error") return "input-error";
  if (voice?.phase === "speech") return "hearing";
  if (voice?.phase === "transcribing") return "transcribing";
  if (speaking) return "speaking";
  if (typing) return "typing";
  if (busy) return "thinking";
  if (audioPending) return "buffering";
  if (voice?.phase === "listening") return "listening";
  return "ready";
}
export const attendantLabels: Record<AttendantState, string> = {
  offline: "연결 확인 중",
  ready: "입력 대기",
  typing: "입력 중이에요",
  listening: "듣고 있어요",
  hearing: "말씀 듣는 중",
  transcribing: "말씀을 확인하고 있어요",
  thinking: "답변을 준비하고 있어요",
  buffering: "음성을 준비하고 있어요",
  speaking: "말하는 중",
  "input-error": "음성 입력을 확인해 주세요",
};
