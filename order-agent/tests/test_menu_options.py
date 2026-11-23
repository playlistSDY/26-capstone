"""Shared menu rules across model tools, cart edits and touch input."""
from dataclasses import asdict
import json
from pathlib import Path
import unittest
from switch_agent.domain import Options, OrderError, OrderStore
from switch_agent.guidance import guide
from switch_agent.knowledge import details
from switch_agent.web import sync_cart
from switch_agent.runtime import Conversation
from test_runtime import ScriptedModel, call, speech

class MenuOptionsTest(unittest.TestCase):
    def test_catalog_matches_kiosk_and_supported_recipes(self):
        store = OrderStore.demo()
        products = json.loads((Path(__file__).resolve().parents[2] / 'kiosk-web/src/drink-catalog.json').read_text())
        self.assertEqual(len(products), 113)
        self.assertEqual(set(store.catalog), {p['id'] for p in products})
        for p in products:
            for key in ('price', 'temperatures', 'decafOnly', 'whippedCream', 'categories'):
                self.assertEqual(store.product(p['id']).get(key), p.get(key))
            for temp in p['temperatures']:
                variants = details(p['id'], temp)['variants']
                self.assertTrue(variants, p['id'])
                if p.get('decafOnly'): self.assertTrue(all(v['decaf'] for v in variants))

    def test_new_options_survive_add_split_edit_and_touch(self):
        s = OrderStore.demo()
        s.add('mocha', 2, Options(temperature='ice', ice='more', whippedCream='none'))
        self.assertTrue(s.lines[0].options.decaf)
        self.assertEqual(s.snapshot()['total'], 9400)
        s.split(s.lines[0].id, 1, Options(temperature='ice', ice='more', whippedCream='extra'))
        s.edit(s.lines[-1].id, 1, Options(temperature='ice', ice='less', whippedCream='none'))
        rows = [{'id': l.id, 'productId': l.product_id, 'quantity': l.quantity, 'options': asdict(l.options)} for l in s.lines]
        rows[-1]['options'].update(ice='more', whippedCream='extra')
        sync_cart(s, {'screen': 'menu', 'place': 'takeout', 'lines': rows})
        self.assertEqual(s.lines[-1].options.whippedCream, 'extra')
        self.assertEqual(s.lines[-1].options.ice, 'more')
        self.assertEqual(s.snapshot()['total'], 9400)

    def test_decaf_default_and_invalid_combinations(self):
        s = OrderStore.demo()
        s.add('americano-decaf', 1, Options(temperature='ice'))
        self.assertEqual(s.snapshot()['total'], 3700)
        for pid, options in [('mocha', Options(temperature='ice', decaf=False)), ('americano', Options(temperature='ice')), ('americano', Options(temperature='hot', whippedCream='extra')), ('mocha', Options(temperature='hot', ice='more'))]:
            with self.assertRaises(OrderError): s.add(pid, 1, options)
        self.assertEqual(len(s.lines), 1)

    def test_new_guidance_and_hidden_decaf_control(self):
        s = OrderStore.demo()
        for option, value in [('whippedCream', 'extra'), ('ice', 'more')]:
            guide(s, 'option', '이 옵션을 적용해 드릴게요.', product_id='mocha', option=option, value=value)
            self.assertEqual(s.guidance['value'], value)
        with self.assertRaises(OrderError): guide(s, 'option', '원두 선택', product_id='mocha', option='decaf', value='false')

class MenuOptionsRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_new_options_without_extra_questions(self):
        model = ScriptedModel([
            [call('set_order_type', {'place': 'takeout'})],
            [call('add_item', {'product_id': 'mocha', 'quantity': 1, 'options': asdict(Options(temperature='ice', ice='more', whippedCream='none')), 'confirmed_options': ['temperature', 'ice', 'whippedCream'], 'use_defaults': True})],
            [speech('얼음 많이, 휘핑 없이 한 잔 담았어요.')],
        ])
        c = Conversation(model=model)
        result = await c.reply('아이스 디카페인 모카 한 잔 포장, 얼음 많이 휘핑 빼고 나머지는 기본으로')
        self.assertEqual(result['state']['total'], 4700)
        self.assertEqual(len(c.store.lines), 1)
        self.assertEqual(c.store.item_drafts, {})
        self.assertEqual(c.store.lines[0].options.whippedCream, 'none')
