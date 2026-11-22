"""Thin USB-to-HTTPS relay: stdlib + pySerial, no local speech inference."""

import argparse
import http.client
import json
import os
from pathlib import Path
import signal
import ssl
import sys
import threading
import time
from urllib.parse import urlsplit

OUTPUT_LOCK = threading.Lock()


def output(row):
    with OUTPUT_LOCK:
        print(json.dumps(row, ensure_ascii=False), flush=True)


def configuration(path):
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    url = urlsplit(config["server_url"].rstrip("/"))
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1"}):
        raise ValueError("서버 주소는 HTTPS여야 합니다.")
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError("서버 주소 형식을 확인해 주세요.")
    if len(config.get("device_token", "")) < 32:
        raise ValueError("장치 연결 키를 확인해 주세요.")
    return config, url


def connection(url):
    if url.scheme == "https":
        # Ship the same CA bundle as the existing kiosk, not disabled TLS.
        ca = Path(__file__).with_name("cacert.pem")
        return http.client.HTTPSConnection(url.hostname, url.port or 443, timeout=10, context=ssl.create_default_context(cafile=str(ca) if ca.exists() else None))
    return http.client.HTTPConnection(url.hostname, url.port or 80, timeout=10)


def emit(kind, message, **fields):
    output({"event": kind, "message": message, "time": time.time(), **fields})


def run(config_path):
    import serial
    from serial.tools import list_ports
    config, url = configuration(config_path)
    headers = {"Authorization": "Bearer " + config["device_token"]}
    base = url.path.rstrip("/")
    api = connection(url)
    events = connection(url)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())

    def managed_stop():
        for _ in sys.stdin:
            stop.set()
            break

    threading.Thread(target=managed_stop, daemon=True).start()
    port = config.get("serial_port")
    if not port:
        matches = [p.device for p in list_ports.comports() if p.vid == 0x303A]
        if len(matches) != 1:
            raise ValueError("ESP32 한 대를 연결하거나 연결설정.json의 serial_port에 COM 번호를 적어 주세요.")
        port = matches[0]
    link = serial.Serial(port=None, baudrate=921600, timeout=.02, exclusive=True)
    link.dtr, link.rts, link.port = True, False, port
    session = None
    reader = None

    def request(method, path, body=b"", extra=None):
        api.request(method, base + path, body=body, headers={**headers, **(extra or {})})
        response = api.getresponse()
        data = response.read(16384)
        if response.status >= 300:
            raise RuntimeError(f"서버 연결 오류 (HTTP {response.status})")
        return json.loads(data)

    try:
        # Reserve the USB port first; don't start billable work if it is in use.
        link.open()
        if os.name == "posix":
            import fcntl
            import termios
            fcntl.ioctl(link.fileno(), termios.TIOCEXCL)
        emit("remote.connecting", "음성 처리 서버에 연결하고 있어요.")
        state = request("POST", "/session", b"{}", {"Content-Type": "application/json"})
        session = state["session"]
        path = "/session/" + session
        events.request("GET", base + path + "/events", headers=headers)
        stream = events.getresponse()
        if stream.status != 200:
            raise RuntimeError(f"서버 결과 연결 오류 (HTTP {stream.status})")

        def receive():
            try:
                while not stop.is_set():
                    line = stream.readline(32769)
                    if not line or len(line) > 32768:
                        break
                    if not line.strip():
                        continue
                    row = json.loads(line)
                    if isinstance(row, dict) and isinstance(row.get("event"), str) and not stop.is_set():
                        row["processing"] = "server"
                        output(row)
            except (OSError, ValueError):
                pass
            finally:
                if not stop.is_set():
                    emit("remote.error", "서버 결과 연결이 끊겼어요. 다시 시작해 주세요.")
                stop.set()

        reader = threading.Thread(target=receive, daemon=True)
        reader.start()
        link.reset_input_buffer()  # Discard USB samples from connection setup.
        data = bytearray()
        last_send = last_data = time.monotonic()
        sequence = 0
        emit("remote.connected", "서버 연결 완료 · PC는 마이크 전송과 화면 표시만 해요.", processing="server", port=port)
        while not stop.is_set():
            waiting = link.in_waiting
            if waiting > 48000:
                raise RuntimeError("음성 전송이 밀렸어요. 네트워크를 확인하고 다시 시작해 주세요.")
            incoming = link.read(max(1, min(waiting, 32768 - len(data))))
            now = time.monotonic()
            if incoming:
                data.extend(incoming)
                last_data = now
            if data and (len(data) >= 32768 or now - last_send >= .04):
                started = time.monotonic()
                request("POST", path + "/audio", bytes(data), {"Content-Type": "application/octet-stream", "X-Audio-Sequence": str(sequence)})
                if time.monotonic() - started > .8:
                    raise RuntimeError("전송이 밀려 이전 음성을 폐기했어요. 네트워크를 확인하고 다시 시작해 주세요.")
                data.clear()
                sequence += 1
                last_send = time.monotonic()
            if now - last_data > 3:
                raise RuntimeError("마이크 USB 입력이 끊겼어요.")
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        link.close()
        if session:
            try:
                request("DELETE", "/session/" + session)
            except (OSError, ValueError, http.client.HTTPException, RuntimeError):
                pass
        api.close()
        events.close()
        if reader:
            reader.join(timeout=1)
        emit("stopped", "수음과 서버 연결을 종료했어요. USB 포트를 해제했어요.")


def main():
    parser = argparse.ArgumentParser(description="SWitch 저사양 PC 마이크 전달기")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        run(args.config)
    except Exception as error:
        # Error messages from HTTP/TLS can contain endpoints; never print keys.
        if isinstance(error, (ValueError, RuntimeError)):
            emit("remote.error", str(error))
        else:
            emit("remote.error", f"음성 연결 오류: {type(error).__name__}. USB·인터넷·서버 설정을 확인해 주세요.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
