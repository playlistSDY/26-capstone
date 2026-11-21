import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from voice_frontend import Candidate, Decision, NoiseFloor, SpeechCapture, TurnBuffer, Silero, FRAME_SAMPLES
from speech_decisions import rules, jev_decision, OpenAIGate, preserve_short_reply

FRAME = (np.sin(np.arange(FRAME_SAMPLES) * .08) * 1000).astype("<i2").tobytes()
SILENCE = bytes(FRAME_SAMPLES * 2)


class AcousticTests(unittest.TestCase):
    def test_noise_adapts_both_directions_and_cannot_learn_a_person_as_noise(self):
        floor = NoiseFloor()
        for _ in range(120):
            self.assertFalse(floor.update(1200, .01))
        self.assertGreater(floor.threshold, 500)
        background = floor.noise
        for _ in range(100):
            self.assertTrue(floor.update(3000, .9))
        self.assertEqual(background, floor.noise)
        for _ in range(400):
            floor.update(15, .01)
        self.assertLess(floor.threshold, 100)

    def test_strong_quiet_speech_survives_high_background_energy_threshold(self):
        floor = NoiseFloor()
        for _ in range(120):
            floor.update(2000, .01)
        self.assertGreater(floor.threshold, 500)
        self.assertTrue(floor.update(90, .9))
        self.assertFalse(floor.update(90, .05))

    def test_high_energy_non_speech_never_starts_capture(self):
        detector = SpeechCapture()
        for _ in range(200):
            self.assertIsNone(detector.feed(FRAME, 4000, .01))
        self.assertFalse(detector.active)

    def test_false_short_candidate_closes_without_a_stuck_active_turn(self):
        detector = SpeechCapture()
        for _ in range(2):
            detector.feed(FRAME, 1000, .9)
        self.assertTrue(detector.active)
        chunks = [detector.feed(SILENCE, 0, .01) for _ in range(30)]
        chunk = next(c for c in chunks if c is not None)
        self.assertEqual(chunk.pcm, b"")
        self.assertFalse(detector.active)

    def test_long_audio_boundaries_keep_turn_open(self):
        detector = SpeechCapture(maximum=1)
        chunks = []
        for _ in range(40):
            chunk = detector.feed(FRAME, 1000, .9)
            if chunk:
                chunks.append(chunk)
        self.assertTrue(chunks[0].continuing)
        self.assertTrue(detector.active)
        for _ in range(30):
            chunk = detector.feed(SILENCE, 0, .01)
            if chunk:
                self.assertFalse(chunk.continuing)
        self.assertFalse(detector.active)

    def test_button_does_not_turn_silent_or_non_speech_audio_into_requests(self):
        detector = SpeechCapture(button=True)
        for _ in range(100):
            detector.feed(FRAME, 2000, .01, True)
        self.assertFalse(detector.active)
        for _ in range(100):
            detector.feed(FRAME, 2000, .9, False)
        self.assertFalse(detector.active)

    def test_real_bundled_silero_has_no_speech_on_digital_silence(self):
        vad = Silero()
        frames = list(vad.frames(bytes(48000 * 2)))
        self.assertEqual(len(frames), 31)
        self.assertTrue(all(0 <= p < .15 for _, _, p in frames))
        vad.reset()
        self.assertEqual(len(list(vad.frames(bytes(1536 * 2)))), 1)


class TurnTests(unittest.TestCase):
    def add(self, buffer, start, end, text, continuing=False):
        buffer.speech_started(start)
        token = buffer.audio_finished(end, continuing)
        buffer.transcript(token, text)
        return token

    def test_slow_order_and_correction_merge_without_rewriting_original_words(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "아이스")
        first = buffer.poll(2.5)
        self.assertIsInstance(first, Candidate)
        buffer.apply(first, Decision("wait", "needs_more_words"), 2.6)
        self.add(buffer, 3, 4, "아메리카노 두 잔")
        buffer.speech_started(5)
        self.assertIsNone(buffer.poll(6))
        token = buffer.audio_finished(6)
        buffer.transcript(token, "아니 한 잔 주세요")
        final = buffer.poll(7.5)
        self.assertEqual(final.turn_id, first.turn_id)
        self.assertEqual(final.text, "아이스 아메리카노 두 잔 아니 한 잔 주세요")
        self.assertEqual(len(final.context["fragments"]), 3)
        self.assertEqual(buffer.apply(final, Decision("accept", "ready"), 7.6)[0], "accept")
        self.assertIsNone(buffer.poll(20))

    def test_speech_resuming_during_classifier_request_invalidates_its_result(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "라떼 두 잔 주세요")
        candidate = buffer.poll(2.5)
        buffer.speech_started(2.6)
        self.assertIsNone(buffer.apply(candidate, Decision("accept", "ready"), 2.7))
        token = buffer.audio_finished(3.5)
        buffer.transcript(token, "아니 한 잔 주세요")
        self.assertIn("아니 한 잔", buffer.poll(5).text)

    def test_stt_in_flight_holds_entire_turn(self):
        buffer = TurnBuffer()
        buffer.speech_started(0)
        token = buffer.audio_finished(1)
        self.assertIsNone(buffer.poll(20))
        buffer.transcript(token, "라떼 주세요")
        self.assertIsInstance(buffer.poll(21), Candidate)

    def test_transcription_or_queue_failure_never_accepts_only_the_remaining_words(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "라떼")
        buffer.speech_started(2)
        token = buffer.audio_finished(3)
        buffer.transcript(token, "", failed=True)
        self.assertEqual(buffer.poll(5)[0], "clarify")

    def test_unknown_target_times_out_without_interrupting_bystanders(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "네")
        candidate = buffer.poll(2.5)
        buffer.apply(candidate, Decision("wait", "unclear_target"), 2.6)
        self.assertIsNone(buffer.poll(5))
        self.assertEqual(buffer.poll(8)[0], "ignore")

    def test_incomplete_request_needs_clarification_instead_of_guessing(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "그리고")
        candidate = buffer.poll(2.5)
        buffer.apply(candidate, Decision("wait", "needs_more_words"), 2.6)
        self.assertEqual(buffer.poll(8)[0], "clarify")

    def test_empty_result_and_disconnected_audio_do_not_leave_old_requests(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 1, "")
        self.assertEqual(buffer.poll(3)[0], "ignore")
        buffer.speech_started(4)
        token = buffer.audio_finished(5)
        buffer.cancel()
        self.assertFalse(buffer.transcript(token, "아메리카노 주세요"))
        self.assertIsNone(buffer.poll(10))

    def test_audio_cap_does_not_finalize_while_person_still_speaks(self):
        buffer = TurnBuffer()
        self.add(buffer, 0, 12, "아이스 아메리카노", continuing=True)
        self.assertIsNone(buffer.poll(20))
        token = buffer.audio_finished(21)
        buffer.transcript(token, "한 잔 주세요")
        self.assertEqual(buffer.poll(23).text, "아이스 아메리카노 한 잔 주세요")


class SemanticTests(unittest.TestCase):
    def test_short_reply_without_context_is_preserved_without_model_cost(self):
        for text in ["네", "예.", "아니요", "따뜻하게"]:
            self.assertEqual(preserve_short_reply(text, {}).action, "wait")
        self.assertIsNone(preserve_short_reply("네", {"last_question": "차갑게 드릴까요?"}))
        with patch("openai.OpenAI") as factory:
            gate = OpenAIGate("test-key", "gpt-5.6-luna")
            self.assertEqual(gate.decide("네", {}).action, "wait")
            factory.return_value.responses.create.assert_not_called()

    def test_provider_is_tool_free_structured_and_does_not_store_the_request(self):
        with patch("openai.OpenAI") as factory:
            create = factory.return_value.responses.create
            create.return_value = SimpleNamespace(output_text='{"action":"accept","reason":"ready"}', usage=SimpleNamespace(input_tokens=600, output_tokens=17))
            gate = OpenAIGate("test-key", "gpt-5.6-luna")
            decision = gate.decide("라떼 주세요", {})
            self.assertEqual(decision.action, "accept")
            args = create.call_args.kwargs
            self.assertFalse(args["store"])
            self.assertTrue(args["text"]["format"]["strict"])
            self.assertEqual(args["reasoning"]["effort"], "none")
            self.assertNotIn("tools", args)
            create.return_value.output_text = '{"action":"execute_order","reason":"ready"}'
            with self.assertRaises(ValueError):
                gate.decide("라떼 주세요", {})

    def test_rules_baseline_separates_discussion_and_short_contextual_answers(self):
        self.assertEqual(rules("너 뭐 먹을래? 난 라떼", {}).action, "ignore")
        self.assertEqual(rules("아이스", {}).action, "wait")
        self.assertEqual(rules("아이스 아메리카노 한 잔 주세요", {}).action, "accept")
        self.assertEqual(rules("네", {}).action, "wait")
        self.assertEqual(rules("네", {"last_question": "차갑게 드릴까요?"}).action, "accept")

    def response(self, target, complete, certainty=.95):
        return {"answers": {"target": {"choice": target, "confidence": certainty, "probabilities": {target: certainty}}, "completion": {"choice": complete, "confidence": certainty, "probabilities": {complete: certainty}}}}

    def test_jev_requires_both_target_and_completeness(self):
        self.assertEqual(jev_decision(self.response("kiosk", "complete")).action, "accept")
        self.assertEqual(jev_decision(self.response("other", "complete")).action, "ignore")
        self.assertEqual(jev_decision(self.response("kiosk", "incomplete")).action, "wait")
        self.assertEqual(jev_decision(self.response("kiosk", "complete", .4)).action, "wait")
        self.assertEqual(jev_decision(self.response("uncertain", "complete")).reason, "unclear_target")

    def test_bad_jev_values_are_rejected(self):
        for value in [float("nan"), 2, -1, "0.9", True]:
            with self.assertRaises(ValueError):
                jev_decision(self.response("kiosk", "complete", value))


if __name__ == "__main__":
    unittest.main()
