import argparse
import asyncio
import json
import os

from .domain import Options, OrderStore


def demo():
    s = OrderStore.demo()
    s.begin_turn("매장에서 따뜻한 라떼 두 잔 주세요")
    s.set_place("store")
    s.add("latte", 2, Options(temperature="hot"))
    print("[가상 도구 시연, LLM 대화 아님]", s.summary())
    s.begin_turn("하나는 차갑게 바꿔줘")
    s.split(s.lines[0].id, 1, Options(temperature="ice"))
    print("점원:", s.summary())
    s.begin_turn("그걸로 끝")
    print("점원:", s.request_confirmation()["summary"])
    s.delivered()
    s.begin_turn("네")
    print("도구 이벤트:", s.checkout()["event"], "(실제 결제 없음)")


async def chat():
    if not os.environ.get("OPENAI_API_KEY") or not os.environ.get("OPENAI_MODEL"):
        raise SystemExit("OPENAI_API_KEY와 OPENAI_MODEL을 환경변수로 설정해 주세요. 키 없이 검증하려면 --demo를 사용하세요.")
    from .runtime import Conversation
    c = Conversation()
    print("점원: 주문 연습 화면이에요. 원하시는 메뉴를 말씀해 주세요. (/quit 종료)")
    while True:
        try:
            text = input("손님: ").strip()
        except EOFError:
            return
        if text == "/quit": return
        if text == "/state":
            print(json.dumps(c.store.snapshot(), ensure_ascii=False, indent=2))
            continue
        if not text: continue
        try:
            response = await c.reply(text)
            print("점원:", response["text"])
        except Exception as error:
            print(f"응답을 완료하지 못했어요 ({type(error).__name__}). 담긴 주문은 유지돼요. /state로 확인하세요.")
        if c.store.phase == "checkout":
            print("[가상 결제 화면 진입. 변경 요청으로 주문에 돌아갈 수 있습니다.]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true", help="API 없이 도메인 도구 시연")
    args = parser.parse_args()
    demo() if args.demo else asyncio.run(chat())


if __name__ == "__main__":
    main()
