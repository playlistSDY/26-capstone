"""Typed model tools. Replace the mock adapter when kiosk APIs are available."""
from __future__ import annotations

from dataclasses import asdict
from difflib import SequenceMatcher
import json
import re
from typing import Literal

from agents import RunContextWrapper, function_tool

from .domain import Options, OrderError, OrderStore
from .knowledge import details, suitable, service_policy
from .payments import command
from .preferences import add_with_preferences, important_options


def encoded(value):
    return json.dumps(value, ensure_ascii=False)


def guarded(action):
    try:
        return encoded({"ok": True, "data": action()})
    except OrderError as error:
        return encoded({"ok": False, "code": "ORDER_VALIDATION", "message": str(error)})


def normalized(text):
    return re.sub(r"\s+", "", text).lower()


@function_tool
def search_menu(ctx: RunContextWrapper[OrderStore], query: str = "", max_price: int | None = None, coffee: bool | None = None, category: str | None = None) -> str:
    """메뉴 검색과 추천 후보 조회. query는 메뉴명/카테고리. 가격·커피 여부로 필터링하며 5개씩만 안내한다. 검색 후보는 주문 추가가 아니다."""
    q = normalized(query)
    candidates = []
    for p in ctx.context.catalog.values():
        if max_price is not None and p["price"] > max_price: continue
        if coffee is not None and p["coffee"] != coffee: continue
        if category is not None and category not in p["categories"]: continue
        name = normalized(p["name"] + p["sourceName"])
        score = 1.0 if not q or q in name or query in p["categories"] else SequenceMatcher(None, q, normalized(p["name"])).ratio()
        if score >= 0.35:
            stock = ctx.context.stock.get(p["id"])
            candidates.append((score, {"id": p["id"], "name": p["name"], "base_price": p["price"], "available": not p.get("soldOut", False) and stock != 0, "stock_quantity": stock, "temperatures": p["temperatures"]}))
    candidates.sort(key=lambda item: (-item[0], not item[1]["available"], item[1]["base_price"]))
    return encoded({"mode": "mock", "price_source": "prototype", "results": [p for _, p in candidates[:5]], "total_matches": len(candidates)})


@function_tool
def read_menu(ctx: RunContextWrapper[OrderStore], product_id: str, temperature: str | None = None, size: str = "regular", decaf: bool = False) -> str:
    """메뉴 상세·옵션 제한·품절·재고 및 이디야 성분·당류·카페인·알레르기 정보를 읽는다. store_profile은 이 데모 매장의 확정 설정이다. 출처 구분은 내부에 유지하고 매장 설정은 분명하게 안내한다. 숫자는 고객이 물을 때만 말한다."""
    def read():
        p = ctx.context.product(product_id)
        return {"product": p, "defaults": asdict(ctx.context.defaults(p)), "preference_policy": {"confirm_before_add": important_options(p, Options(temperature=temperature)), "source": "demo_policy"}, "stock_quantity": ctx.context.stock.get(product_id), "available": not p.get("soldOut", False) and ctx.context.stock.get(product_id) != 0, "menu_information": details(product_id, temperature, size, decaf), "option_prices": {"large": 500, "shot": 500, "syrup": 300, "oat": 600, "decaf": 500}, "price_source": "prototype", "mode": "mock"}
    return guarded(read)


@function_tool
def find_suitable_menu(ctx: RunContextWrapper[OrderStore], caffeine: Literal["any", "none", "low"] = "any", sweetness: Literal["any", "less", "sweet"] = "any", avoid_allergens: list[str] | None = None, max_price: int | None = None) -> str:
    """조건별 추천 후보를 찾는다. caffeine=any/none/low, sweetness=any/less/sweet. 우유·달걀·대두·밀·견과류·복숭아 등 피할 재료를 넘긴다. 추정값도 포함된 데모 정보이며 무알레르기 안전 보증은 아니다. 추천은 자동 주문이 아니다."""
    results = []
    for p in ctx.context.catalog.values():
        if p.get("soldOut") or ctx.context.stock.get(p["id"]) == 0: continue
        for decaf in [False, True] if p["decaf"] else [False]:
            for v in details(p["id"], decaf=decaf)["variants"]:
                price = p["price"] + (500 if decaf else 0)
                if max_price is not None and price > max_price: continue
                if not suitable(v, caffeine, sweetness, avoid_allergens or []): continue
                results.append({"product_id": p["id"], "name": p["name"], "temperature": v["temperature"], "decaf": decaf, "price": price, "sweetness": v["sweetness"], "caffeine_level": v["caffeine_level"], "allergens": v["allergens"], "allergen_origin": v["allergen_origin"], "value_origins": v["value_origins"], "source_url": v["source_url"], "caffeine_mg": v["values"]["caffeine_mg"], "sugar_g": v["values"]["sugar_g"]})
    results.sort(key=lambda row: (row["allergen_origin"] != "official" if avoid_allergens else False, sum(value != "official" for value in row["value_origins"].values()), row["price"]))
    unique = []
    for row in results:
        if not any(p["product_id"] == row["product_id"] and p["decaf"] == row["decaf"] for p in unique): unique.append(row)
    return encoded({"results": unique[:6], "total_matches": len(unique), "store_policy": service_policy(), "note": "후보는 등록된 데모 매장 설정이다. 기본 답변은 후보 1~2개와 쉬운 이유만 분명하게 안내. 실제 이디야 공식 레시피나 개인별 알레르기 안전성을 보증하지 않음."})


@function_tool
def get_cart(ctx: RunContextWrapper[OrderStore]) -> str:
    """현재 선택·메뉴 ID·항목 ID·옵션·수량·금액을 조회한다. 지시어의 대상이 여러 개면 확인 질문을 한다."""
    return encoded(ctx.context.snapshot())


@function_tool
def add_item(ctx: RunContextWrapper[OrderStore], product_id: str, quantity: int, options: Options, confirmed_options: list[str] | None = None, use_defaults: bool = False) -> str:
    """메뉴 추가 또는 미확정 메뉴 옵션 갱신. confirmed_options에는 손님이 직접 지정·동의한 temperature/size/ice/sweetness만 넣는다. use_defaults는 손님이 '나머지는 기본/알아서'라고 위임했을 때만 참. needs_preference면 아직 추가되지 않았으므로 반환 question 하나를 묻고 답을 기다린다. 다음 발화에 같은 product_id와 전체 옵션으로 다시 호출한다. 이전 동의는 같은 값일 때 유지된다. 추천만으로 호출하지 않는다."""
    return guarded(lambda: add_with_preferences(ctx.context, product_id, quantity, options, confirmed_options or [], use_defaults))


@function_tool
def cancel_pending_item(ctx: RunContextWrapper[OrderStore], product_id: str) -> str:
    """고객이 아직 담기 전인 메뉴를 취소하거나 다른 메뉴로 바꿀 때 미확정 요청을 지운다. 담긴 메뉴 삭제는 remove_item을 사용한다."""
    def cancel():
        ctx.context.editable()
        if product_id not in ctx.context.item_drafts:
            raise OrderError("취소할 미확정 메뉴를 다시 확인해 주세요.")
        del ctx.context.item_drafts[product_id]
        ctx.context.changed()
        return ctx.context.snapshot()
    return guarded(cancel)


@function_tool
def edit_item(ctx: RunContextWrapper[OrderStore], line_id: str, quantity: int, options: Options, product_id: str | None = None) -> str:
    """특정 항목의 전체 옵션·수량을 바꾸거나 메뉴를 교체한다. 변경하지 않는 값은 조회한 기존 값을 유지한다. 옵션 제외는 등록 기본값으로 되돌린다."""
    return guarded(lambda: ctx.context.edit(line_id, quantity, options, product_id))


@function_tool
def split_item(ctx: RunContextWrapper[OrderStore], line_id: str, quantity: int, options: Options) -> str:
    """같은 옵션으로 담은 여러 잔 중 일부만 옵션을 변경한다. 예: 라떼 두 잔 중 한 잔만 따뜻하게."""
    return guarded(lambda: ctx.context.split(line_id, quantity, options))


@function_tool
def remove_item(ctx: RunContextWrapper[OrderStore], line_id: str) -> str:
    """대상이 명확한 주문 항목을 삭제한다. 하나만 줄이는 요청에는 edit_item으로 수량을 바꾼다."""
    return guarded(lambda: ctx.context.remove(line_id))


@function_tool
def clear_order(ctx: RunContextWrapper[OrderStore]) -> str:
    """고객이 전체 주문을 비우거나 처음부터 다시 고르겠다고 명확히 요청할 때 모든 항목을 비운다. 특정 메뉴 취소와 구별한다. 매장/포장 선택은 유지한다."""
    def clear():
        s = ctx.context
        s.editable()
        s.lines = []
        s.item_drafts.clear()
        s.focus = None
        s.changed()
        return s.snapshot()
    return guarded(clear)


@function_tool
def select_item(ctx: RunContextWrapper[OrderStore], line_id: str) -> str:
    """수정 대상 항목을 선택한다. 수량·옵션·금액은 바꾸지 않는다."""
    def select():
        ctx.context.editable()
        ctx.context.line(line_id)
        ctx.context.focus = line_id
        return ctx.context.snapshot()
    return guarded(select)


@function_tool
def set_order_type(ctx: RunContextWrapper[OrderStore], place: str) -> str:
    """매장 식사는 store, 포장은 takeout으로 설정한다."""
    return guarded(lambda: ctx.context.set_place(place))


@function_tool
def request_final_confirmation(ctx: RunContextWrapper[OrderStore]) -> str:
    """사용자가 주문을 마치려 할 때 호출한다. 전체 내역과 금액을 안내하고 새로운 사용자 발화로 최종 동의를 기다린다. 주문 확인 화면으로 이동하며, 결제수단 선택은 다음 동의 후에 진행한다."""
    return guarded(ctx.context.request_confirmation)


@function_tool
def open_checkout(ctx: RunContextWrapper[OrderStore], method: Literal["card", "samsung", "apple", "kakao", "naver"] | None = None) -> str:
    """직전 최종 주문 요약에 사용자가 명확히 동의한 경우에만 결제 화면을 연다. 현재는 가상 이벤트이며 실제 청구는 없다."""
    def open_screen():
        result = ctx.context.checkout()
        if method is not None:
            command(ctx.context, "select", method)
        return result
    return guarded(open_screen)


@function_tool
def select_payment_method(ctx: RunContextWrapper[OrderStore], method: Literal["card", "samsung", "apple", "kakao", "naver"]) -> str:
    """고객이 선택한 결제수단으로 기존 키오스크 리더기 화면을 연다. card=신용·체크카드. 청구 성공을 만들지 않으며 결과는 키오스크가 보고한다."""
    return guarded(lambda: command(ctx.context, "select", method))


@function_tool
def retry_payment(ctx: RunContextWrapper[OrderStore]) -> str:
    """고객이 실패·시간 초과된 결제의 재시도에 동의하면 같은 결제수단으로 리더기를 다시 시작한다."""
    return guarded(lambda: command(ctx.context, "retry"))


@function_tool
def cancel_payment(ctx: RunContextWrapper[OrderStore]) -> str:
    """고객 요청으로 승인 전 결제 시도를 취소하고 결제수단 선택으로 돌아간다. 주문은 유지한다. 승인 완료 취소·환불은 지원하지 않는다."""
    return guarded(lambda: command(ctx.context, "cancel"))


@function_tool
def return_to_order(ctx: RunContextWrapper[OrderStore]) -> str:
    """결제 화면에서 주문 단계로 돌아간다. 변경 후 최종 확인을 다시 받는다."""
    return guarded(ctx.context.return_to_order)


@function_tool
def handoff_to_staff(ctx: RunContextWrapper[OrderStore], reason: str, unresolved: str) -> str:
    """고객이 직원을 명시적으로 요청하거나 반복 복구로도 해결할 수 없는 시스템 장애일 때만 인계 이벤트를 만든다. 일반 메뉴·추천·성분 질문은 직접 처리한다. 현재는 실제 직원 호출에 연결되지 않은 가상 이벤트다."""
    s = ctx.context
    if s.phase == "handoff":
        return encoded({"ok": True, "event": "staff.handoff_requested", "mode": "mock", "staff_notified": False})
    s.handoff = {"reason": reason, "unresolved": unresolved, "cart": s.snapshot()}
    s.phase = "handoff"
    s.changed()
    return encoded({"ok": True, "event": "staff.handoff_requested", "mode": "mock", "staff_notified": False})


TOOLS = [search_menu, read_menu, find_suitable_menu, get_cart, add_item, cancel_pending_item, edit_item, split_item, remove_item, clear_order, select_item, set_order_type, request_final_confirmation, open_checkout, select_payment_method, retry_payment, cancel_payment, return_to_order, handoff_to_staff]
