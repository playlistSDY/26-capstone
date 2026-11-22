import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from compare_speech_gates import PAIRS, cases, context_for, run, summarize
from serial_stt import ROOT
from speech_decisions import JevGate, OpenAIGate
from voice_frontend import Decision


class ComparisonTests(unittest.TestCase):
    def test_noisy_pairs_keep_labels_but_hide_clean_text_and_answers(self):
        rows = cases()
        self.assertEqual(len(rows), 48)
        self.assertEqual(len({r["id"] for r in rows}), 48)
        for name, expected, clean, noisy, question in PAIRS:
            pair = [r for r in rows if r["pair"] == name]
            self.assertEqual({r["expected"] for r in pair}, {expected})
            context = context_for(next(r for r in pair if r["variant"] == "noisy"))
            self.assertEqual(context["fragments"][0]["text"], noisy)
            self.assertNotIn(clean, json.dumps(context, ensure_ascii=False))
            self.assertNotIn("expected", context)
            self.assertNotIn("pair", context)

    def test_summary_counts_errors_and_customer_speech_loss(self):
        rows = [
            {"provider": "jev", "variant": "clean", "expected": "accept", "action": "accept", "passed": True, "seconds": .1},
            {"provider": "jev", "variant": "noisy", "expected": "accept", "action": "ignore", "passed": False, "seconds": .3},
            {"provider": "jev", "variant": "noisy", "expected": "ignore", "passed": False, "error": "TimeoutError", "seconds": 4},
        ]
        summary = summarize(rows)["jev"]
        self.assertEqual(summary["all"]["accuracy_including_errors"], .3333)
        self.assertEqual(summary["all"]["accuracy_successful"], .5)
        self.assertEqual(summary["all"]["errors"], 1)
        self.assertEqual(summary["all"]["customer_drop_rate"], .5)
        self.assertEqual(summary["all"]["p95_seconds"], .3)
        self.assertEqual(summary["clean"]["accuracy_including_errors"], 1)

    def test_same_noisy_context_goes_to_both_models_and_failures_are_sanitized(self):
        first, second = Mock(), Mock()
        first.decide.return_value = Decision("accept", "ready")
        second.decide.side_effect = RuntimeError("SECRET_API_KEY_SHOULD_NOT_APPEAR")
        fixture = {"id": "fixture:noisy", "pair": "fixture", "variant": "noisy", "text": "아이 쓰 한쟌 주새", "last_question": "", "expected": "accept"}
        with patch("compare_speech_gates.cases", return_value=[fixture]):
            rows = run({"openai": first, "jev": second})
        self.assertEqual(first.decide.call_args, second.decide.call_args)
        self.assertFalse(first.decide.call_args.kwargs["use_fast_path"])
        self.assertNotIn("SECRET_API_KEY", json.dumps(rows))
        self.assertEqual(rows[1]["error"], "RuntimeError")

    def test_benchmark_can_force_real_calls_for_short_words_in_both_adapters(self):
        with patch("openai.OpenAI") as factory:
            factory.return_value.responses.create.return_value = SimpleNamespace(output_text='{"action":"accept","reason":"context_for_agent"}', usage=SimpleNamespace(input_tokens=100, output_tokens=10))
            gate = OpenAIGate("fixture", "gpt-5.6-luna")
            gate.decide("네", {}, use_fast_path=False)
            factory.return_value.responses.create.assert_called_once()
        body = {"answers": {name: {"choice": value, "confidence": .95, "probabilities": {value: .98}} for name, value in [("target", "kiosk"), ("completion", "complete")]}}
        with patch("urllib.request.urlopen") as request:
            request.return_value.__enter__.return_value.read.return_value = json.dumps(body).encode()
            gate = JevGate("fixture", ROOT / "kiosk-web/backend/certs/cacert.pem", timeout=4)
            gate.decide("네", {}, use_fast_path=False)
            request.assert_called_once()
            self.assertEqual(request.call_args.kwargs["timeout"], 4)


if __name__ == "__main__":
    unittest.main()
