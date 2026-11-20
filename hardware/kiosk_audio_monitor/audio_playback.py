"""Small jitter buffer and click-free monitoring of mono PCM."""

import math
import threading

import numpy as np

from audio_protocol import SAMPLE_RATE


class PlaybackBuffer:
    def __init__(self, channels, startup_ms=60, max_ms=240, fade_ms=5):
        self.channels = channels
        self.bytes_per_frame = channels * 2
        self.start_bytes = int(SAMPLE_RATE * startup_ms / 1000) * self.bytes_per_frame
        self.max_bytes = int(SAMPLE_RATE * max_ms / 1000) * self.bytes_per_frame
        self.fade_frames = max(1, int(SAMPLE_RATE * fade_ms / 1000))
        self.data = bytearray()
        self.lock = threading.Lock()
        self.running = False
        self.crossfade = True
        self.last = np.zeros(channels, dtype=np.float32)
        self.underruns = 0
        self.dropped_frames = 0

    def put(self, data):
        if len(data) % self.bytes_per_frame:
            raise ValueError("PCM data must contain complete audio frames")
        with self.lock:
            self.data.extend(data)
            excess = len(self.data) - self.max_bytes
            if excess > 0:
                del self.data[:excess]
                self.dropped_frames += excess // self.bytes_per_frame
                self.crossfade = True

    def take(self, size):
        if size % self.bytes_per_frame:
            raise ValueError("Output must contain complete audio frames")
        frames = size // self.bytes_per_frame
        if not frames:
            return b""
        result = np.zeros((frames, self.channels), dtype=np.float32)
        with self.lock:
            if not self.running:
                if len(self.data) < max(self.start_bytes, size):
                    return bytes(size)
                self.running = True
                self.crossfade = True
            count = min(frames, len(self.data) // self.bytes_per_frame)
            if count:
                used = count * self.bytes_per_frame
                result[:count] = np.frombuffer(bytes(self.data[:used]), dtype="<i2").reshape(-1, self.channels)
                del self.data[:used]
                if self.crossfade:
                    n = min(count, self.fade_frames)
                    ramp = np.linspace(0, 1, n)[:, None]
                    result[:n] = self.last * (1 - ramp) + result[:n] * ramp
                    self.crossfade = False
            if count < frames:
                self.underruns += 1
                self.running = False
                if count:
                    n = min(count, self.fade_frames)
                    result[count-n:count] *= np.linspace(1, 0, n)[:, None]
                else:
                    n = min(frames, self.fade_frames)
                    result[:n] = self.last * np.linspace(1, 0, n)[:, None]
            self.last = result[-1].copy()
        return np.clip(result, -32768, 32767).astype("<i2").tobytes()


class AudioProcessor:
    def __init__(self, gain=1.0):
        self.gain = gain
        self.previous_input = 0.0
        self.previous_output = 0.0
        self.pole = math.exp(-2 * math.pi * 70 / SAMPLE_RATE)
        self.level = 0.0
        self.fade_samples = int(SAMPLE_RATE * 0.005)
        self.clipped = 0

    def process(self, pcm, enabled):
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        if not len(samples):
            return samples
        # Continuous DC blocking also runs while the button is released.
        previous_input, previous_output = self.previous_input, self.previous_output
        for i, sample in enumerate(samples):
            value = float(sample)
            previous_output = value - previous_input + self.pole * previous_output
            previous_input = value
            samples[i] = previous_output
        self.previous_input, self.previous_output = previous_input, previous_output
        target = 1.0 if enabled else 0.0
        direction = 1 if target > self.level else -1 if target < self.level else 0
        envelope = np.clip(self.level + direction * np.arange(1, len(samples)+1) / self.fade_samples, 0, 1)
        self.level = float(envelope[-1])
        samples *= envelope * self.gain
        self.clipped += int(np.count_nonzero((samples > 32767) | (samples < -32768)))
        return np.clip(samples, -32768, 32767).astype("<i2")
