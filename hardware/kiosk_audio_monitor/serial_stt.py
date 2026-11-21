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
from voice_frontend import Silero, SpeechCapture, TurnBuffer, Candidate, Decision
from speech_decisions import OpenAIGate, JevGate, rules

ROOT = Path(__file__).resolve().parents[2]


def load_environment(path):
    """Read task-local configuration as data, never as shell instructions."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, separator, value = line.strip().removeprefix("export ").partition("=")
        if separator and key in {"OPENAI_API_KEY", "OPENAI_STT_MODEL", "OPENAI_MODEL", "OPENAI_FILTER_MODEL", "TYPESAFE_API_KEY"}:
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
    def __init__(self, log=None, json_events=False):
        self.lock = threading.Lock()
        self.log = log
        self.json_events = json_events
        if log:
            log.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, kind, message, **fields):
        with self.lock:
            event = {"time": time.time(), "event": kind, "message": message.strip(), **fields}
            print(json.dumps(event, ensure_ascii=False) if self.json_events else message, flush=True)
            if self.log:
                with self.log.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(event, ensure_ascii=False) + "\n")


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
    parser.add_argument("--threshold", type=float, default=70, help="동적 에너지 문턱의 최솟값. 신경망 말소리 판정과 함께 사용")
    parser.add_argument("--vad-gain", type=float, default=8, help="VAD 모델 입력만 보정하는 배율, 기본 8. 녹음·스피커 음량은 그대로")
    parser.add_argument("--silence", type=float, default=.45, help="STT 조각 분리용 무음 시간(명령 완료 아님)")
    parser.add_argument("--join-wait", type=float, default=1.0, help="추가 발화 합치기 대기(초), 의미 판단과 병렬")
    parser.add_argument("--incomplete-wait", type=float, default=6, help="미완성 문장 최대 대기(초)")
    parser.add_argument("--filter", choices=["auto", "openai", "jev", "rules", "none"], default="auto")
    parser.add_argument("--last-question", default="", help="테스트 문맥: 직전 점원의 질문")
    parser.add_argument("--model", help="기본 OPENAI_STT_MODEL 또는 gpt-transcribe")
    parser.add_argument("--env", type=Path, default=ROOT / "order-agent/.env")
    parser.add_argument("--event-log", type=Path, help="선택: 상태·인식 텍스트를 로컬 JSONL에 기록, 원음 제외")
    parser.add_argument("--json-events", action="store_true", help="웹 화면 연결용 구조화 이벤트 출력")
    parser.add_argument("--probe-seconds", type=float, default=0, help="API 호출 없이 수음 수치만 확인 후 종료")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if not math.isfinite(args.threshold) or not 10 <= args.threshold <= 10000:
        parser.error("--threshold는 10~10000 사이여야 합니다.")
    if not math.isfinite(args.vad_gain) or not 1 <= args.vad_gain <= 32:
        parser.error("--vad-gain은 1~32 사이여야 합니다.")
    if not math.isfinite(args.silence) or not .25 <= args.silence <= 3:
        parser.error("--silence는 .25~3초 사이여야 합니다.")
    if not math.isfinite(args.probe_seconds) or not 0 <= args.probe_seconds <= 60:
        parser.error("--probe-seconds는 0~60초 사이여야 합니다.")
    if not math.isfinite(args.join_wait) or not .5 <= args.join_wait <= 4:
        parser.error("--join-wait는 .5~4초 사이여야 합니다.")
    if not math.isfinite(args.incomplete_wait) or not max(2, args.join_wait) <= args.incomplete_wait <= 15:
        parser.error("--incomplete-wait는 추가 발화 대기 이상, 2~15초 사이여야 합니다.")
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
    display = Display(args.event_log, args.json_events)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    client = None if args.probe_seconds else OpenAI(timeout=25, max_retries=0)
    provider = args.filter
    if provider == "auto":
        provider = "jev" if os.environ.get("TYPESAFE_API_KEY") else "openai"
    gate = None
    if client and provider == "openai":
        gate = OpenAIGate(os.environ["OPENAI_API_KEY"], os.environ.get("OPENAI_FILTER_MODEL") or "gpt-5.6-luna")
    if client and provider == "jev":
        if not os.environ.get("TYPESAFE_API_KEY"):
            parser.error("--filter jev는 TYPESAFE_API_KEY가 필요합니다.")
        gate = JevGate(os.environ["TYPESAFE_API_KEY"], ROOT / "kiosk-web/backend/certs/cacert.pem")
    turns = TurnBuffer(context={"session_active": True, "scene": "카페 키오스크 테스트", "last_question": args.last_question[:500]}, join_wait=args.join_wait, incomplete_wait=args.incomplete_wait)
    pending = queue.Queue(maxsize=2)

    def recognize():
        while not stopped.is_set():
            try:
                token, pcm = pending.get(timeout=.1)
            except queue.Empty:
                continue
            if not turns.owns(token):
                pending.task_done()
                continue
            started = time.monotonic()
            display.emit("recognizing", "\n… 음성을 글자로 바꾸는 중", seconds=round(len(pcm) / 96000, 2), turn_id=token[0], segment=token[1])
            try:
                text = transcribe(client, model, pcm)
                elapsed = round(time.monotonic() - started, 3)
                if not stopped.is_set() and turns.transcript(token, text, now=time.monotonic(), stt_seconds=elapsed):
                    display.emit("transcript", f"\n  인식 후보 > {text or '(인식된 말 없음)'}\n  STT {elapsed}초 · 아직 에이전트에 전달하지 않음\n", text=text, elapsed=elapsed, turn_id=token[0], segment=token[1])
            except Exception as error:
                turns.transcript(token, "", failed=True)
                # Never print response bodies or request headers containing credentials.
                display.emit("stt_error", f"STT 실패: {type(error).__name__} (HTTP {getattr(error, 'status_code', '?')}). 다음 발화를 기다립니다.", error=type(error).__name__, status=getattr(error, "status_code", None))
            finally:
                pending.task_done()

    def emit_turn(result, candidate=None, usage=None, elapsed=None):
        action, text, reason = result[:3]
        metadata = result[3] if len(result) > 3 else {}
        labels = {"accept": "✓ 전달할 문장", "ignore": "○ 무시", "wait": "… 이어지는 말 대기", "hold": "… 추가 발화 확인 중", "clarify": "? 확인 필요 · 전달 보류"}
        display.emit("turn." + action, f"\n{labels[action]} > {text}\n  판단: {reason}\n", text=text, reason=reason, **metadata)

    def decide_turns():
        while not stopped.wait(.05):
            candidate = turns.poll(time.monotonic())
            if candidate is None:
                continue
            if not isinstance(candidate, Candidate):
                emit_turn(candidate)
                continue
            started = time.monotonic()
            display.emit("filter_started", "의도 필터 판단 중", text=candidate.text, turn_id=candidate.turn_id, revision=candidate.revision)
            try:
                if provider == "none":
                    decision = Decision("accept", "filter_disabled")
                elif provider == "rules":
                    decision = rules(candidate.text, candidate.context)
                else:
                    decision = gate.decide(candidate.text, candidate.context)
            except Exception as error:
                display.emit("filter_error", f"필터 판단 실패: {type(error).__name__}. 자동 전달하지 않습니다.", error=type(error).__name__)
                decision = Decision("clarify", "filter_unavailable")
            if stopped.is_set():
                return
            result = turns.apply(candidate, decision, time.monotonic(), filter_seconds=round(time.monotonic() - started, 3))
            if result:
                emit_turn(result, candidate, decision.usage, round(time.monotonic() - started, 3))
            else:
                display.emit("decision_stale", "추가 발화가 들어와 이전 판단을 폐기하고 이어 듣습니다.")

    worker = threading.Thread(target=recognize, daemon=True)
    decision_worker = threading.Thread(target=decide_turns, daemon=True)
    decoder = FrameDecoder()
    processor = AudioProcessor()
    vad = Silero(input_gain=args.vad_gain)
    utterances = SpeechCapture(button=args.button, minimum=args.threshold, silence=args.silence)
    packets = gaps = 0
    previous = None
    level_rms_peak = level_speech_peak = 0.0
    last_meter = 0.0
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
            decision_worker.start()
        mode = "버튼을 누르고 말한 뒤 놓아 주세요" if args.button else "버튼 없이 말해 주세요. 말을 멈추면 자동 인식합니다"
        display.emit("started", f"\nSWitch ESP32 → Silero VAD → STT → 발화 합치기·필터\n포트: {args.port}\nSTT: {model} / 필터: {provider} / VAD 입력 보정: {args.vad_gain:g}배\n{mode}\n후보는 표시하고, 합친 뒤 전달/무시/대기/확인 필요로 구분합니다.\n아직 주문 에이전트·결제로 전송하지 않습니다. 원본 녹음은 저장하지 않습니다.\n종료: Ctrl+C\n", port=args.port, model=model, filter=provider, vad_gain=args.vad_gain)
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
                            vad.reset()
                            turns.cancel()
                            display.emit("audio_gap", "USB 음성이 크게 끊겨 미완성 발화는 전달하지 않았어요. 다시 말씀해 주세요.")
                previous = frame.sequence
                samples = processor.process(frame.pcm, True)
                for raw, rms, probability in vad.frames(samples.tobytes()):
                    level_rms_peak = max(level_rms_peak, rms)
                    level_speech_peak = max(level_speech_peak, probability)
                    was_active = utterances.active
                    chunk = utterances.feed(raw, rms, probability, frame.pressed)
                    if utterances.active and not was_active and client:
                        turn_id, revision = turns.speech_started(time.monotonic())
                        display.emit("speech_started", "\n● 말소리 후보 수음 중…", turn_id=turn_id, revision=revision)
                    if chunk and client:
                        token = turns.audio_finished(time.monotonic(), chunk.continuing, voice_end=time.monotonic() - chunk.quiet_seconds)
                        if token and chunk.pcm:
                            display.emit("audio_segment", "음성 구간 수집 완료", turn_id=token[0], segment=token[1], endpoint_seconds=round(chunk.quiet_seconds, 3), continuing=chunk.continuing)
                            try:
                                pending.put_nowait((token, chunk.pcm))
                            except queue.Full:
                                turns.transcript(token, "", failed=True)
                                display.emit("busy", "수음 처리가 밀려 이 발화 전체를 전달 보류합니다. 다시 말씀해 주세요.")
                        elif token:
                            turns.transcript(token, "")
                            display.emit("audio_rejected", "짧은 비음성 후보를 STT 전에 걸렀어요.")
                    if args.json_events and last_valid - last_meter >= .12:
                        display.emit("meter", "", rms=round(rms), threshold=round(utterances.threshold), probability=round(probability, 3), active=utterances.active, noise=round(utterances.floor.noise))
                        last_meter = last_valid
                    if last_valid - last_status >= 1:
                        bar = "█" * min(24, int(rms / max(utterances.threshold, 1) * 6))
                        display.emit("level", f"마이크 {bar:<24} RMS 최대 {level_rms_peak:6.0f} / 문턱 {utterances.threshold:.0f} / 말소리 최대 {level_speech_peak:.2f} / 배경 {utterances.floor.noise:.0f} / BTN {int(frame.pressed)} / 누락 {gaps} / CRC {decoder.bad_frames}", rms=round(rms), rms_peak=round(level_rms_peak), threshold=round(utterances.threshold), speech_probability=round(probability, 3), speech_probability_peak=round(level_speech_peak, 3), noise=round(utterances.floor.noise), packets=packets, gaps=gaps, bad=decoder.bad_frames)
                        level_rms_peak = level_speech_peak = 0.0
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
        if decision_worker.is_alive():
            decision_worker.join(timeout=.5)
        if client and not worker.is_alive():
            client.close()
        if gate and not decision_worker.is_alive():
            gate.close()
        display.emit("stopped", "\n수음과 STT를 종료했습니다. USB 포트를 해제했어요.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"연결 오류: {type(error).__name__}: {error}", flush=True)
        print("Arduino 시리얼 모니터·기존 마이크 듣기를 닫고 USB 연결을 확인해 주세요.", flush=True)
        raise SystemExit(1)
