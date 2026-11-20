import unittest
from dataclasses import asdict
from switch_agent.domain import OrderStore, Options, OrderError
from switch_agent.payments import command, notice
from switch_agent.web import sync_cart


class PaymentTest(unittest.TestCase):
    def setUp(self):
        self.s = OrderStore.demo()
        self.s.add('latte', 1, Options(temperature='hot'))
        self.s.set_place('takeout')

    def ui(self, screen='payment', status=None, method='card', receipt=None, ack=None):
        return {'screen':screen, 'place':'takeout', 'lines':[
            {'id':l.id, 'productId':l.product_id, 'quantity':l.quantity, 'options':asdict(l.options)} for l in self.s.lines],
            'payment':{'status':status, 'method':method, 'attempt':'attempt-1'} if status else None,
            'receipt':receipt, 'last_action_id':ack}

    def checkout(self):
        self.s.begin_turn('끝'); self.s.request_confirmation(); self.s.delivered()
        self.s.begin_turn('네'); self.s.checkout()

    def test_review_requested_before_checkout(self):
        self.s.request_confirmation()
        self.assertEqual(self.s.snapshot()['view'], 'review')
        self.assertEqual(self.s.phase, 'ordering')

    def test_cannot_select_method_before_final_confirmation(self):
        with self.assertRaises(OrderError): command(self.s, 'select', 'card')

    def test_each_supported_method_requests_reader_not_success(self):
        self.checkout()
        for method in ['card','samsung','apple','kakao','naver']:
            self.s.payment_action = None
            action = command(self.s, 'select', method)
            self.assertEqual(action['method'], method)
            self.assertEqual(self.s.phase, 'checkout')
            self.assertFalse(self.s.payment_ui.get('receipt'))

    def test_duplicate_command_keeps_id_and_ui_ack_clears(self):
        self.checkout()
        first = command(self.s, 'select', 'card')
        self.assertEqual(command(self.s, 'select', 'card')['id'], first['id'])
        sync_cart(self.s, self.ui(status='waiting', ack=first['id']))
        self.assertIsNone(self.s.payment_action)

    def test_retry_requires_failure_and_preserves_method(self):
        self.checkout()
        sync_cart(self.s, self.ui(status='waiting'))
        with self.assertRaises(OrderError): command(self.s, 'retry')
        sync_cart(self.s, self.ui(status='failure', method='kakao'))
        self.assertEqual(command(self.s,'retry')['method'], 'kakao')
        self.assertIn('승인되지', notice(self.s))

    def test_busy_payment_cannot_switch_or_edit_order(self):
        self.checkout(); sync_cart(self.s, self.ui(status='processing'))
        with self.assertRaises(OrderError): command(self.s, 'select', 'naver')
        with self.assertRaises(OrderError): self.s.return_to_order()
        self.assertEqual(command(self.s, 'cancel')['expected_attempt'], 'attempt-1')

    def test_cancel_then_return_requires_new_confirmation(self):
        self.checkout(); sync_cart(self.s,self.ui(status='waiting'))
        action=command(self.s,'cancel')
        sync_cart(self.s,self.ui(ack=action['id']))
        self.s.return_to_order()
        self.assertEqual(len(self.s.lines),1)
        with self.assertRaises(OrderError): self.s.checkout()

    def test_approved_payment_cannot_restart_cancel_or_edit(self):
        self.checkout(); sync_cart(self.s,self.ui(status='approved'))
        for kind in ['retry','cancel','select']:
            with self.assertRaises(OrderError): command(self.s,kind,'card')
        with self.assertRaises(OrderError): self.s.return_to_order()

    def test_receipt_is_required_for_completed_notice(self):
        self.checkout()
        with self.assertRaises(OrderError): sync_cart(self.s,self.ui(screen='completed'))
        with self.assertRaises(OrderError): notice(self.s)
        receipt={'id':'paid-order','number':'007','total':self.s.snapshot()['total'],'method':'card'}
        sync_cart(self.s,self.ui(screen='completed',receipt=receipt))
        self.assertEqual(self.s.phase,'completed')
        self.assertIn('007번',notice(self.s))
        with self.assertRaises(OrderError): self.s.return_to_order()

    def test_late_ui_snapshot_cannot_reopen_completed_order(self):
        self.checkout()
        receipt={'id':'paid-order','number':'007','total':self.s.snapshot()['total'],'method':'card'}
        sync_cart(self.s,self.ui(screen='completed',receipt=receipt))
        with self.assertRaises(OrderError): sync_cart(self.s,self.ui())
        self.assertEqual(self.s.phase,'completed')

    def test_invalid_receipt_does_not_mutate_state(self):
        self.checkout()
        before=self.s.snapshot()
        with self.assertRaises(OrderError): sync_cart(self.s,self.ui(screen='completed',receipt={'id':'x','number':'1','total':1,'method':'card'}))
        self.assertEqual(self.s.snapshot(),before)

    def test_confirmation_with_explicit_method_is_accepted(self):
        self.s.begin_turn('다 했어'); self.s.request_confirmation(); self.s.delivered()
        self.s.begin_turn('네 카드로 결제할게요'); self.s.checkout()
        self.assertEqual(self.s.phase,'checkout')

    def test_short_payment_replies_confirm_only_after_delivered_summary(self):
        for text in ['네 카드요', '응 카드로', '맞아', '카카오페이로 결제해주세요']:
            self.s.phase = 'ordering'
            self.s.begin_turn('다 했어'); self.s.request_confirmation(); self.s.delivered()
            self.s.begin_turn(text); self.s.checkout()
            self.assertEqual(self.s.phase,'checkout')

    def test_confirmation_with_change_is_not_accepted(self):
        self.s.begin_turn('다 했어'); self.s.request_confirmation(); self.s.delivered()
        self.s.begin_turn('네 카드로 결제할게요 아니 라떼 빼줘')
        with self.assertRaises(OrderError): self.s.checkout()
