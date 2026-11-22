import importlib.metadata
import unittest

import numpy as np

from noise_frontend import RNNoise, SpeechDetector
from voice_frontend import FRAME_SAMPLES, SpeechCapture, DropoutGuard

FRAME = np.full(FRAME_SAMPLES, 111, dtype="<i2").tobytes()
SILENCE = bytes(FRAME_SAMPLES * 2)


class CaptureRecoveryTests(unittest.TestCase):
    def test_missing_audio_requires_a_quiet_boundary_before_accepting_a_new_turn(self):
        guard = DropoutGuard()
        self.assertFalse(guard.feed(.9))
        guard.interrupt()
        for _ in range(100):
            self.assertTrue(guard.feed(.9))
        self.assertTrue(guard.blocked)
        for _ in range(16):
            self.assertTrue(guard.feed(.01))
        self.assertFalse(guard.blocked)
        self.assertFalse(guard.feed(.9))

    def test_delayed_vad_onset_keeps_the_full_weak_prefix(self):
        capture = SpeechCapture(silence=.45)
        for _ in range(60):
            capture.feed(SILENCE, 20, .01)
        for _ in range(28):  # 896 ms masked first words before VAD triggers.
            capture.feed(FRAME, 90, .12)
        for _ in range(8):
            capture.feed(FRAME, 1000, .9)
        chunks = [capture.feed(SILENCE, 0, .01) for _ in range(32)]
        chunk = next(c for c in chunks if c and c.pcm)
        self.assertIn(FRAME * 28, chunk.pcm)
        self.assertGreater(chunk.pre_roll_seconds, 1)

    def test_weaker_masked_syllables_continue_only_an_existing_utterance(self):
        capture = SpeechCapture(silence=.45)
        for _ in range(100):
            self.assertIsNone(capture.feed(FRAME, 1000, .25))
        self.assertFalse(capture.active)
        for _ in range(4):
            capture.feed(FRAME, 1000, .9)
        for _ in range(30):
            self.assertIsNone(capture.feed(FRAME, 80, .25))
        self.assertTrue(capture.active)

    def test_active_voice_does_not_teach_the_noise_floor(self):
        capture = SpeechCapture(silence=2)
        for _ in range(4):
            capture.feed(FRAME, 1000, .9)
        noise = capture.floor.noise
        for _ in range(10):
            capture.feed(FRAME, 4000, .01)
        self.assertEqual(capture.floor.noise, noise)


try:
    importlib.metadata.version("pyrnnoise")
    HAS_RNNOISE = True
except importlib.metadata.PackageNotFoundError:
    HAS_RNNOISE = False


@unittest.skipUnless(HAS_RNNOISE, "Optional server-only RNNoise library not installed")
class NativeDenoiserTests(unittest.TestCase):
    def test_arbitrary_usb_chunks_preserve_original_pcm_and_alignment(self):
        noise = RNNoise()
        try:
            pcm = np.random.default_rng(9).integers(-3000, 3000, 480 * 10, dtype=np.int16).astype("<i2").tobytes()
            pairs = []
            for index in range(0, len(pcm), 512):
                pairs.extend(noise.frames(pcm[index:index + 512]))
            self.assertEqual(b"".join(raw for raw, _ in pairs), pcm)
            self.assertTrue(all(len(raw) == len(clean) == 960 for raw, clean in pairs))
            noise.reset()
            self.assertEqual(len(noise.buffer), 0)
        finally:
            noise.close()

    def test_dual_path_vad_never_changes_original_stt_pcm(self):
        detector = SpeechDetector(denoise="rnnoise")
        try:
            source = bytes(48000 * 2)
            rows = list(detector.frames(source))
            self.assertEqual(len(rows), 31)
            self.assertEqual(b"".join(raw for raw, _, _ in rows), source[:31 * FRAME_SAMPLES * 2])
            self.assertTrue(all(0 <= probability < .15 for _, _, probability in rows))
            detector.reset()
            self.assertEqual(list(detector.frames(bytes(512))), [])
        finally:
            detector.close()


if __name__ == "__main__":
    unittest.main()
