"""Offline UI fixture: scripted responses, NOT a natural-language agent."""
import asyncio
from http.server import ThreadingHTTPServer

from switch_agent.domain import OrderStore, Options
from switch_agent.web import Bridge, handler_for


class PreviewConversation:
    def __init__(self):
        self.store = OrderStore.demo()

    async def reply(self, text, emit, defer_delivery):
        self.store.begin_turn(text)
        if not self.store.lines:
            self.store.set_place("store")
            self.store.add("latte", 1, Options(temperature="hot"))
        response = "모형 응답으로 UI를 시험하고 있어요. 따뜻한 라떼 한 잔을 담았어요. 읽는 도중에도 말 끊기를 누르거나 새 메시지를 보낼 수 있어요."
        for word in response.split(" "):
            emit({"type": "text.delta", "text": word + " "})
            await asyncio.sleep(0.25)
        return {"text": response, "state": self.store.snapshot()}


if __name__ == "__main__":
    bridge = Bridge(PreviewConversation)
    server = ThreadingHTTPServer(("127.0.0.1", 18732), handler_for(bridge))
    print("Scripted UI fixture on 18732; no OpenAI calls", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close(); bridge.close()
