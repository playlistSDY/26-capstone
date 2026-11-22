"""Opt-in live server replay; sends a fixture WAV and makes real STT requests."""

import argparse
import json
import threading
import time
import wave
import zlib

from audio_protocol import HEADER, MAGIC
from voice_relay import configuration, connection


def main():
    from pathlib import Path
    parser = argparse.ArgumentParser(description="실제 STT 요금이 발생하는 서버 재생 검증")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--wav", type=Path, required=True)
    args = parser.parse_args()
    config, url = configuration(args.config)
    with wave.open(str(args.wav), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (48000, 1, 2):
            raise ValueError("48kHz mono signed16 WAV required")
        pcm = bytes(48000) + audio.readframes(audio.getnframes()) + bytes(48000 * 4)
    api, events = connection(url), connection(url)
    headers = {"Authorization": "Bearer " + config["device_token"]}
    base = url.path.rstrip("/")
    rows, rtts = [], []
    session = None

    def request(method, path, data=b"", extra=None):
        api.request(method, base + path, data, {**headers, **(extra or {})})
        response = api.getresponse()
        result = response.read()
        if response.status >= 300:
            raise RuntimeError("Remote HTTP " + str(response.status))
        return json.loads(result)

    try:
        session = request("POST", "/session", b"{}")['session']
        path = "/session/" + session
        events.request("GET", base + path + "/events", headers=headers)
        stream = events.getresponse()
        if stream.status != 200:
            raise RuntimeError("Remote events HTTP " + str(stream.status))

        def read():
            try:
                for line in stream:
                    if line.strip():
                        rows.append(json.loads(line))
            except (OSError, ValueError):
                pass

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        began = time.monotonic()
        frame_sequence = upload_sequence = 0
        offset = 0
        while time.monotonic() - began < 20:
            chunk = bytearray()
            for _ in range(8):
                block = pcm[offset:offset + 512] if offset < len(pcm) else bytes(512)
                if len(block) < 512:
                    block += bytes(512 - len(block))
                chunk.extend(HEADER.pack(MAGIC, 48000, 256, 2, 1, frame_sequence, zlib.crc32(block)))
                chunk.extend(block)
                frame_sequence += 1
                offset += 512
            start = time.monotonic()
            request("POST", path + "/audio", bytes(chunk), {"Content-Type": "application/octet-stream", "X-Audio-Sequence": str(upload_sequence)})
            rtts.append(time.monotonic() - start)
            upload_sequence += 1
            if any(r["event"] == "turn.accept" for r in rows):
                break
            time.sleep(max(0, began + offset / 96000 - time.monotonic()))
        final = [r for r in rows if r["event"] == "turn.accept"]
        errors = [r["event"] for r in rows if r["event"].endswith("error")]
        print(json.dumps({"actualHTTPSAndSTT": True, "syntheticWAV": True, "accepted": [{k: r[k] for k in ["text", "stt_seconds", "filter_seconds", "after_stt_seconds", "from_speech_end_seconds"] if k in r} for r in final], "audioRequests": len(rtts), "uploadRTTp95Ms": round(sorted(rtts)[int(len(rtts) * .95)] * 1000), "errors": errors, "eventTypes": sorted({r["event"] for r in rows})}, ensure_ascii=False))
        if not final or errors:
            raise SystemExit(1)
    finally:
        if session:
            request("DELETE", "/session/" + session)
        api.close()
        events.close()


if __name__ == "__main__":
    main()
