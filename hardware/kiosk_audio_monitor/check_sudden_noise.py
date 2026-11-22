"""Synthetic abrupt-noise regression. No microphone, STT or gate API calls."""
import argparse
import json
from pathlib import Path
import time

import numpy as np

from audio_playback import AudioProcessor
from check_voice_noise import normalize, read_wav
from noise_frontend import SpeechDetector
from voice_frontend import FRAME_SECONDS, FRAME_SAMPLES, SpeechCapture


def evaluate(mode, samples, onset):
    detector = SpeechDetector(denoise=mode)
    capture = SpeechCapture(silence=.45)
    processor = AudioProcessor()
    start_at = None
    chunks, timings = [], []
    frame_index = 0
    try:
        pcm = np.clip(samples, -32768, 32767).astype("<i2").tobytes()
        for offset in range(0, len(pcm), 512):
            raw = processor.process(pcm[offset:offset + 512], True).tobytes()
            begin = time.perf_counter()
            for frame, rms, probability in detector.frames(raw):
                active = capture.active
                chunk = capture.feed(frame, rms, probability)
                if not active and capture.active and start_at is None:
                    start_at = frame_index * FRAME_SECONDS - capture.pre_roll_seconds
                if chunk and chunk.pcm:
                    chunks.append(chunk)
                frame_index += 1
            timings.append(time.perf_counter() - begin)
        return {"mode": mode, "detected": bool(chunks), "first_capture_start_seconds": None if start_at is None else round(start_at, 3), "prefix_missing_ms": None if start_at is None or onset is None else round(max(0, start_at - onset) * 1000), "segments": len(chunks), "cpu_processing_seconds": round(sum(timings), 4), "input_seconds": round(len(samples) / 48000, 2)}
    finally:
        detector.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech-wav", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=Path("tmp/voice-gate/sudden-noise.json"))
    args = parser.parse_args()
    speech = normalize(read_wav(args.speech_wav), 1000)
    clean = np.pad(speech, (96000, 96000))
    rng = np.random.default_rng(20261122)
    spectrum = np.fft.rfft(rng.normal(size=len(clean)))
    spectrum /= np.sqrt(np.maximum(np.fft.rfftfreq(len(clean), 1 / 48000), 30))
    pink = normalize(np.fft.irfft(spectrum, n=len(clean)), 1000)
    conditions = [("clean", clean, 2), ("quiet_clean", clean * .2, 2)]
    for snr in [5, 0, -5]:
        gain = np.full(len(clean), .1)
        gain[96000:96000 + len(speech)] = 10 ** (-snr / 20)
        conditions.append((f"sudden_sustained_pink_{snr}dB", clean + pink * gain, 2))
        gain[96000 + 48000: ] = .1
        conditions.append((f"sudden_first_word_pink_{snr}dB", clean + pink * gain, 2))
    noise_jump = pink * .1
    noise_jump[96000:] *= 30
    conditions.extend([("sudden_noise_only", noise_jump, None), ("steady_noise_only", pink, None), ("digital_silence", np.zeros_like(clean), None)])
    rows = []
    for name, samples, onset in conditions:
        result = {"case": name, "contains_speech": onset is not None}
        for mode in ["none", "rnnoise"]:
            result[mode] = evaluate(mode, samples, onset)
        rows.append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
    report = {"synthetic": True, "physicalCafeTested": False, "apiCalls": False, "speech": "macOS Yuna synthetic fixture", "cases": rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if any(r["rnnoise"]["detected"] for r in rows if not r["contains_speech"]):
        raise SystemExit("Noise-only false activation; do not enable the experimental path")
    if any(not r["rnnoise"]["detected"] for r in rows if r["case"] in {"clean", "quiet_clean"}):
        raise SystemExit("Clean speech regression; do not enable the experimental path")


if __name__ == "__main__":
    main()
