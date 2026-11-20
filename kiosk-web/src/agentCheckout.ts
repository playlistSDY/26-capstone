import type { Payment } from "./PaymentFlow";
import type { PaymentMethod } from "./domain";

export type PaymentAction = {
  id: string;
  kind: "select" | "retry" | "cancel";
  method: PaymentMethod | null;
  expected_attempt: string | null;
  total: number;
};

export function applyPaymentAction(
  action: PaymentAction,
  current: Payment | null,
  total: number,
  attempt: () => string = () => crypto.randomUUID(),
): Payment | null {
  if (
    action.total !== total ||
    action.expected_attempt !== (current?.attempt ?? null)
  )
    throw new Error("결제 상태가 바뀌었어요. 현재 상태로 다시 요청해 주세요.");
  if (current?.status === "approved") throw new Error("이미 승인된 결제예요.");
  if (action.kind === "cancel") {
    if (!current) throw new Error("진행 중인 결제가 없어요.");
    return null;
  }
  if (
    action.kind === "retry" &&
    !["failure", "timeout"].includes(current?.status ?? "")
  )
    throw new Error("실패한 결제만 다시 시도할 수 있어요.");
  if (
    action.kind === "select" &&
    ["reading", "processing"].includes(current?.status ?? "")
  )
    throw new Error("결제가 진행 중이에요. 먼저 취소해 주세요.");
  if (
    !action.method ||
    !["card", "samsung", "apple", "kakao", "naver"].includes(action.method)
  )
    throw new Error("결제수단을 다시 선택해 주세요.");
  return { method: action.method, status: "waiting", attempt: attempt() };
}
