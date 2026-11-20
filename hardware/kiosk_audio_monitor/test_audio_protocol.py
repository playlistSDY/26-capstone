import struct
import unittest
import zlib

from audio_protocol import FrameDecoder, HEADER, MAGIC, SAMPLE_RATE
import numpy as np

from audio_playback import AudioProcessor, PlaybackBuffer


def packet(sequence=1, pressed=True, pcm=struct.pack('<4h', -32768, -1, 0, 32767)):
    return HEADER.pack(MAGIC, SAMPLE_RATE, len(pcm) // 2, 3 if pressed else 2,
                       1, sequence, zlib.crc32(pcm)) + pcm


class DecoderTests(unittest.TestCase):
    def test_fragmented_packet_after_boot_messages(self):
        decoder = FrameDecoder()
        frames = []
        wire = b'ESP-ROM boot messages\r\n' + packet()
        for byte in wire:
            frames.extend(decoder.feed(bytes([byte])))
        self.assertEqual(len(frames), 1)
        self.assertTrue(frames[0].pressed)
        self.assertEqual(struct.unpack('<4h', frames[0].pcm), (-32768, -1, 0, 32767))

    def test_multiple_packets_and_release(self):
        frames = FrameDecoder().feed(packet(5) + packet(6, False))
        self.assertEqual([(f.sequence, f.pressed) for f in frames], [(5, True), (6, False)])

    def test_crc_failure_resynchronizes(self):
        damaged = bytearray(packet())
        damaged[-1] ^= 0x80
        decoder = FrameDecoder()
        frames = decoder.feed(damaged + packet(2))
        self.assertEqual([f.sequence for f in frames], [2])
        self.assertGreater(decoder.bad_frames, 0)

    def test_invalid_header_resynchronizes(self):
        invalid = HEADER.pack(MAGIC, 16000, 4, 3, 1, 0, 0)
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(invalid + packet())[0].sequence, 1)
        self.assertEqual(decoder.bad_frames, 1)

    def test_noise_is_bounded(self):
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(b'x' * 100000), [])
        self.assertLess(len(decoder.buffer), len(MAGIC))


class BufferTests(unittest.TestCase):
    def test_waits_for_prebuffer(self):
        buffer = PlaybackBuffer(1)
        buffer.put(np.full(256, 12000, dtype='<i2').tobytes())
        self.assertEqual(buffer.take(960), bytes(960))
        self.assertEqual(buffer.underruns, 0)
        self.assertEqual(len(buffer.data), 512)

    def test_underrun_fades_and_rebuffers(self):
        buffer = PlaybackBuffer(1, startup_ms=0)
        buffer.put(np.full(480, 12000, dtype='<i2').tobytes())
        first = np.frombuffer(buffer.take(960), dtype='<i2')
        self.assertEqual(first[0], 0)
        self.assertEqual(first[-1], 12000)
        tail = np.frombuffer(buffer.take(960), dtype='<i2')
        self.assertEqual(tail[0], first[-1])
        self.assertEqual(tail[-1], 0)
        self.assertLess(np.max(np.abs(np.diff(tail.astype(int)))), 100)
        self.assertEqual(buffer.underruns, 1)
        self.assertEqual(buffer.take(960), bytes(960))
        self.assertEqual(buffer.underruns, 1)

    def test_overflow_keeps_recent_audio(self):
        buffer = PlaybackBuffer(1)
        data = bytes(range(256)) * 100
        buffer.put(data)
        self.assertEqual(bytes(buffer.data), data[-buffer.max_bytes:])
        self.assertGreater(buffer.dropped_frames, 0)

    def test_regular_jitter_does_not_starve(self):
        buffer = PlaybackBuffer(2)
        pcm = bytes(256 * 4)
        # Preload 60 ms, then deliver 8 packets every ~43ms as USB batches.
        for _ in range(12):
            buffer.put(pcm)
        for tick in range(200):
            if tick % 4 == 0:
                for _ in range(8):
                    buffer.put(pcm)
            self.assertEqual(len(buffer.take(480 * 4)), 480 * 4)
        self.assertEqual(buffer.underruns, 0)


class ProcessingTests(unittest.TestCase):
    def test_speech_band_is_preserved(self):
        processor = AudioProcessor()
        source = (np.sin(np.arange(48000) * 2 * np.pi * 997 / SAMPLE_RATE) * 8000).astype('<i2')
        result = processor.process(source.tobytes(), True)
        ratio = np.sqrt(np.mean(result[-4800:].astype(float)**2)) / np.sqrt(np.mean(source[-4800:].astype(float)**2))
        self.assertGreater(ratio, 0.97)
        self.assertLess(ratio, 1.02)

    def test_dc_offset_is_removed(self):
        processor = AudioProcessor()
        pcm = np.full(48000, 10000, dtype='<i2').tobytes()
        result = processor.process(pcm, True)
        self.assertLess(np.max(np.abs(result[-480:])), 2)

    def test_button_release_has_smooth_envelope(self):
        processor = AudioProcessor()
        # Hold the high-pass state at steady zero-DC; a 1kHz tone remains audible.
        phase = np.arange(480) * 2 * np.pi * 1000 / SAMPLE_RATE
        pcm = (np.sin(phase) * 10000).astype('<i2').tobytes()
        for _ in range(10):
            processor.process(pcm, True)
        result = processor.process(pcm, False)
        self.assertGreater(np.max(np.abs(result[:120])), 1000)
        self.assertTrue(np.all(result[240:] == 0))
        self.assertEqual(processor.level, 0)

    def test_fades_span_small_packets(self):
        processor = AudioProcessor()
        pcm = np.full(60, 10000, dtype='<i2').tobytes()
        processor.process(pcm, True)
        self.assertAlmostEqual(processor.level, 0.25)
        processor.process(pcm, True)
        self.assertAlmostEqual(processor.level, 0.5)
        processor.process(pcm, False)
        self.assertAlmostEqual(processor.level, 0.25)

    def test_gain_reports_clipping_without_integer_wrap(self):
        processor = AudioProcessor(gain=20)
        pcm = (np.sin(np.arange(4800) * 0.13) * 30000).astype('<i2').tobytes()
        result = processor.process(pcm, True)
        self.assertGreater(processor.clipped, 0)
        self.assertEqual(result.max(), 32767)
        self.assertEqual(result.min(), -32768)


if __name__ == '__main__':
    unittest.main()
