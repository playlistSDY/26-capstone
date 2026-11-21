from copy import deepcopy
import time
import unittest

from switch_agent.domain import Options, OrderError, OrderStore


class OrderRulesTest(unittest.TestCase):
    def setUp(self):
        self.s = OrderStore.demo()
        self.s.begin_turn("매장에서 따뜻한 라떼 주세요")
        self.s.set_place("store")
        self.s.add("latte", 2, Options(temperature="hot"))

    def confirmed(self):
        self.s.request_confirmation()
        self.s.delivered()
        self.s.begin_turn("네")

    def test_missing_temperature_does_not_change_cart(self):
        before = self.s.snapshot()
        with self.assertRaises(OrderError): self.s.add("latte", 1, Options())
        self.assertEqual(before, self.s.snapshot())

    def test_split_changes_only_one_cup(self):
        self.s.split(self.s.lines[0].id, 1, Options(temperature="ice"))
        self.assertEqual([(l.quantity, l.options.temperature) for l in self.s.lines], [(1, "hot"), (1, "ice")])

    def test_stock_counts_different_options_together(self):
        self.s.stock["latte"] = 2
        with self.assertRaises(OrderError): self.s.add("latte", 1, Options(temperature="ice"))
        self.assertEqual(len(self.s.lines), 1)

    def test_same_options_cannot_evade_quantity_limit(self):
        with self.assertRaises(OrderError): self.s.add("latte", 19, Options(temperature="hot"))

    def test_sold_out_at_checkout_blocks_transition(self):
        self.confirmed()
        self.s.catalog["latte"]["soldOut"] = True
        with self.assertRaises(OrderError): self.s.checkout()
        self.assertEqual(self.s.phase, "ordering")

    def test_stock_depleted_at_checkout_blocks_transition(self):
        self.confirmed()
        self.s.stock["latte"] = 1
        with self.assertRaises(OrderError): self.s.checkout()

    def test_method_selection_is_not_gated_on_quote_ack(self):
        self.s.begin_turn("결제할게요")
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_same_turn_method_selection_does_not_charge(self):
        self.s.request_confirmation()
        self.s.delivered()
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_method_selection_does_not_wait_for_speech(self):
        self.s.request_confirmation()
        self.s.begin_turn("네")
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_valid_confirmation_opens_mock_checkout(self):
        self.confirmed()
        result = self.s.checkout()
        self.assertEqual(result["event"], "checkout.opened")
        self.assertFalse(result["payment_executed"])

    def test_quantity_correction_uses_current_cart_without_repeating_ack(self):
        self.s.request_confirmation(); self.s.delivered()
        self.s.begin_turn("네, 근데 하나 빼 주세요")
        self.s.edit(self.s.lines[0].id,1,Options(temperature="hot"))
        self.assertEqual(self.s.checkout()["cart"]["lines"][0]["quantity"],1)

    def test_followup_question_keeps_unchanged_order_available(self):
        self.s.request_confirmation(); self.s.delivered()
        self.s.begin_turn("얼마라고요?")
        self.s.begin_turn("네")
        self.s.checkout()
        self.assertEqual(self.s.phase,"checkout")

    def test_edit_discards_old_summary_but_allows_method_selection(self):
        self.confirmed()
        self.s.edit(self.s.lines[0].id, 1, Options(temperature="hot"))
        self.assertIsNone(self.s.pending)
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_unchanged_summary_does_not_expire_while_customer_thinks(self):
        self.s.request_confirmation(); self.s.delivered()
        self.s.pending["created"] = time.monotonic() - 121
        self.s.begin_turn("네")
        self.s.checkout()
        self.assertEqual(self.s.phase,"checkout")

    def test_duplicate_checkout_does_not_charge(self):
        self.confirmed(); self.s.checkout()
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_edit_after_checkout_needs_return_and_reconfirmation(self):
        self.confirmed(); self.s.checkout()
        with self.assertRaises(OrderError): self.s.remove(self.s.lines[0].id)
        self.s.return_to_order()
        self.s.edit(self.s.lines[0].id, 1, Options(temperature="hot"))
        self.assertIsNone(self.s.pending)
        self.assertFalse(self.s.checkout()["payment_executed"])

    def test_invalid_options_and_fractional_quantity_are_atomic(self):
        before = deepcopy(self.s.snapshot())
        for options in (Options(temperature="hot", ice="none"), Options(temperature="hot", shots=True), Options(temperature="ice", milk="invalid")):
            with self.assertRaises(OrderError): self.s.edit(self.s.lines[0].id, 1, options)
        with self.assertRaises(OrderError): self.s.add("latte", 1.5, Options(temperature="hot"))
        self.assertEqual(before, self.s.snapshot())

    def test_summary_preserves_paid_and_excluded_options(self):
        self.s.edit(self.s.lines[0].id, 1, Options(temperature="ice", size="large", milk="oat", ice="none", sweetness="less", decaf=True, shots=1))
        result = self.s.request_confirmation()["summary"]
        for fragment in ("오트밀크", "얼음 없이", "덜 달게", "디카페인", "샷 1개", "큰 크기", "6,300원"):
            self.assertIn(fragment, result)


if __name__ == "__main__": unittest.main()
