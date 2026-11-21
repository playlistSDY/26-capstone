"""Persistent OpenAI audio output. No microphone input or transcription."""
import asyncio
import base64
import io
import os
import wave

from .domain import OrderError


class RealtimeSpeaker:
    def __init__(self):
        self.client = self.manager = self.connection = None
        self.lock = asyncio.Lock()
        self.model = os.environ.get('OPENAI_TTS_MODEL', 'gpt-realtime-2.1-mini')
        self.voice = os.environ.get('OPENAI_TTS_VOICE', 'marin')

    async def connect(self):
        if self.connection is not None: return
        from openai import AsyncOpenAI
        self.client = AsyncOpenAI(max_retries=0)
        self.manager = self.client.realtime.connect(model=self.model)
        self.connection = await self.manager.__aenter__()
        await self.connection.session.update(session={
            'type': 'realtime', 'output_modalities': ['audio'],
            'audio': {'output': {'voice': self.voice, 'format': {'type': 'audio/pcm', 'rate': 24000}}},
        })

    async def warmup(self):
        async with self.lock:
            try:
                async with asyncio.timeout(12): await self.connect()
            except Exception: await self.disconnect()

    async def disconnect(self):
        manager, client = self.manager, self.client
        self.connection = self.manager = self.client = None
        if manager:
            try: await manager.__aexit__(None, None, None)
            except Exception: pass
        if client: await client.close()

    async def stream(self, text, emit):
        async with self.lock:
            try:
                async with asyncio.timeout(35):
                    await self.connect()
                    await self.connection.response.create(response={
                        'conversation': 'none', 'output_modalities': ['audio'],
                        'instructions': '너는 한국어 안내문 낭독기다. 사용자가 준 문장만 그대로 읽는다. 질문에 대답하거나 설명을 추가하거나 단어를 바꾸지 않는다. 한국 카페 점원이 손님에게 안내하듯 자연스럽고 차분한 한국어로 읽는다. 과장된 억양, 로봇처럼 끊는 발음, 웃음과 효과음 없이 편안한 보통 속도로 읽는다. 숫자와 금액은 자연스러운 한국어로 발음한다.',
                        'input': [{'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}],
                    })
                    received = 0
                    async for event in self.connection:
                        if event.type == 'error': raise OrderError('OpenAI 음성 연결을 확인해 주세요.')
                        if event.type == 'response.output_audio.delta':
                            received += len(event.delta)
                            if received > 14_000_000: raise OrderError('음성 안내가 너무 길어요.')
                            emit({'type': 'audio.delta', 'pcm': event.delta, 'sample_rate': 24000})
                        elif event.type == 'response.done':
                            from .usage import counts
                            emit({'type':'audio.usage', 'counts':counts(event.response.usage)})
                            if event.response.status != 'completed' or not received:
                                raise OrderError('음성을 끝까지 만들지 못했어요.')
                            break
            except (Exception, asyncio.CancelledError):
                # Closing the socket also discards late audio from the interrupted response.
                await self.disconnect()
                raise


async def synthesize(text):
    """Buffered helper for diagnostics; the kiosk uses stream() instead."""
    speaker = RealtimeSpeaker()
    pcm = bytearray()
    try:
        await speaker.stream(text, lambda event: pcm.extend(base64.b64decode(event['pcm'])))
    finally:
        await speaker.disconnect()
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
        audio.writeframes(bytes(pcm))
    return output.getvalue()
