import json
import unittest
from switch_agent.domain import Options, OrderStore, OrderError
from switch_agent.guidance import guide
from switch_agent.web import normalize_ui_context
from switch_agent.runtime import Conversation
from test_runtime import ScriptedModel, call, speech


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.store = OrderStore.demo()

    def test_explanation_highlight_does_not_choose_or_add(self):
        before = self.store.snapshot()
        result = guide(self.store, 'option', '큰 크기는 500원 추가예요.', 'latte', option='size', value='large')
        after = self.store.snapshot()
        self.assertFalse(result['cart_changed'])
        self.assertEqual(after['guidance']['value'], 'large')
        for field in ('lines', 'revision', 'place', 'item_drafts', 'phase'):
            self.assertEqual(before[field], after[field])

    def test_guidance_cannot_target_missing_line_or_arbitrary_selector(self):
        with self.assertRaises(OrderError): guide(self.store, 'cart.remove', '삭제 버튼이에요.', line_id='missing')
        with self.assertRaises(OrderError): guide(self.store, '#pay', '버튼이에요.')
        with self.assertRaises(OrderError): guide(self.store, 'option', '우유 버튼이에요.', 'americano', option='milk')
        with self.assertRaises(OrderError): guide(self.store, 'checkout', '결제 버튼이에요.')

    def test_no_reader_or_charge_created_by_payment_explanation(self):
        self.store.add('latte', 1, Options(temperature='hot'))
        self.store.set_place('store')
        self.store.checkout()
        guide(self.store, 'payment.method', '카드 버튼이에요.', value='card')
        self.assertIsNone(self.store.payment_action)
        self.store.payment_ui = {'payment': {'status': 'waiting'}}
        with self.assertRaises(OrderError): guide(self.store, 'payment.method', '카드 버튼이에요.', value='card')

    def test_context_has_bounded_interaction_and_last_step(self):
        context = normalize_ui_context(self.store, {'interaction': {'activations': 4, 'option_changes': 2, 'idle_ms': 500, 'screen_changes': -1, 'recent_actions': ['option', '#arbitrary'] * 20}, 'guidance': {'target': 'editor.add', 'status': 'done', 'instruction': '담기를 눌러 주세요.', 'product_id': 'latte'}})
        self.assertEqual(context['interaction']['activations'], 4)
        self.assertNotIn('screen_changes', context['interaction'])
        self.assertLessEqual(len(context['interaction']['recent_actions']), 12)
        self.assertNotIn('#arbitrary', context['interaction']['recent_actions'])
        self.assertEqual(context['guidance']['status'], 'done')


class GuidanceRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_sdk_guides_explanation_then_delegates_existing_selection(self):
        store = OrderStore.demo()
        store.ui_context = {'editor': {'product_id': 'latte', 'quantity': 2, 'options': {'temperature': 'ice', 'size': 'large', 'ice': 'less', 'sweetness': 'less', 'shots': 0, 'syrup': 0, 'milk': 'regular', 'decaf': False}}, 'interaction': {'activations': 7, 'option_changes': 3}}
        options = store.ui_context['editor']['options']
        model = ScriptedModel([
            [call('guide_ui', {'target': 'option', 'instruction': '큰 크기는 500원 추가예요.', 'product_id': 'latte', 'option': 'size', 'value': 'large'})],
            [speech('큰 크기는 500원 추가예요.')],
            [call('add_item', {'product_id': 'latte', 'quantity': 2, 'options': options, 'use_defaults': True, 'confirmed_options': ['temperature']})],
            [speech('고르신 옵션 그대로 두 잔 담았어요.')],
        ])
        c = Conversation(store=store, model=model)
        first = await c.reply('크기 설명해줘')
        self.assertEqual(first['state']['guidance']['option'], 'size')
        self.assertEqual(store.lines, [])
        second = await c.reply('이대로 대신 담아줘')
        self.assertIsNone(second['state']['guidance'])
        self.assertEqual(store.lines[0].quantity, 2)
        self.assertEqual(store.lines[0].options.ice, 'less')
        self.assertEqual(store.lines[0].options.size, 'large')
