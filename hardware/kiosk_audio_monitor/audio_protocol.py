"""Incremental decoder for SWitch USB PCM packets; no third-party imports."""

from dataclasses import dataclass
import struct
import zlib

MAGIC = b"SWPCM01\n"
HEADER = struct.Struct("<8sIHBBII")
SAMPLE_RATE = 48000
MAX_SAMPLES = 256


@dataclass(frozen=True)
class AudioFrame:
    sequence: int
    pressed: bool
    pcm: bytes


class FrameDecoder:
    def __init__(self):
        self.buffer = bytearray()
        self.bad_frames = 0

    def feed(self, data: bytes) -> list[AudioFrame]:
        self.buffer.extend(data)
        frames = []
        while True:
            start = self.buffer.find(MAGIC)
            if start < 0:
                # Retain a possible partial magic prefix across serial reads.
                if len(self.buffer) > len(MAGIC) - 1:
                    del self.buffer[: -(len(MAGIC) - 1)]
                break
            if start:
                del self.buffer[:start]
            if len(self.buffer) < HEADER.size:
                break
            _, rate, count, flags, version, sequence, crc = HEADER.unpack_from(self.buffer)
            if rate != SAMPLE_RATE or not 1 <= count <= MAX_SAMPLES or version != 1 or flags not in (2, 3):
                self.bad_frames += 1
                del self.buffer[0]
                continue
            size = HEADER.size + count * 2
            if len(self.buffer) < size:
                break
            pcm = bytes(self.buffer[HEADER.size:size])
            if zlib.crc32(pcm) != crc:
                self.bad_frames += 1
                del self.buffer[0]
                continue
            del self.buffer[:size]
            frames.append(AudioFrame(sequence, bool(flags & 1), pcm))
        return frames
