"""Generate SWitch's local kiosk tones and a listening preview."""

import hashlib
import json
from pathlib import Path
import wave

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "public/assets/sounds/v2"
RATE = 48000


def tone(start_hz, seconds, end_hz=None, gain=1):
    time = np.arange(round(seconds * RATE)) / RATE
    end_hz = start_hz if end_hz is None else end_hz
    sweep = (end_hz - start_hz) / seconds
    phase = 2 * np.pi * (start_hz * time + 0.5 * sweep * time**2)

    attack = np.clip(time / 0.008, 0, 1)
    release = np.clip((time[-1] - time) / min(0.035, seconds * 0.55), 0, 1)
    envelope = np.sin(attack * np.pi / 2)**2 * np.sin(release * np.pi / 2)**2
    waveform = np.sin(phase) + 0.08 * np.sin(2 * phase) + 0.015 * np.sin(3 * phase)
    return gain * waveform * envelope


def sequence(*parts):
    length = max(round(offset * RATE) + len(signal) for offset, signal in parts)
    samples = np.zeros(length + round(0.012 * RATE))
    for offset, signal in parts:
        start = round(offset * RATE)
        samples[start : start + len(signal)] += signal
    return samples


def write_wave(path, samples):
    pcm = np.round(samples * 32767).astype("<i2")
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm.tobytes())


# Maximum sample amplitudes at full volume. Routine navigation stays below
# the card-reader, confirmation and error cues.
sounds = {
    "tap": ("기본 터치", 0.40, sequence((0, tone(490, 0.065, 395)))),
    "select": ("메뉴·옵션 선택", 0.42, sequence((0, tone(525, 0.083, 570)))),
    "add": (
        "메뉴 담기",
        0.48,
        sequence((0, tone(480, 0.085, gain=0.7)), (0.066, tone(635, 0.112))),
    ),
    "increase": ("수량 증가", 0.36, sequence((0, tone(545, 0.063, 655)))),
    "decrease": ("수량 감소", 0.35, sequence((0, tone(530, 0.072, 426)))),
    "back": ("이전·취소", 0.36, sequence((0, tone(440, 0.096, 345)))),
    "remove": ("메뉴 삭제", 0.40, sequence((0, tone(370, 0.111, 285)))),
    "scroll": ("목록 스크롤", 0.22, sequence((0, tone(420, 0.049, 370)))),
    "read": ("카드 인식", 0.49, sequence((0, tone(670, 0.112)))),
    "success": (
        "주문 완료",
        0.58,
        sequence((0, tone(523.25, 0.147, gain=0.72)), (0.113, tone(659.25, 0.193))),
    ),
    "error": (
        "오류 안내",
        0.52,
        sequence((0, tone(349.23, 0.115)), (0.146, tone(293.66, 0.143, gain=0.82))),
    ),
    "print": ("출력 알림", 0.43, sequence((0, tone(605, 0.123, 550)))),
}

DEST.mkdir(parents=True, exist_ok=True)
metadata = []
preview = []
for key, (label, target_peak, samples) in sounds.items():
    samples = samples * target_peak / np.max(np.abs(samples))
    file = DEST / f"{key}.wav"
    write_wave(file, samples)

    spectrum = np.abs(np.fft.rfft(samples))
    frequencies = np.fft.rfftfreq(len(samples), 1 / RATE)
    rms = float(np.sqrt(np.mean(samples**2)))
    metadata.append({
        "id": key,
        "label": label,
        "file": file.name,
        "durationMs": round(len(samples) / RATE * 1000),
        "peak": target_peak,
        "rmsDbFS": round(float(20 * np.log10(rms)), 2),
        "spectralCentroidHz": round(float(np.sum(spectrum * frequencies) / np.sum(spectrum))),
        "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
    })
    preview.extend([samples * 0.75, np.zeros(round(0.4 * RATE))])

manifest = {
    "pack": "switch-original-sfx-v2",
    "sampleRate": RATE,
    "channels": 1,
    "license": "Original audio generated for SWitch; project use permitted.",
    "sounds": metadata,
}
(DEST / "manifest.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)

preview_path = ROOT.parent / "output/audio/SWitch-SFX-Preview.wav"
preview_path.parent.mkdir(parents=True, exist_ok=True)
write_wave(preview_path, np.concatenate(preview))

qa_path = ROOT / "qa/sound-pack.json"
qa_path.parent.mkdir(parents=True, exist_ok=True)
qa_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Wrote {len(metadata)} tones and listening preview: {preview_path}")
