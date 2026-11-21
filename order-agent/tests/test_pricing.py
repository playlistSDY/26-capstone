import unittest
from types import SimpleNamespace as S
from switch_agent.pricing import estimate
from switch_agent.usage import counts, add, empty

class PricingTest(unittest.TestCase):
    def test_text_cache_reads_and_writes_have_separate_rates(self):
        usage=S(input_tokens=100000,output_tokens=10000,input_tokens_details=S(cached_tokens=40000,cache_write_tokens=10000))
        self.assertAlmostEqual(estimate(usage,'gpt-6.2-sol'),0.229)

    def test_long_context_multiplier_applies_to_the_entire_request(self):
        usage=S(input_tokens=300000,output_tokens=10000,input_tokens_details=S(cached_tokens=100000))
        self.assertAlmostEqual(estimate(usage,'gpt-6.2-sol'),0.97)

    def test_many_short_requests_are_not_mistaken_for_one_long_request(self):
        entry=S(input_tokens=100000,output_tokens=10000,input_tokens_details=None)
        usage=S(input_tokens=300000,output_tokens=30000,request_usage_entries=[entry,entry,entry])
        self.assertAlmostEqual(estimate(usage,'gpt-6.2-sol'),0.9)

    def test_tts_text_and_audio_tokens_use_their_own_prices(self):
        usage=S(input_tokens=1000,output_tokens=1010,input_token_details=S(text_tokens=1000,audio_tokens=0,cached_tokens=200,cached_tokens_details=S(text_tokens=200,audio_tokens=0)),output_token_details=S(text_tokens=10,audio_tokens=1000))
        self.assertAlmostEqual(estimate(usage,'gpt-realtime-2.1-mini'),0.020516)

    def test_unknown_model_and_missing_audio_breakdown_are_unpriced(self):
        usage=S(input_tokens=100,output_tokens=50,total_tokens=150)
        self.assertIsNone(estimate(usage,'unknown-model'))
        self.assertIsNone(estimate(usage,'gpt-realtime-2.1-mini'))
        self.assertEqual(counts(usage,'unknown-model')['unpriced_requests'],1)

    def test_cost_accumulates_without_rounding_each_turn(self):
        usage=S(input_tokens=10,output_tokens=1,total_tokens=11)
        total=empty()
        add(total,counts(usage,'gpt-6.2-sol'));add(total,counts(usage,'gpt-6.2-sol'))
        self.assertAlmostEqual(total['estimated_cost_usd'],0.00006)
