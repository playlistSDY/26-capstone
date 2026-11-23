"""Semantic UI guidance commands; never arbitrary selectors or cart mutations."""
from uuid import uuid4
from .domain import OrderError

TARGETS = {"place", "category", "product", "option", "editor.quantity", "editor.add", "cart.quantity", "cart.options", "cart.remove", "checkout", "confirm_payment", "payment.method", "back"}
CATEGORIES = {"추천 메뉴", "커피", "디카페인", "논커피", "에이드", "블렌디드", "과일 주스", "티", "병음료"}
OPTIONS = {"temperature", "size", "ice", "sweetness", "milk", "decaf", "whippedCream"}
VALUES = {"temperature": {"hot", "ice"}, "size": {"regular", "large"}, "ice": {"normal", "more", "less", "none"}, "sweetness": {"normal", "less", "none"}, "milk": {"regular", "oat"}, "decaf": {"true", "false"}, "whippedCream": {"normal", "extra", "none"}}


def guide(store, target, instruction, product_id=None, line_id=None, option=None, value=None):
    if target not in TARGETS or not instruction.strip() or len(instruction) > 160:
        raise OrderError("안내할 버튼과 짧은 설명을 확인해 주세요.")
    if store.phase in {"completed", "handoff"} or store.payment_ui.get("payment"):
        raise OrderError("진행 중인 결제는 리더기 안내를 따라 주세요.")
    if target.startswith("cart."):
        store.line(line_id)
    if target == "product" and not product_id:
        raise OrderError("먼저 안내할 메뉴를 조회해 주세요.")
    editor = store.ui_context.get("editor") or {}
    if target in {"option", "editor.quantity", "editor.add"}:
        product_id = product_id or editor.get("product_id")
        if not product_id:
            raise OrderError("옵션을 안내할 메뉴를 먼저 선택해 주세요.")
        if line_id:
            if store.line(line_id).product_id != product_id:
                raise OrderError("선택한 주문 항목의 메뉴를 확인해 주세요.")
    if product_id:
        p = store.product(product_id)
        if p.get("soldOut") or store.stock.get(product_id) == 0:
            raise OrderError("품절 메뉴 대신 다른 메뉴를 안내해 주세요.")
    if target == "category" and value not in CATEGORIES:
        raise OrderError("실제 메뉴 카테고리를 선택해 주세요.")
    if target == "option":
        if option not in OPTIONS or (value is not None and value not in VALUES[option]):
            raise OrderError("지원하는 옵션 버튼을 안내해 주세요.")
        temperature = editor.get("options", {}).get("temperature") if editor.get("product_id") == product_id else None
        if (p["fixedOptions"] or (option == "size" and p["fixedSize"]) or
            (option == "milk" and not p["milk"]) or (option == "decaf" and (not p["decaf"] or p.get("decafOnly"))) or (option == "whippedCream" and not p.get("whippedCream")) or
            (option == "ice" and (not p["iceAdjustable"] or temperature == "hot")) or
            (option == "temperature" and value is not None and value not in p["temperatures"])):
            raise OrderError("현재 메뉴에서 사용할 수 있는 옵션을 안내해 주세요.")
    if target == "payment.method":
        if store.phase != "checkout" or value not in {"card", "samsung", "apple", "kakao", "naver"}:
            raise OrderError("결제수단 선택 화면을 연 뒤 버튼을 안내해 주세요.")
    elif store.phase != "ordering" and target not in {"back", "place"}:
        raise OrderError("먼저 주문 화면으로 돌아간 뒤 안내해 주세요.")
    if target in {"checkout", "confirm_payment"} and not store.lines:
        raise OrderError("메뉴를 담은 뒤 결제 버튼을 안내해 주세요.")
    store.guidance = {"id": uuid4().hex, "target": target, "instruction": instruction.strip(), "product_id": product_id, "line_id": line_id, "option": option, "value": value}
    return {"guidance": store.guidance, "cart_changed": False, "note": "버튼 표시와 필요한 화면 준비만 수행한다. 클릭·옵션 선택·주문 변경·청구는 실행하지 않는다."}
