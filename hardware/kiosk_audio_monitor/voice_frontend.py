"""Local speech detection and revision-aware turn assembly, without order tools."""

from collections import deque
from dataclasses import dataclass, field
import hashlib
import json
import math
from pathlib import Path
import threading
import uuid

import numpy as np

RATE = 48000
FRAME_SAMPLES = 1536  # 32 ms, matching 512 Silero samples at 16 kHz.
FRAME_SECONDS = FRAME_SAMPLES / RATE


class Silero:
    def __init__(self, input_gain=8):
        if not math.isfinite(input_gain) or not 1 <= input_gain <= 32:
            raise ValueError("VAD input gain must be between 1 and 32")
        self.input_gain = input_gain
        import onnxruntime as ort
        folder = Path(__file__).with_name("models")
        manifest = json.loads((folder / "manifest.json").read_text())
        entry = manifest["files"][0]
        model = folder / entry["file"]
        if hashlib.sha256(model.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError("Silero 모델 해시가 맞지 않습니다.")
        options = ort.SessionOptions()
        options.inter_op_num_threads = options.intra_op_num_threads = 1
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        # Stateful low-pass FIR before 3:1 downsampling; do not alias high noise.
        t = np.arange(63) - 31
        self.fir = (2 * .145 * np.sinc(2 * .145 * t) * np.hamming(63)).astype(np.float32)
        self.fir /= self.fir.sum()
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros((1, 64), dtype=np.float32)
        self.tail = np.zeros(62, dtype=np.float32)
        self.gain = self.input_gain
        self.buffer = bytearray()

    def frames(self, pcm):
        self.buffer.extend(pcm)
        size = FRAME_SAMPLES * 2
        while len(self.buffer) >= size:
            raw = bytes(self.buffer[:size])
            del self.buffer[:size]
            samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
            extended = np.concatenate((self.tail, samples))
            filtered = np.convolve(extended, self.fir, mode="valid")[::3]
            self.tail = extended[-62:].copy()
            # The ESP mic is much quieter than normalized file fixtures. Boost
            # ONLY the model branch; keep capture PCM and RMS unchanged. Limit
            # peaks rather than clipping waveform shape for loud voices.
            target = min(self.input_gain, .9 / max(float(np.max(np.abs(filtered))), 1e-9))
            if target < self.gain:
                self.gain = target
            else:
                self.gain += (1 - math.exp(-FRAME_SECONDS / .3)) * (target - self.gain)
            filtered = filtered * self.gain
            x = np.concatenate((self.context, filtered[None]), axis=1)
            output, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": np.array(16000, dtype=np.int64)})
            self.context = x[:, -64:].copy()
            probability = float(output[0, 0])
            rms = float(np.sqrt(np.mean(samples * samples))) * 32768
            yield raw, rms, probability


class NoiseFloor:
    def __init__(self, minimum=70):
        self.minimum = minimum
        self.noise = 30.0
        self.threshold = minimum

    def update(self, rms, probability):
        # Only confidently non-speech can teach the background level. A sudden
        # clink is capped; someone's voice must not teach the gate to reject it.
        if probability < .15:
            observed = min(rms, self.noise * 3 + 100)
            tau = .7 if observed > self.noise else 2.0
            self.noise += (1 - math.exp(-FRAME_SECONDS / tau)) * (observed - self.noise)
        self.threshold = min(600, max(self.minimum, self.noise * 1.7))
        # Energy is supporting evidence, never an absolute veto. A learned
        # background floor must not force a quiet person to shout. When energy
        # exceeds that floor use a modestly lower VAD cutoff; otherwise keep the
        # ordinary VAD cutoff. The post-STT intent gate handles false candidates.
        self.probability_threshold = .3 if rms >= self.threshold else .45
        return probability >= self.probability_threshold and rms >= 10


@dataclass
class AudioChunk:
    pcm: bytes
    continuing: bool = False
    voiced_seconds: float = 0


class SpeechCapture:
    def __init__(self, *, button=False, silence=.65, maximum=12, minimum=70):
        self.button = button
        self.silence = silence
        self.maximum = maximum
        self.floor = NoiseFloor(minimum)
        self.active = False
        self.reset()

    @property
    def threshold(self):
        return self.floor.threshold

    def reset(self):
        self.active = False
        self.pre = deque(maxlen=9)  # 288 ms of first-syllable protection.
        self.onset_votes = deque(maxlen=4)
        self.pieces = []
        self.quiet = self.voiced = self.duration = self.onset = 0

    def feed(self, pcm, rms, probability, pressed=False):
        is_voice = self.floor.update(rms, probability)
        enabled = not self.button or pressed
        speaking = enabled and is_voice
        if not self.active:
            self.pre.append(pcm)
            self.onset_votes.append(speaking)
            self.onset = sum(self.onset_votes) * FRAME_SECONDS
            # Quiet phonemes can dip below VAD confidence for one 32ms frame.
            # Two of four frames preserves them without reacting to one click.
            if speaking and self.onset >= .064:
                self.active = True
                self.pieces = list(self.pre)
                self.duration = len(self.pieces) * FRAME_SECONDS
                self.voiced = self.onset
                self.pre.clear()
            return None
        self.pieces.append(pcm)
        self.duration += FRAME_SECONDS
        if speaking:
            self.voiced += FRAME_SECONDS
            self.quiet = 0
        else:
            self.quiet += FRAME_SECONDS
        ended = (self.button and not pressed) or self.quiet >= self.silence
        capped = self.duration >= self.maximum
        if not ended and not capped:
            return None
        pcm = b"".join(self.pieces)
        voiced = self.voiced
        if ended and self.quiet > .2:
            pcm = pcm[: -int((self.quiet - .2) * RATE) * 2]
        continuing = capped and not ended
        self.reset()
        if continuing:
            self.active = True  # A duration boundary is not a completed turn.
        return AudioChunk(pcm if voiced >= .096 else b"", continuing, voiced)


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    usage: dict = field(default_factory=dict)


@dataclass(frozen=True)
class Candidate:
    turn_id: str
    revision: int
    text: str
    context: dict


class TurnBuffer:
    """All slow work is outside the lock; a new syllable invalidates decisions."""

    def __init__(self, context=None, join_wait=1.4, incomplete_wait=6):
        self.context = context or {"session_active": True, "last_question": "", "scene": "카페 키오스크 음성 테스트"}
        self.join_wait = join_wait
        self.incomplete_wait = incomplete_wait
        self.lock = threading.Lock()
        self.turn = None

    def speech_started(self, now):
        with self.lock:
            if self.turn is None:
                self.turn = {"id": uuid.uuid4().hex, "revision": 0, "texts": [], "pending": set(), "sequence": 0, "failed": False, "checked": -1, "waiting": False, "waiting_reason": "", "segments": []}
            t = self.turn
            t.update(active=True, revision=t["revision"] + 1, waiting=False, last_end=now)

    def audio_finished(self, now, continuing=False):
        with self.lock:
            t = self.turn
            if t is None:
                return None
            t["sequence"] += 1
            token = (t["id"], t["sequence"])
            t["pending"].add(token)
            t.update(active=continuing, last_end=now, revision=t["revision"] + 1)
            return token

    def owns(self, token):
        with self.lock:
            return bool(self.turn and token in self.turn["pending"])

    def transcript(self, token, text, failed=False):
        with self.lock:
            t = self.turn
            if not t or token not in t["pending"]:
                return False
            t["pending"].remove(token)
            t["failed"] |= failed
            if text.strip():
                t["texts"].append(text.strip())
                t["segments"].append({"sequence": token[1], "text": text.strip()})
            t["revision"] += 1
            t["waiting"] = False
            return True

    def cancel(self):
        with self.lock:
            self.turn = None

    def poll(self, now):
        """Return a candidate or a terminal event; never call a provider here."""
        with self.lock:
            t = self.turn
            if not t or t["active"] or t["pending"] or now - t["last_end"] < self.join_wait:
                return None
            text = " ".join(t["texts"])
            if t["failed"] or len(text) > 2000 or t["sequence"] > 8:
                self.turn = None
                return ("clarify", text, "audio_or_transcription_incomplete")
            if not text:
                self.turn = None
                return ("ignore", "", "empty_transcript")
            if t["waiting"]:
                if now - t["last_end"] >= self.incomplete_wait:
                    self.turn = None
                    return ("ignore" if t["waiting_reason"] == "unclear_target" else "clarify", text, "incomplete_timeout")
                return None
            if t["checked"] == t["revision"]:
                return None
            t["checked"] = t["revision"]
            context = {**self.context, "fragments": list(t["segments"]), "speaker_identity": "unknown_single_microphone"}
            return Candidate(t["id"], t["revision"], text, context)

    def apply(self, candidate, decision, now):
        with self.lock:
            t = self.turn
            if not t or t["id"] != candidate.turn_id or t["revision"] != candidate.revision:
                return None  # Speech resumed while a provider was answering.
            if decision.action == "wait":
                if now - t["last_end"] < self.incomplete_wait:
                    t["waiting"] = True
                    t["waiting_reason"] = decision.reason
                    return ("wait", candidate.text, decision.reason)
                decision = Decision("ignore" if decision.reason == "unclear_target" else "clarify", "incomplete_timeout")
            self.turn = None
            return (decision.action, candidate.text, decision.reason)
