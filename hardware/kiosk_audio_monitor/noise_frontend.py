"""Optional server-side RNNoise branch; original PCM is preserved for STT.

Load only the native library shipped by pyrnnoise, not its file/codec wrapper.
RNNoise's 10ms frames are paired with their original samples. Two independent
Silero states see the original and enhanced streams at matching timestamps.
"""

import ctypes
import importlib.metadata
import numpy as np

from voice_frontend import Silero


class RNNoise:
    def __init__(self):
        distribution = importlib.metadata.distribution("pyrnnoise")
        paths = [distribution.locate_file(f) for f in distribution.files if f.name in {"librnnoise.so", "librnnoise.dylib", "rnnoise.dll"}]
        if len(paths) != 1:
            raise RuntimeError("RNNoise native library not found")
        self.lib = ctypes.CDLL(str(paths[0]))
        pointer = ctypes.POINTER(ctypes.c_float)
        self.lib.rnnoise_create.argtypes = [ctypes.c_void_p]
        self.lib.rnnoise_create.restype = ctypes.c_void_p
        self.lib.rnnoise_destroy.argtypes = [ctypes.c_void_p]
        self.lib.rnnoise_destroy.restype = None
        self.lib.rnnoise_process_frame.argtypes = [ctypes.c_void_p, pointer, pointer]
        self.lib.rnnoise_process_frame.restype = ctypes.c_float
        self.lib.rnnoise_get_frame_size.restype = ctypes.c_int
        if self.lib.rnnoise_get_frame_size() != 480:
            raise RuntimeError("RNNoise frame size mismatch")
        self.state = None
        self.reset()

    def reset(self):
        self.close()
        self.state = self.lib.rnnoise_create(None)
        if not self.state:
            raise RuntimeError("RNNoise state unavailable")
        self.buffer = bytearray()

    def frames(self, pcm):
        self.buffer.extend(pcm)
        while len(self.buffer) >= 960:
            original = bytes(self.buffer[:960])
            del self.buffer[:960]
            samples = np.frombuffer(original, dtype="<i2").astype(np.float32)
            peak = max(float(np.max(np.abs(samples))), 1)
            gain = min(8, 28000 / peak)
            incoming = np.ascontiguousarray(samples * gain)
            output = np.empty(480, dtype=np.float32)
            pointer = ctypes.POINTER(ctypes.c_float)
            self.lib.rnnoise_process_frame(self.state, output.ctypes.data_as(pointer), incoming.ctypes.data_as(pointer))
            enhanced = np.clip(output / gain, -32768, 32767).astype("<i2").tobytes()
            yield original, enhanced

    def close(self):
        if getattr(self, "state", None):
            self.lib.rnnoise_destroy(self.state)
            self.state = None


class SpeechDetector:
    def __init__(self, *, input_gain=8, denoise="none"):
        self.raw = Silero(input_gain=input_gain)
        self.enhanced = Silero(input_gain=input_gain) if denoise == "rnnoise" else None
        self.denoiser = RNNoise() if self.enhanced else None
        self.mode = denoise
        self.last_raw_probability = self.last_enhanced_probability = 0

    def reset(self):
        self.raw.reset()
        if self.enhanced:
            self.enhanced.reset()
            self.denoiser.reset()

    def frames(self, pcm):
        if not self.enhanced:
            for raw, rms, probability in self.raw.frames(pcm):
                self.last_raw_probability = probability
                self.last_enhanced_probability = 0
                yield raw, rms, probability
            return
        for original, enhanced in self.denoiser.frames(pcm):
            raw_frames = list(self.raw.frames(original))
            enhanced_frames = list(self.enhanced.frames(enhanced))
            if len(raw_frames) != len(enhanced_frames):
                raise RuntimeError("VAD branch alignment lost")
            for (raw, rms, raw_probability), (_, _, enhanced_probability) in zip(raw_frames, enhanced_frames):
                self.last_raw_probability, self.last_enhanced_probability = raw_probability, enhanced_probability
                # Enhancement cannot veto speech detected on the original path.
                yield raw, rms, max(raw_probability, enhanced_probability)

    def close(self):
        if self.denoiser:
            self.denoiser.close()
