"""Repeatable offline VAD checks; synthetic noise is not a cafe field test."""

import argparse
import json
from pathlib import Path
import subprocess
import time
import wave

import numpy as np

from audio_playback import AudioProcessor
from serial_stt import Utterances
from voice_frontend import Silero, SpeechCapture, FRAME_SAMPLES, FRAME_SECONDS

ROOT = Path(__file__).resolve().parents[2]


def read_wav(path):
    with wave.open(str(path), "rb") as audio:
        if (audio.getframerate(), audio.getsampwidth(), audio.getnchannels()) != (48000, 2, 1):
            raise ValueError("48kHz 16bit 모노 WAV가 필요합니다.")
        return np.frombuffer(audio.readframes(audio.getnframes()), dtype="<i2").astype(float)


def normalize(samples, rms=1000):
    return samples * rms / max(float(np.sqrt(np.mean(samples ** 2))), 1e-9)


def evaluate(vad, name, samples, has_speech):
    vad.reset()
    detector, baseline = SpeechCapture(), Utterances(threshold=220)
    processor = AudioProcessor()
    starts = old_starts = chunks = 0
    durations = []
    peak_probability = 0
    thresholds = []
    pcm = np.clip(samples, -32768, 32767).astype("<i2").tobytes()
    for i in range(0, len(pcm), FRAME_SAMPLES * 2):
        raw = processor.process(pcm[i:i + FRAME_SAMPLES * 2], True).tobytes()
        began = time.perf_counter()
        frames = list(vad.frames(raw))
        durations.append((time.perf_counter() - began) * 1000)
        for frame, rms, probability in frames:
            active, old_active = detector.active, baseline.active
            chunk = detector.feed(frame, rms, probability)
            baseline.feed(frame, rms)
            starts += int(not active and detector.active)
            old_starts += int(not old_active and baseline.active)
            chunks += int(chunk is not None and bool(chunk.pcm))
            peak_probability = max(peak_probability, probability)
            thresholds.append(detector.threshold)
    return {"case": name, "synthetic": True, "contains_speech": has_speech, "seconds": round(len(samples) / 48000, 2), "energy_only_candidate_starts": old_starts, "silero_candidate_starts": starts, "stt_chunks": chunks, "peak_speech_probability": round(peak_probability, 3), "dynamic_threshold_range": [round(min(thresholds)), round(max(thresholds))], "inference_ms_p50": round(float(np.percentile(durations, 50)), 3), "inference_ms_p95": round(float(np.percentile(durations, 95)), 3)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--speech-wav", type=Path, help="실제 발화로 교체할 48kHz 모노 WAV")
    parser.add_argument("--noise-wav", type=Path, help="합성 소음 대신 혼합할 실제 현장 소음 WAV")
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/voice-gate/noise-check.json")
    args = parser.parse_args()
    folder = args.output.parent
    folder.mkdir(parents=True, exist_ok=True)
    if args.speech_wav:
        speech = read_wav(args.speech_wav)
    else:
        aiff, wav = folder / "synthetic.aiff", folder / "synthetic.wav"
        try:
            subprocess.run(["say", "-v", "Yuna", "-r", "155", "-o", str(aiff), "아이스 아메리카노 한 잔 주세요. 아니 두 잔 주세요."], check=True)
            subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@48000", "-c", "1", str(aiff), str(wav)], check=True)
            speech = read_wav(wav)
        finally:
            aiff.unlink(missing_ok=True)
            wav.unlink(missing_ok=True)
    speech = normalize(speech)
    rng = np.random.default_rng(20261122)
    n = 48000 * 8
    t = np.arange(n) / 48000
    white = normalize(rng.normal(size=n))
    spectrum = np.fft.rfft(rng.normal(size=n))
    spectrum /= np.sqrt(np.maximum(np.fft.rfftfreq(n, 1 / 48000), 30))
    pink = normalize(np.fft.irfft(spectrum, n=n))
    fan = normalize(np.sin(2 * np.pi * 120 * t) + .4 * np.sin(2 * np.pi * 240 * t) + .25 * white / 1000)
    impacts = np.zeros(n)
    for onset in [1, 2.3, 4.1, 6]:
        length = 960
        impacts[int(onset * 48000):int(onset * 48000) + length] = rng.normal(size=length) * np.exp(-np.arange(length) / 180) * 7000
    cases = [("silence", np.zeros(n), False), ("white_noise", white, False), ("pink_noise", pink, False), ("fan_hum", fan, False), ("clinks", impacts, False)]
    noise = read_wav(args.noise_wav) if args.noise_wav else pink
    for gain in [.2, 1]:
        cases.append((f"speech_level_{gain}", np.pad(speech * gain, (96000, 96000)), True))
    for speed in [.8, 1.2]:
        shifted = np.interp(np.arange(0, len(speech), speed), np.arange(len(speech)), speech)
        cases.append((f"synthetic_pitch_and_rate_{speed}", np.pad(shifted, (96000, 96000)), True))
    for snr in [20, 10, 5, 0, -5]:
        clean = np.pad(speech, (96000, 96000))
        bed = normalize(np.resize(noise, len(clean)), 1000 / 10 ** (snr / 20))
        cases.append((f"speech_noise_snr_{snr}dB", clean + bed, True))
    vad = Silero()
    rows = [evaluate(vad, name, samples, label) for name, samples, label in cases]
    report = {"method": "synthetic speech/noise mixing unless WAV paths supplied", "physicalCafeFieldTested": False, "speechSource": str(args.speech_wav) if args.speech_wav else "macOS Yuna synthesized speech", "noiseSource": str(args.noise_wav) if args.noise_wav else "seeded synthetic noise", "STTOrSemanticAPIsCalled": False, "cases": rows}
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for row in rows:
        print(f"{row['case']:<32} energy starts={row['energy_only_candidate_starts']}  VAD starts={row['silero_candidate_starts']}  STT chunks={row['stt_chunks']}  p95={row['inference_ms_p95']}ms")
    print("Report:", args.output)
    assert all(row["silero_candidate_starts"] == 0 for row in rows if not row["contains_speech"]), "비음성 오탐: 결과를 확인하고 조정하세요."
    assert all(row["stt_chunks"] >= 1 for row in rows if row["case"].startswith("speech_level_")), "깨끗한 작은/보통 발화 누락"


if __name__ == "__main__":
    main()
