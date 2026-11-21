import unittest
from switch_agent.domain import Options, OrderError, OrderStore
from switch_agent.preferences import add_with_preferences, important_options


class PreferenceTest(unittest.TestCase):
    def setUp(self):
        self.s = OrderStore.demo()

    def add(self, product='latte', options=None, confirmed=(), defaults=False):
        return add_with_preferences(self.s, product, 1, options or Options(temperature='ice'), list(confirmed), defaults)

    def test_optional_defaults_are_proposed_in_one_question(self):
        result=self.add(confirmed=['temperature'])
        self.assertIn('size',result['draft']['question_options'])
        self.assertIn('ice',result['draft']['question_options'])
        done=self.add(confirmed=result['draft']['question_options'])
        self.assertTrue(done['added'])

    def test_missing_size_is_draft_not_cart(self):
        r = self.add(confirmed=['temperature'])
        self.assertEqual(r['draft']['next_option'], 'size')
        self.assertEqual(self.s.lines, [])
        self.assertEqual(len(self.s.snapshot()['item_drafts']), 1)

    def test_choices_persist_across_questions(self):
        self.add(confirmed=['temperature'])
        r = self.add(confirmed=['size'])
        self.assertEqual(r['draft']['next_option'], 'ice')
        r = self.add(confirmed=['ice'])
        # If sweetness is applicable it must also be answered.
        if not r['added']:
            self.assertEqual(r['draft']['next_option'], 'sweetness')
            r = self.add(confirmed=['sweetness'])
        self.assertTrue(r['added'])
        self.assertEqual(len(self.s.lines), 1)
        self.assertEqual(self.s.item_drafts, {})

    def test_explicit_all_choices_add_without_reasking(self):
        r = self.add(options=Options(temperature='ice', size='large', ice='less', sweetness='less'), confirmed=['temperature', 'size', 'ice', 'sweetness'])
        self.assertTrue(r['added'])
        self.assertEqual(self.s.lines[0].options.ice, 'less')

    def test_delegation_does_not_guess_temperature(self):
        r = self.add(options=Options(), defaults=True)
        self.assertEqual(r['draft']['next_option'], 'temperature')
        self.assertEqual(self.s.lines, [])

    def test_explicit_delegation_accepts_optional_defaults(self):
        self.assertTrue(self.add(confirmed=['temperature'], defaults=True)['added'])

    def test_hot_and_plain_drink_skip_irrelevant_questions(self):
        keys = important_options(self.s.product('americano'), Options(temperature='hot'))
        self.assertNotIn('ice', keys)
        self.assertNotIn('sweetness', keys)
        self.assertTrue(self.add(product='americano', options=Options(temperature='hot'), confirmed=['temperature', 'size'])['added'])

    def test_unresolved_draft_blocks_final_confirmation(self):
        self.s.add('latte', 1, Options(temperature='hot'))
        self.s.set_place('store')
        self.add(confirmed=['temperature'])
        with self.assertRaisesRegex(OrderError, '옵션'):
            self.s.request_confirmation()

    def test_changed_choice_requires_new_confirmation(self):
        self.add(confirmed=['temperature', 'size'])
        r = self.add(options=Options(temperature='ice', size='large'), confirmed=['ice'])
        self.assertEqual(r['draft']['next_option'], 'size')

    def test_invalid_options_do_not_create_draft(self):
        with self.assertRaises(OrderError):
            self.add(options=Options(temperature='hot', ice='less'))
        self.assertEqual(self.s.item_drafts, {})

    def test_fixed_product_does_not_force_questions(self):
        product = next(p for p in self.s.catalog.values() if p['fixedOptions'] and len(p['temperatures']) == 1)
        self.assertTrue(self.add(product=product['id'], options=self.s.defaults(product))['added'])
