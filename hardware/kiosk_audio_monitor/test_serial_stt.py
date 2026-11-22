import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import wave

import numpy as np

from audio_protocol import SAMPLE_RATE
from serial_stt import Utterances, load_environment, transcribe, wav_bytes


def block(level=0, seconds=.02):
    t = np.arange(round(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (np.sin(2 * np.pi * 500 * t) * level).astype("<i2").tobytes()


class SegmentationTests(unittest.TestCase):
    def test_silence_and_brief_impulse_never_emit_a_transcript_request(self):
        detector = Utterances()
        for _ in range(100):
            self.assertIsNone(detector.feed(block(), 0))
        self.assertIsNone(detector.feed(block(4000), 3000))
        for _ in range(100):
            self.assertIsNone(detector.feed(block(), 0))
        self.assertFalse(detector.active)

    def test_phrase_includes_pre_roll_and_finishes_once_after_silence(self):
        detector = Utterances(silence=.5)
        result = []
        for _ in range(20):
            detector.feed(block(), 0)
        for _ in range(30):
            detector.feed(block(2000), 1400)
        self.assertTrue(detector.active)
        for _ in range(100):
            pcm = detector.feed(block(), 0)
            if pcm:
                result.append(pcm)
        self.assertEqual(len(result), 1)
        self.assertGreater(len(result[0]) / 96000, .8)
        self.assertLess(len(result[0]) / 96000, 1.1)
        self.assertFalse(detector.active)

    def test_button_mode_ignores_speech_outside_press(self):
        detector = Utterances(button=True)
        for _ in range(30):
            self.assertIsNone(detector.feed(block(2000), 1400, False))
        for _ in range(20):
            self.assertIsNone(detector.feed(block(2000), 1400, True))
        self.assertIsNotNone(detector.feed(block(), 0, False))
        self.assertFalse(detector.active)

    def test_continuous_noise_is_bounded_by_maximum_duration(self):
        detector = Utterances(maximum=1)
        emitted = []
        for _ in range(150):
            pcm = detector.feed(block(2000), 1400)
            if pcm:
                emitted.append(pcm)
        self.assertGreaterEqual(len(emitted), 2)
        self.assertTrue(all(len(pcm) <= 1.03 * 96000 for pcm in emitted))


class TransportTests(unittest.TestCase):
    def test_memory_wav_preserves_duration_and_prevents_clipping(self):
        pcm = block(32000, .7)
        with wave.open(io.BytesIO(wav_bytes(pcm)), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate()), (1, 2, 48000))
            self.assertEqual(audio.getnframes(), round(.7 * 48000))
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2")
            self.assertLessEqual(np.max(np.abs(samples.astype(float))), 26001)

    def test_config_reads_only_allowed_variables_without_overriding_environment(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"OPENAI_API_KEY": "existing"}, clear=True):
            config = Path(folder) / ".env"
            config.write_text('OPENAI_API_KEY="other"\nOPENAI_STT_MODEL=gpt-transcribe\nEVIL=$(touch /tmp/nope)\n')
            load_environment(config)
            self.assertEqual(os.environ["OPENAI_API_KEY"], "existing")
            self.assertEqual(os.environ["OPENAI_STT_MODEL"], "gpt-transcribe")
            self.assertNotIn("EVIL", os.environ)

    def test_reported_token_and_duration_usage_are_kept_without_fabrication(self):
        client = Mock()
        result = client.audio.transcriptions.create.return_value
        result.text = " 아이스 라떼 "
        for usage, expected in [
            ({"input_tokens": 21, "output_tokens": 7, "total_tokens": 28, "private": "hidden"}, {"input_tokens": 21, "output_tokens": 7, "total_tokens": 28}),
            ({"type": "duration", "seconds": 1.2}, {"type": "duration", "seconds": 1.2}),
            (None, {}),
        ]:
            result.usage = usage
            text, actual = transcribe(client, "gpt-transcribe", block(1000), with_usage=True)
            self.assertEqual(text, "아이스 라떼")
            self.assertEqual(actual, expected)

    def test_current_and_legacy_models_receive_correct_language_hint(self):
        client = Mock()
        client.audio.transcriptions.create.return_value.text = " 아이스 라떼 주세요 "
        for model in ["gpt-transcribe", "gpt-4o-mini-transcribe"]:
            self.assertEqual(transcribe(client, model, block(1000)), "아이스 라떼 주세요")
            args = client.audio.transcriptions.create.call_args.kwargs
            self.assertEqual(args["model"], model)
            self.assertEqual(args["file"][2], "audio/wav")
            if model == "gpt-transcribe":
                self.assertEqual(args["extra_body"], {"languages": ["ko"]})
                self.assertNotIn("language", args)
            else:
                self.assertEqual(args["language"], "ko")


if __name__ == "__main__":
    unittest.main()
