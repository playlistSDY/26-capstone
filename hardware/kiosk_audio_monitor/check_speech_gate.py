"""Small repeatable semantic regression set; live provider calls are opt-in."""

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import time

from serial_stt import ROOT, load_environment
from speech_decisions import OpenAIGate, JevGate, rules

CASES = [
    ("direct_order", "아이스 아메리카노 한 잔 주세요.", "", {"accept"}),
    ("self_correction", "아메리카노 두 잔, 아니 한 잔 주세요.", "", {"accept"}),
    ("unfinished_word", "아이스", "", {"wait"}),
    ("unfinished_addition", "아메리카노 한 잔 주세요. 그리고...", "", {"wait"}),
    ("companions", "너 뭐 먹을래? 나는 라떼. 너는?", "", {"ignore"}),
    ("thinking_aloud", "나는 라떼 마실까? 아니 아메리카노도 괜찮은데.", "", {"ignore", "wait"}),
    ("mixed_people", "너는 두 잔? 라떼 하나 주세요. 아니 쟤는 아직 안 골랐고.", "", {"clarify", "wait", "ignore"}),
    ("short_answer_without_question", "네", "", {"wait"}),
    ("short_answer_to_clerk", "네", "아이스로 해드릴까요?", {"accept"}),
    ("recommendation", "여기서 인기 있는 메뉴가 뭐예요?", "", {"accept"}),
    ("broadcast", "시청해 주셔서 감사합니다. 구독과 좋아요 부탁드립니다.", "", {"ignore"}),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="실제 모델 호출(추가 API 요금)")
    parser.add_argument("--provider", choices=["openai", "jev"], default="openai")
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/voice-gate/semantic-check.json")
    args = parser.parse_args()
    load_environment(ROOT / "order-agent/.env")
    gate = None
    if args.live:
        if args.provider == "openai":
            gate = OpenAIGate(os.environ["OPENAI_API_KEY"], os.environ.get("OPENAI_FILTER_MODEL") or "gpt-5.6-luna")
        else:
            gate = JevGate(os.environ["TYPESAFE_API_KEY"], ROOT / "kiosk-web/backend/certs/cacert.pem")
    rows = []
    try:
        for name, text, question, expected in CASES:
            context = {"session_active": True, "last_question": question, "speaker_identity": "unknown_single_microphone", "fragments": [{"sequence": 1, "text": text}]}
            started = time.monotonic()
            try:
                decision = gate.decide(text, context) if gate else rules(text, context)
                row = {"case": name, "expected": sorted(expected), "decision": asdict(decision), "passed": decision.action in expected}
            except Exception as error:
                row = {"case": name, "passed": False, "error": type(error).__name__}
            row["seconds"] = round(time.monotonic() - started, 3)
            rows.append(row)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    finally:
        if gate:
            gate.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"live": args.live, "provider": args.provider if args.live else "rules_baseline", "smallHandwrittenRegressionSet": True, "speakerIdentificationTested": False, "cases": rows}, ensure_ascii=False, indent=2) + "\n")
    # Rules are a deliberately conservative comparison, not a semantic model.
    if args.live and not all(row["passed"] for row in rows):
        raise SystemExit("일부 의미 판별 사례가 실패했습니다. 결과 파일을 확인하세요.")


if __name__ == "__main__":
    main()
