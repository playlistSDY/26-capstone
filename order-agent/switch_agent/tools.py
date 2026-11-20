"""Typed model tools. Replace the mock adapter when kiosk APIs are available."""
from __future__ import annotations

from dataclasses import asdict
from difflib import SequenceMatcher
import json
import re

from agents import RunContextWrapper, function_tool

from .domain import Options, OrderError, OrderStore


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
def read_menu(ctx: RunContextWrapper[OrderStore], product_id: str) -> str:
    """메뉴 상세·온도·옵션 제한·품절·재고를 읽는다. 성분과 알레르기 정보는 없으므로 추측하지 않는다."""
    def read():
        p = ctx.context.product(product_id)
        return {"product": p, "defaults": asdict(ctx.context.defaults(p)), "stock_quantity": ctx.context.stock.get(product_id), "available": not p.get("soldOut", False) and ctx.context.stock.get(product_id) != 0, "allergens": None, "caffeine_mg": None, "option_prices": {"large": 500, "shot": 500, "syrup": 300, "oat": 600, "decaf": 500}, "price_source": "prototype", "mode": "mock"}
    return guarded(read)


@function_tool
def get_cart(ctx: RunContextWrapper[OrderStore]) -> str:
    """현재 선택·메뉴 ID·항목 ID·옵션·수량·금액을 조회한다. 지시어의 대상이 여러 개면 확인 질문을 한다."""
    return encoded(ctx.context.snapshot())


@function_tool
def add_item(ctx: RunContextWrapper[OrderStore], product_id: str, quantity: int, options: Options) -> str:
    """요청한 메뉴를 추가한다. 필수 온도는 확인하고 나머지는 등록 기본값을 사용한다. 추천만 한 메뉴는 추가하지 않는다."""
    return guarded(lambda: ctx.context.add(product_id, quantity, options))


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
    """사용자가 주문을 마치려 할 때 호출한다. 전체 내역과 금액을 안내하고 새로운 사용자 발화로 최종 동의를 기다린다. 이 호출 자체는 결제로 이동하지 않는다."""
    return guarded(ctx.context.request_confirmation)


@function_tool
def open_checkout(ctx: RunContextWrapper[OrderStore]) -> str:
    """직전 최종 주문 요약에 사용자가 명확히 동의한 경우에만 결제 화면을 연다. 현재는 가상 이벤트이며 실제 청구는 없다."""
    return guarded(ctx.context.checkout)


@function_tool
def return_to_order(ctx: RunContextWrapper[OrderStore]) -> str:
    """결제 화면에서 주문 단계로 돌아간다. 변경 후 최종 확인을 다시 받는다."""
    return guarded(ctx.context.return_to_order)


@function_tool
def handoff_to_staff(ctx: RunContextWrapper[OrderStore], reason: str, unresolved: str) -> str:
    """도움을 요청하거나 반복 실패하면 현재 주문과 미해결 사항을 담아 직원 인계 이벤트를 만든다. 현재는 직원 호출 시스템에 연결되지 않은 가상 이벤트다."""
    s = ctx.context
    if s.phase == "handoff":
        return encoded({"ok": True, "event": "staff.handoff_requested", "mode": "mock", "staff_notified": False})
    s.handoff = {"reason": reason, "unresolved": unresolved, "cart": s.snapshot()}
    s.phase = "handoff"
    s.changed()
    return encoded({"ok": True, "event": "staff.handoff_requested", "mode": "mock", "staff_notified": False})


TOOLS = [search_menu, read_menu, get_cart, add_item, edit_item, split_item, remove_item, select_item, set_order_type, request_final_confirmation, open_checkout, return_to_order, handoff_to_staff]
