"""Keep the agent and kiosk quantity boundaries identical."""
from dataclasses import asdict
import unittest
from switch_agent.domain import MAX_ORDER_QUANTITY, Options, OrderError, OrderStore
from switch_agent.preferences import add_with_preferences
from switch_agent.web import normalize_ui_context, sync_cart
from switch_agent.runtime import Conversation
from test_runtime import ScriptedModel, call, speech

class QuantityTests(unittest.TestCase):
    def test_999_cups_edit_split_and_checkout_but_1000_is_atomic(self):
        s = OrderStore.demo()
        s.set_place('takeout')
        s.add('latte', 998, Options(temperature='ice'))
        line = s.lines[0]
        s.edit(line.id, 999, line.options)
        self.assertEqual(s.snapshot()['total'], 4700 * 999)
        with self.assertRaises(OrderError): s.edit(line.id, 1000, line.options)
        self.assertEqual(s.lines[0].quantity, 999)
        s.split(line.id, 499, Options(temperature='hot'))
        self.assertEqual([l.quantity for l in s.lines], [500, 499])
        for pid, options in [('latte', Options(temperature='ice')), ('americano', Options(temperature='hot'))]:
            with self.assertRaises(OrderError): s.add(pid, 1, options)
        self.assertEqual(sum(l.quantity for l in s.lines), MAX_ORDER_QUANTITY)
        s.request_confirmation()
        self.assertEqual(s.checkout()['cart']['total'], 4700 * 999)

    def test_same_options_cannot_evade_999_limit(self):
        s = OrderStore.demo()
        s.add('latte', 500, Options(temperature='hot'))
        s.add('latte', 499, Options(temperature='hot'))
        with self.assertRaises(OrderError): s.add('latte', 1, Options(temperature='hot'))
        self.assertEqual(len(s.lines), 2)

    def test_preferences_editor_and_touch_accept_999_not_1000(self):
        s = OrderStore.demo()
        options = Options(temperature='ice', ice='more', whippedCream='none')
        result = add_with_preferences(s, 'mocha', 999, options, ['temperature'], True)
        self.assertEqual(s.lines[0].quantity, 999)
        self.assertTrue(result)
        row = {'id': 'touch', 'productId': 'mocha', 'quantity': 999, 'options': asdict(s.lines[0].options)}
        sync_cart(s, {'screen': 'menu', 'place': 'store', 'lines': [row]})
        context = {'editor': {'product_id':'mocha', 'quantity':999, 'options':row['options']}}
        self.assertEqual(normalize_ui_context(s, context)['editor']['quantity'], 999)
        context['editor']['quantity'] = 1000
        with self.assertRaises(OrderError): normalize_ui_context(s, context)
        row['quantity'] = 1000
        with self.assertRaises(OrderError): sync_cart(s, {'screen':'menu', 'place':'store', 'lines':[row]})
        self.assertEqual(s.lines[0].quantity, 999)
        with self.assertRaises(OrderError): add_with_preferences(s, 'mocha', 1000, options, ['temperature'], True)

    def test_real_stock_and_integer_rules_still_apply(self):
        s = OrderStore.demo()
        s.stock['latte'] = 100
        for quantity in (101, 999, 0, -1, 1.5, True):
            with self.assertRaises(OrderError): s.add('latte', quantity, Options(temperature='hot'))
        self.assertFalse(s.lines)

class QuantityRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_orders_999_then_reduces_quantity(self):
        model = ScriptedModel([
            [call('add_item', {'product_id':'mocha', 'quantity':999, 'options':asdict(Options(temperature='ice')), 'confirmed_options':['temperature'], 'use_defaults':True})],
            [speech('999잔 담았어요.')],
        ])
        c = Conversation(model=model)
        result = await c.reply('아이스 디카페인 카페모카 999잔 나머지는 기본으로')
        self.assertEqual(result['state']['total'], 4700 * 999)
        line = c.store.lines[0]
        model.outputs = iter([[call('edit_item', {'line_id':line.id, 'quantity':2, 'options':asdict(line.options)})], [speech('두 잔으로 바꿨어요.')]])
        result = await c.reply('아니 두 잔으로 바꿔줘')
        self.assertEqual(result['state']['total'], 9400)
