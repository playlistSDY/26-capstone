"""ESP32 serial PCM -> bounded utterances -> Korean text in the terminal."""

import argparse
from collections import deque
import io
import json
import math
import os
from pathlib import Path
import queue
import signal
import threading
import time
import wave

import numpy as np

from audio_protocol import FrameDecoder, SAMPLE_RATE
from audio_playback import AudioProcessor

ROOT = Path(__file__).resolve().parents[2]


def load_environment(path):
    """Read task-local configuration as data, never as shell instructions."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and key in {"OPENAI_API_KEY", "OPENAI_STT_MODEL"}:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key, value)


def wav_bytes(pcm):
    """Keep audio only in memory; modest gain for a quiet near-field mic."""
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
    peak = float(np.max(np.abs(samples))) if len(samples) else 0
    if peak:
        samples *= min(8, 26000 / peak)
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(SAMPLE_RATE)
        audio.writeframes(np.clip(samples, -32768, 32767).astype("<i2").tobytes())
    return output.getvalue()


class Utterances:
    """Simple energy endpointing for the CLI, not a production speech VAD."""

    def __init__(self, *, button=False, threshold=220, silence=.8, maximum=15):
        self.button = button
        self.minimum_threshold = threshold
        self.threshold = threshold
        self.silence_limit = silence
        self.maximum = maximum
        self.noise = threshold / 4
        self.history = deque()
        self.history_seconds = 0
        self.reset()

    def reset(self):
        self.active = False
        self.pieces = []
        self.duration = self.voiced = self.quiet = self.candidate = 0
        self.history.clear()
        self.history_seconds = 0

    def feed(self, pcm, rms, pressed=False):
        duration = len(pcm) / (2 * SAMPLE_RATE)
        loud = rms >= self.threshold
        speaking = pressed if self.button else loud
        if not self.active:
            self.history.append(pcm)
            self.history_seconds += duration
            while self.history_seconds > .25 + duration:
                self.history_seconds -= len(self.history.popleft()) / (2 * SAMPLE_RATE)
            self.candidate = self.candidate + duration if speaking else 0
            if not self.button and not speaking:
                self.noise = .995 * self.noise + .005 * rms
                self.threshold = max(self.minimum_threshold, self.noise * 3)
            if speaking and (self.button or self.candidate >= .04):
                self.active = True
                self.pieces = list(self.history)
                self.duration = self.history_seconds
                self.voiced = self.candidate
                self.history.clear()
                self.history_seconds = 0
            return None
        self.pieces.append(pcm)
        self.duration += duration
        if speaking:
            self.voiced += duration
            self.quiet = 0
        else:
            self.quiet += duration
        done = (not pressed if self.button else self.quiet >= self.silence_limit)
        if not done and self.duration < self.maximum:
            return None
        result = b"".join(self.pieces) if self.voiced >= .12 else None
        if result and self.quiet > .2:
            trim = int((self.quiet - .2) * SAMPLE_RATE) * 2
            result = result[:-trim] if trim else result
        self.reset()
        return result


class Display:
    def __init__(self, log=None):
        self.lock = threading.Lock()
        self.log = log
        if log:
            log.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, kind, message, **fields):
        with self.lock:
            print(message, flush=True)
            if self.log:
                with self.log.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"time": time.time(), "event": kind, **fields}, ensure_ascii=False) + "\n")


def transcribe(client, model, pcm):
    hints = {"languages": ["ko"]} if model == "gpt-transcribe" else {}
    legacy = {"language": "ko"} if model != "gpt-transcribe" else {}
    result = client.audio.transcriptions.create(
        model=model,
        file=("speech.wav", wav_bytes(pcm), "audio/wav"),
        extra_body=hints,
        **legacy,
    )
    return result.text.strip()


def main():
    import serial
    from serial.tools import list_ports
    from openai import OpenAI

    parser = argparse.ArgumentParser(description="ESP32 마이크 한국어 STT (Ctrl+C 종료)")
    parser.add_argument("--port")
    parser.add_argument("--button", action="store_true", help="버튼을 누른 동안만 수음하고 놓으면 인식")
    parser.add_argument("--threshold", type=float, default=220, help="자동 모드 최소 RMS 문턱, 기본 220")
    parser.add_argument("--silence", type=float, default=.8, help="발화 종료 무음 시간(초)")
    parser.add_argument("--model", help="기본 OPENAI_STT_MODEL 또는 gpt-transcribe")
    parser.add_argument("--env", type=Path, default=ROOT / "order-agent/.env")
    parser.add_argument("--event-log", type=Path, help="선택: 상태·인식 텍스트를 로컬 JSONL에 기록, 원음 제외")
    parser.add_argument("--probe-seconds", type=float, default=0, help="API 호출 없이 수음 수치만 확인 후 종료")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if not math.isfinite(args.threshold) or not 10 <= args.threshold <= 10000:
        parser.error("--threshold는 10~10000 사이여야 합니다.")
    if not math.isfinite(args.silence) or not .25 <= args.silence <= 3:
        parser.error("--silence는 .25~3초 사이여야 합니다.")
    if not math.isfinite(args.probe_seconds) or not 0 <= args.probe_seconds <= 60:
        parser.error("--probe-seconds는 0~60초 사이여야 합니다.")
    ports = list(list_ports.comports())
    if args.list:
        for port in ports:
            print(f"{port.device}: {port.description}")
        return 0
    if not args.port:
        matches = [p.device for p in ports if p.vid == 0x303A]
        if len(matches) != 1:
            parser.error("ESP32 한 대를 연결하거나 --port로 지정해 주세요.")
        args.port = matches[0]
    load_environment(args.env)
    if not args.probe_seconds and not os.environ.get("OPENAI_API_KEY"):
        parser.error("order-agent/.env 또는 환경변수에 OPENAI_API_KEY가 필요합니다.")
    model = args.model or os.environ.get("OPENAI_STT_MODEL", "gpt-transcribe")
    display = Display(args.event_log)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    client = None if args.probe_seconds else OpenAI(timeout=25, max_retries=0)
    pending = queue.Queue(maxsize=2)

    def recognize():
        while not stopped.is_set():
            try:
                pcm = pending.get(timeout=.1)
            except queue.Empty:
                continue
            started = time.monotonic()
            display.emit("recognizing", "\n… 음성을 글자로 바꾸는 중", seconds=round(len(pcm) / 96000, 2))
            try:
                text = transcribe(client, model, pcm)
                if not stopped.is_set():
                    elapsed = round(time.monotonic() - started, 2)
                    display.emit("transcript", f"\n  인식 결과 > {text or '(인식된 말 없음)'}\n  처리 {elapsed}초\n", text=text, elapsed=elapsed)
            except Exception as error:
                # Never print response bodies or request headers containing credentials.
                display.emit("stt_error", f"STT 실패: {type(error).__name__} (HTTP {getattr(error, 'status_code', '?')}). 다음 발화를 기다립니다.", error=type(error).__name__, status=getattr(error, "status_code", None))
            finally:
                pending.task_done()

    worker = threading.Thread(target=recognize, daemon=True)
    decoder = FrameDecoder()
    processor = AudioProcessor()
    utterances = Utterances(button=args.button, threshold=args.threshold, silence=args.silence)
    packets = gaps = 0
    previous = None
    began = last_valid = last_status = time.monotonic()
    link = serial.Serial(port=None, baudrate=921600, timeout=.05, exclusive=os.name != "nt")
    # Native USB/JTAG: do not assert RTS and DTR together and reset the board.
    link.dtr = True
    link.rts = False
    link.port = args.port
    try:
        link.open()
        if os.name == "posix":
            import fcntl
            import termios
            # Also block programs that do not cooperate with pySerial's flock.
            fcntl.ioctl(link.fileno(), termios.TIOCEXCL)
        link.reset_input_buffer()
        warmup_end = time.monotonic() + .3
        if client:
            worker.start()
        mode = "버튼을 누르고 말한 뒤 놓아 주세요" if args.button else "버튼 없이 말해 주세요. 말을 멈추면 자동 인식합니다"
        display.emit("started", f"\nSWitch ESP32 마이크 → 한국어 STT\n포트: {args.port}\n모델: {model}\n{mode}\nSTT는 OpenAI로 전송합니다. 원본 녹음은 저장하지 않습니다.\n종료: Ctrl+C\n", port=args.port, model=model)
        while not stopped.is_set():
            try:
                data = link.read(max(1, min(link.in_waiting, 8192)))
            except serial.SerialException:
                # The macOS USB/JTAG driver can report a transient empty read
                # while the ESP starts after DTR. Never hide a later disconnect.
                if not packets and time.monotonic() - began < 2:
                    time.sleep(.05)
                    continue
                raise
            for frame in decoder.feed(data):
                last_valid = time.monotonic()
                if last_valid < warmup_end:
                    continue  # Drain stale USB packets before measuring gaps.
                if not packets:
                    display.emit("ready", "✓ USB 음성 수신 중. 이제 말씀해 주세요.")
                packets += 1
                if previous is not None:
                    delta = (frame.sequence - previous) & 0xFFFFFFFF
                    if 1 < delta < 0x80000000:
                        gaps += delta - 1
                        # Discard incomplete speech after a long USB interruption.
                        if delta > 48:
                            utterances.reset()
                previous = frame.sequence
                samples = processor.process(frame.pcm, True)
                rms = float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
                was_active = utterances.active
                pcm = utterances.feed(samples.tobytes(), rms, frame.pressed)
                if utterances.active and not was_active and client:
                    display.emit("speech_started", "\n● 수음 중…")
                if pcm and client:
                    try:
                        pending.put_nowait(pcm)
                    except queue.Full:
                        display.emit("busy", "인식이 밀려 이번 발화는 건너뛰었어요. 잠시 후 다시 말씀해 주세요.")
                if last_valid - last_status >= 1:
                    bar = "█" * min(24, int(rms / max(utterances.threshold, 1) * 6))
                    display.emit("level", f"마이크 {bar:<24} RMS {rms:6.0f} / 문턱 {utterances.threshold:.0f} / BTN {int(frame.pressed)} / 누락 {gaps} / CRC {decoder.bad_frames}", rms=round(rms), threshold=round(utterances.threshold), packets=packets, gaps=gaps, bad=decoder.bad_frames)
                    last_status = last_valid
            if time.monotonic() - last_valid > 5:
                raise RuntimeError("5초 동안 유효한 PCM이 없습니다. 오디오 전송 스케치와 USB 연결을 확인해 주세요.")
            if args.probe_seconds and time.monotonic() - began >= args.probe_seconds:
                display.emit("probe", f"수음 확인 완료: 패킷 {packets}, 누락 {gaps}, CRC 오류 {decoder.bad_frames}", packets=packets, gaps=gaps, bad=decoder.bad_frames)
                break
    except KeyboardInterrupt:
        pass
    finally:
        stopped.set()
        link.close()
        if worker.is_alive():
            worker.join(timeout=.5)
        if client and not worker.is_alive():
            client.close()
        display.emit("stopped", "\n수음과 STT를 종료했습니다. USB 포트를 해제했어요.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"연결 오류: {type(error).__name__}: {error}", flush=True)
        print("Arduino 시리얼 모니터·기존 마이크 듣기를 닫고 USB 연결을 확인해 주세요.", flush=True)
        raise SystemExit(1)
