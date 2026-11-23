import unittest
import json
from agents.tool_context import ToolContext
from switch_agent.tools import search_menu
from dataclasses import asdict
from switch_agent.domain import OrderStore, Options
from switch_agent.language import translate
from switch_agent.web import sync_cart
from switch_agent.runtime import Conversation
from test_runtime import ScriptedModel, call, speech

class LanguageTest(unittest.TestCase):
    def test_ui_preference_survives_order_changes_and_localizes_review(self):
        for language in ('en','zh','ja'):
            s=OrderStore.demo();s.add('mocha',2,Options(temperature='ice',ice='more',whippedCream='none'))
            rows=[{'id':l.id,'productId':l.product_id,'quantity':l.quantity,'options':asdict(l.options)} for l in s.lines]
            sync_cart(s,{'screen':'menu','place':'takeout','lines':rows,'ui_context':{'language':language}})
            self.assertEqual(s.language,language)
            self.assertEqual(s.snapshot()['total'],9400)
            review=s.request_confirmation()['summary']
            self.assertIn('9,400',review)
            self.assertFalse(any('가'<=c<='힣' for c in review),review)
            s.language='en'
            # Same unchanged UI choice cannot undo a spoken preference.
            sync_cart(s,{'screen':'menu','place':'takeout','lines':rows,'ui_context':{'language':language}})
            self.assertEqual(s.language,'en')

    def test_payment_and_quantity_messages_are_localized(self):
        for language in ('en','zh','ja'):
            self.assertNotEqual(translate(language,'카드로 하시겠어요, 다른 결제수단으로 하시겠어요?'),'카드로 하시겠어요, 다른 결제수단으로 하시겠어요?')
            self.assertFalse(any('가'<=c<='힣' for c in translate(language,'샷 2개 추가')))

class LanguageRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_spoken_switch_updates_screen_and_checkout_language(self):
        s=OrderStore.demo();s.set_place('takeout');s.add('mocha',1,Options(temperature='ice'))
        model=ScriptedModel([[call('set_language',{'language':'en'})],[speech('Of course. I can help you in English.')],[call('request_final_confirmation')],[call('open_checkout')]])
        c=Conversation(store=s,model=model)
        first=await c.reply('Please speak English')
        self.assertEqual(first['state']['language'],'en')
        self.assertEqual(first['state']['total'],4700)
        review=await c.reply('Ready to pay')
        self.assertIn('4,700',review['text'])
        self.assertFalse(any('가'<=x<='힣' for x in review['text']))
        payment=await c.reply('Yes')
        self.assertEqual(payment['state']['phase'],'checkout')
        self.assertNotIn('카드',payment['text'])


class SearchLanguageTest(unittest.IsolatedAsyncioTestCase):
    async def test_translated_menu_names_resolve_to_the_same_product_id(self):
        for query in ('Vanilla Latte','香草拿铁','バニララテ'):
            result = json.loads(await search_menu.on_invoke_tool(ToolContext(context=OrderStore.demo(), tool_call_id='search-test', tool_name='search_menu', tool_arguments=json.dumps({'query':query})), json.dumps({'query':query})))
            self.assertEqual(result['results'][0]['id'],'vanilla')
