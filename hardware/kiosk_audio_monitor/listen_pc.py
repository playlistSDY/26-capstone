"""Play ESP32 USB PCM through a selected PC output device."""

import argparse
import math
import sys
import time

from audio_protocol import FrameDecoder, SAMPLE_RATE


def main():
    parser = argparse.ArgumentParser(description="ESP32 마이크를 PC 스피커로 듣기 (Ctrl+C 종료)")
    parser.add_argument("--port", help="예: /dev/cu.usbmodem101 또는 COM3 (ESP32 한 대면 자동 선택)")
    parser.add_argument("--output", help="출력 장치 번호 또는 이름. 생략하면 PC 기본 출력")
    parser.add_argument("--gain", type=float, default=1.0, help="디지털 음량 배율 (기본 1, 0 초과 20 이하)")
    parser.add_argument("--buffer-ms", type=int, default=60, help="USB 끊김 완충 시간 (기본 60ms, 20~200)")
    parser.add_argument("--always", action="store_true", help="버튼을 누르지 않아도 계속 듣기")
    parser.add_argument("--list", action="store_true", help="USB 포트와 출력 장치 목록만 확인")
    args = parser.parse_args()
    if not math.isfinite(args.gain) or not 0 < args.gain <= 20:
        parser.error("--gain은 0보다 크고 20 이하여야 합니다.")
    if not 20 <= args.buffer_ms <= 200:
        parser.error("--buffer-ms는 20~200 사이여야 합니다.")

    try:
        import numpy as np
        import serial
        from serial.tools import list_ports
        import sounddevice as sd
        from audio_playback import AudioProcessor, PlaybackBuffer
    except ImportError as error:
        print(f"필요 패키지가 없습니다: {error}\nrequirements.txt를 설치하거나 Mac 실행 파일을 사용하세요.", file=sys.stderr)
        return 1

    ports = list(list_ports.comports())
    if args.list:
        print("USB/시리얼 포트:")
        for p in ports:
            print(f"  {p.device}: {p.description}")
        print("\n오디오 출력 장치:")
        print(sd.query_devices())
        return 0

    port = args.port
    if not port:
        matches = [p.device for p in ports if p.vid == 0x303A]
        if len(matches) != 1:
            print("ESP32 포트를 하나로 정할 수 없습니다. --list 후 --port로 지정하세요.", file=sys.stderr)
            return 1
        port = matches[0]
    output = int(args.output) if args.output and args.output.isdigit() else args.output
    device = sd.query_devices(output, "output")
    channels = min(2, int(device["max_output_channels"]))
    sd.check_output_settings(device=output, channels=channels, dtype="int16", samplerate=SAMPLE_RATE)
    playback = PlaybackBuffer(channels, startup_ms=args.buffer_ms, max_ms=max(240, args.buffer_ms * 3))
    processor = AudioProcessor(args.gain)
    decoder = FrameDecoder()
    output_underflows = 0

    def audio_callback(outdata, frames, timing, status):
        nonlocal output_underflows
        if status.output_underflow:
            output_underflows += 1
        outdata[:] = playback.take(frames * channels * 2)

    print(f"ESP32 포트: {port}\n출력: {device['name']} / 48 kHz / {channels}채널")
    print("PC 음량을 낮추고 마이크와 스피커를 떨어뜨려 주세요. 이어폰을 쓰면 피드백을 피할 수 있습니다.")
    print("항상 듣기 모드" if args.always else "버튼을 누르는 동안 재생됩니다. 놓으면 정지합니다.")
    print("Arduino 시리얼 모니터는 닫아 주세요. Ctrl+C로 종료합니다.")
    print(f"재생 완충 {args.buffer_ms}ms / DC 제거 / 시작·종료 페이드 / 음량 {args.gain}배")

    received = 0
    gaps = 0
    previous_sequence = None
    last_valid = time.monotonic()
    last_status = last_valid
    with serial.Serial(port, 921600, timeout=0.05, write_timeout=0.5) as connection:
        connection.reset_input_buffer()
        # Let queued USB data drain before measuring gaps or playing audio.
        # Reconnecting can otherwise mix old packets with the live stream.
        warmup_end = time.monotonic() + 0.25
        while time.monotonic() < warmup_end:
            connection.read(max(1, min(connection.in_waiting, 8192)))
        connection.reset_input_buffer()
        last_valid = last_status = time.monotonic()
        with sd.RawOutputStream(
            samplerate=SAMPLE_RATE, channels=channels, dtype="int16",
            device=output, blocksize=480, latency="high", callback=audio_callback
        ):
            while True:
                data = connection.read(max(1, min(connection.in_waiting, 8192)))
                for frame in decoder.feed(data):
                    last_valid = time.monotonic()
                    received += 1
                    if previous_sequence is not None:
                        delta = (frame.sequence - previous_sequence) & 0xFFFFFFFF
                        if 1 < delta < 0x80000000:
                            gaps += delta - 1
                    previous_sequence = frame.sequence
                    samples = np.frombuffer(frame.pcm, dtype="<i2").astype(np.float32)
                    rms = float(np.sqrt(np.mean(samples * samples)))
                    samples = processor.process(frame.pcm, frame.pressed or args.always)
                    if channels == 2:
                        samples = np.repeat(samples, 2)
                    # Keep sending silence after fade-out, preserving buffer timing.
                    playback.put(samples.tobytes())
                    if last_valid - last_status >= 1:
                        print(f"BTN={int(frame.pressed)} MIC_RMS={rms:.1f} "
                              f"packets={received} gaps={gaps} bad={decoder.bad_frames} "
                              f"starve={playback.underruns} out_underflow={output_underflows} "
                              f"dropped={playback.dropped_frames} clip={processor.clipped}", flush=True)
                        last_status = last_valid
                if time.monotonic() - last_valid > 5:
                    raise RuntimeError(
                        "5초 동안 유효한 음성 데이터를 받지 못했습니다. "
                        "오디오 전송용 스케치를 업로드했는지 확인하세요."
                    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n재생을 종료했습니다.")
    except Exception as error:
        print(f"\n오류: {error}", file=sys.stderr)
        print("오디오 전송용 스케치 업로드, USB 포트, 시리얼 모니터 종료, 출력 장치 설정을 확인하세요.", file=sys.stderr)
        sys.exit(1)
