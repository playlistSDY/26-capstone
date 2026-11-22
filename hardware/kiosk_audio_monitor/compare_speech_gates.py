"""Paired Korean clean/noisy-STT benchmark. Live API calls require --live.

No audio synthesis, STT, spell correction, canonical text or answer key is sent
to either model. This measures the post-STT gate and its decision adapter.
"""

import argparse
from dataclasses import asdict
import json
import math
import os
from pathlib import Path
import random
import time

from serial_stt import ROOT, load_environment
from speech_decisions import OpenAIGate, JevGate

# Manually assumed STT corruption: spacing, phonetic substitutions and missing
# particles. Labels express our gate policy, not field-measured ground truth.
PAIRS = [
    ("direct_order", "accept", "아이스 아메리카노 두 잔 주세요.", "아이 쓰 아매 리카노 두쟌 주세 요", ""),
    ("reference_change", "accept", "그거 말고 다른 걸로 주세요.", "그거말 고 다 른걸 로주새요", ""),
    ("temperature", "accept", "라떼 따뜻하게 해 주세요.", "라 때 따 뜻 하개 해주 새요", ""),
    ("correction", "accept", "아메리카노 두 잔, 아니 한 잔 주세요.", "아 매리 카노 두잔 아뇨 한잔 주새", ""),
    ("quantity", "accept", "두 잔이요.", "두쟈 니요", "몇 잔 드릴까요?"),
    ("yes", "accept", "네.", "내에", "아이스로 해드릴까요?"),
    ("takeaway", "accept", "아니요, 포장이요.", "아 뇨 퍼 장이 요", "매장에서 드시나요?"),
    ("recommendation", "accept", "여기서 제일 잘 나가는 메뉴가 뭐예요?", "여 기서재일 잘나가 는매뉴 머애요", ""),
    ("remove", "accept", "아까 담은 거 하나 빼 주세요.", "아까다믄 거 하 나빼주새 요", ""),
    ("same_again", "accept", "그럼 똑같은 걸로 두 개요.", "그럼또까 튼걸 로두 개요", "아이스 라떼로 도와드릴까요?"),
    ("milk", "accept", "우유 못 먹는데 바꿀 수 있어요?", "우유몬 먹는대 바꿀수 이써 요", ""),
    ("checkout", "accept", "계산은 어디서 해요?", "계 사는 어 디서 해여", "주문을 마치셨나요?"),
    ("group_order", "accept", "저 친구는 라떼, 저는 아메리카노 주세요.", "저친 구라 때 저는아매리카 노주새", ""),
    ("look_more", "accept", "잠깐만요, 메뉴 좀 더 볼게요.", "잠깐마뇨 매뉴좀더 볼 께요", ""),
    ("companions", "ignore", "너 뭐 먹을래? 나는 라떼. 너는?", "너머머 글래 난라 때너는", ""),
    ("mother", "ignore", "엄마, 여기 앉아 있어. 내가 주문할게.", "엄마여 기안자 이써 내가주문 하께", ""),
    ("wallet", "ignore", "민수야, 차에 지갑 두고 왔어?", "민수야차애 지갑두 고와써", ""),
    ("broadcast", "ignore", "시청해 주셔서 감사합니다. 구독과 좋아요 부탁드립니다.", "시청해주서 감삼니다 구독꽈 조아요 부타", ""),
    ("announcement", "ignore", "다음 역은 강남역입니다.", "다음여근 강남 여 김니다", ""),
    ("phone", "ignore", "전화 끊고 이따 다시 얘기하자.", "전화끈코 이따다시얘 기하자", ""),
    ("and", "wait", "그리고…", "그리 구", ""),
    ("hesitating", "wait", "아, 그러니까…", "아 그르니 까", ""),
    ("and_that", "wait", "그거랑, 그리고…", "그 거랑 그리 구", ""),
    ("next", "wait", "그다음에는… 음…", "그 다으매는 어음", ""),
]


def cases():
    return [{"id": name + ":" + variant, "pair": name, "variant": variant, "text": text, "last_question": question, "expected": expected}
            for name, expected, clean, noisy, question in PAIRS for variant, text in [("clean", clean), ("noisy", noisy)]]


def context_for(case):
    # Never leak the clean pair, label or case name to the classifiers.
    return {"session_active": True, "scene": "카페 키오스크 테스트", "last_question": case["last_question"], "speaker_identity": "unknown_single_microphone", "fragments": [{"sequence": 1, "text": case["text"]}], "recent_user_turns": []}


def percentile(values, p):
    return sorted(values)[max(0, math.ceil(len(values) * p) - 1)] if values else None


def summarize(rows):
    result = {}
    for provider in sorted({r["provider"] for r in rows}):
        result[provider] = {}
        for variant in ["all", "clean", "noisy"]:
            group = [r for r in rows if r["provider"] == provider and (variant == "all" or r["variant"] == variant)]
            valid = [r for r in group if not r.get("error")]
            customer = [r for r in group if r["expected"] == "accept"]
            unrelated = [r for r in group if r["expected"] == "ignore"]
            times = [r["seconds"] for r in valid]
            rate = lambda numerator, denominator: round(numerator / denominator, 4) if denominator else None
            result[provider][variant] = {"attempts": len(group), "successful": len(valid), "errors": len(group) - len(valid),
                "accuracy_including_errors": rate(sum(r["passed"] for r in group), len(group)),
                "accuracy_successful": rate(sum(r["passed"] for r in valid), len(valid)),
                "customer_drop_rate": rate(sum(r.get("action") == "ignore" for r in customer), len(customer)),
                "customer_nonaccept_rate": rate(sum(r.get("action") != "accept" for r in customer), len(customer)),
                "background_accept_rate": rate(sum(r.get("action") == "accept" for r in unrelated), len(unrelated)),
                "median_seconds": percentile(times, .5), "p95_seconds": percentile(times, .95),
                "fast_path_count": sum(r.get("usage", {}).get("route", "").startswith("local_") for r in valid)}
    return result


def run(gates, *, repeats=1, use_fast_path=False, publish=None):
    rows = []
    names = list(gates)
    for repeat in range(repeats):
        batch = cases()
        random.Random(20261122 + repeat).shuffle(batch)
        for index, case in enumerate(batch):
            order = names if (index + repeat) % 2 == 0 else names[::-1]
            for provider in order:
                start = time.perf_counter()
                row = {**case, "provider": provider, "repeat": repeat + 1}
                try:
                    decision = gates[provider].decide(case["text"], context_for(case), use_fast_path=use_fast_path)
                    value = asdict(decision)
                    row.update(action=value["action"], reason=value["reason"], usage=value.get("usage") or {}, passed=value["action"] == case["expected"])
                except Exception as error:
                    row.update(passed=False, error=type(error).__name__, status=getattr(error, "status_code", getattr(error, "code", None)))
                row["seconds"] = round(time.perf_counter() - start, 4)
                rows.append(row)
                if publish:
                    publish(dict(row))
    return rows


def main():
    parser = argparse.ArgumentParser(description="정상·가정 STT 오인식 문장 동일 조건 의미 필터 비교")
    parser.add_argument("--live", action="store_true", help="실제 API 호출: 기본 두 모델×48문장=96회")
    parser.add_argument("--providers", choices=["both", "openai", "jev"], default="both")
    parser.add_argument("--repeats", type=int, choices=[1, 2, 3], default=1)
    parser.add_argument("--service-fast-path", action="store_true", help="실제 서비스 규칙을 포함. 기본은 두 모델 모두 빠른 규칙 제외")
    parser.add_argument("--output", type=Path, default=ROOT / "tmp/voice-gate/paired-comparison.json")
    args = parser.parse_args()
    load_environment(ROOT / "order-agent/.env")
    if not args.live:
        print(json.dumps({"dry_run": True, "cases": cases(), "calls_if_both": len(cases()) * 2 * args.repeats}, ensure_ascii=False, indent=2))
        return
    required = ["openai", "jev"] if args.providers == "both" else [args.providers]
    if "openai" in required and not os.getenv("OPENAI_API_KEY"):
        parser.error("OPENAI_API_KEY가 필요합니다.")
    if "jev" in required and not os.getenv("TYPESAFE_API_KEY"):
        parser.error("서버 agent.env에 TYPESAFE_API_KEY를 먼저 설정하세요. 비교는 아직 실행하지 않았습니다.")
    gates = {}
    try:
        if "openai" in required:
            gates["openai"] = OpenAIGate(os.environ["OPENAI_API_KEY"], os.getenv("OPENAI_FILTER_MODEL") or "gpt-5.6-luna")
        if "jev" in required:
            gates["jev"] = JevGate(os.environ["TYPESAFE_API_KEY"], ROOT / "kiosk-web/backend/certs/cacert.pem", model=os.getenv("JEV_MODEL") or "jev-latest", timeout=4)
        rows = run(gates, repeats=args.repeats, use_fast_path=args.service_fast_path, publish=lambda r: print(json.dumps(r, ensure_ascii=False), flush=True))
        report = {"live": True, "models": {k: v.model for k, v in gates.items()}, "mode": "service" if args.service_fast_path else "model_and_adapter", "repeats": args.repeats,
            "timeout_seconds": 4, "automatic_retries": 0,
            "limitations": ["Small manually labelled policy regression set", "Noisy text is assumed STT corruption, not measured microphone transcription", "Measures post-STT classification/decision adapter, not STT accuracy or end-to-end latency", "Successful call latency includes first-request TLS/setup; errors counted separately", "Canonical clean text and expected labels are withheld from provider requests"],
            "summary": summarize(rows), "cases": rows}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"summary": report["summary"], "output": str(args.output)}, ensure_ascii=False))
    finally:
        for gate in gates.values():
            gate.close()


if __name__ == "__main__":
    main()
