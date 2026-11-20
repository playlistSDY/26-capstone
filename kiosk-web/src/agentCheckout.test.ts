import assert from "node:assert/strict";
import test from "node:test";
import { applyPaymentAction, type PaymentAction } from "./agentCheckout";
import type { Payment } from "./PaymentFlow";
const action: PaymentAction = {
  id: "action",
  kind: "select",
  method: "card",
  expected_attempt: null,
  total: 4200,
};
const current: Payment = { method: "kakao", status: "failure", attempt: "old" };
test("Selecting a method starts the existing reader without declaring approval", () => {
  assert.deepEqual(
    applyPaymentAction(action, null, 4200, () => "new"),
    { method: "card", status: "waiting", attempt: "new" },
  );
});
test("Stale attempts and changed totals cannot start a payment", () => {
  assert.throws(() => applyPaymentAction(action, current, 4200));
  assert.throws(() => applyPaymentAction(action, null, 4300));
});
test("Retry preserves the selected method and creates a new attempt", () => {
  assert.deepEqual(
    applyPaymentAction(
      { ...action, kind: "retry", method: "kakao", expected_attempt: "old" },
      current,
      4200,
      () => "new",
    ),
    { method: "kakao", status: "waiting", attempt: "new" },
  );
});
test("Only failed or timed out attempts can retry", () => {
  assert.throws(() =>
    applyPaymentAction(
      { ...action, kind: "retry", expected_attempt: "old" },
      { ...current, status: "reading" },
      4200,
    ),
  );
});
test("Cancellation preserves the cart and only ends the reader attempt", () => {
  assert.equal(
    applyPaymentAction(
      { ...action, kind: "cancel", method: null, expected_attempt: "old" },
      current,
      4200,
    ),
    null,
  );
});
test("Approved and processing attempts cannot be replaced", () => {
  for (const status of ["approved", "processing"] as const)
    assert.throws(() =>
      applyPaymentAction(
        { ...action, expected_attempt: "old" },
        { ...current, status },
        4200,
      ),
    );
});
