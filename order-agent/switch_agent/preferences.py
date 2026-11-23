"""Persist unconfirmed additions separately from the authoritative cart."""
from dataclasses import asdict
from .domain import MAX_ORDER_QUANTITY, Options, OrderError
from .knowledge import details


def important_options(product, options):
    keys = ["temperature"] if len(product["temperatures"]) > 1 else []
    if product["fixedOptions"]:
        return keys
    if not product["fixedSize"]:
        keys.append("size")
    if options.temperature == "ice" and product["iceAdjustable"]:
        keys.append("ice")
    # Demo policy: plain unsweetened beverages need no sweetness question.
    # Production must supply recipe-level adjustability from the kiosk API.
    variants = details(product["id"], options.temperature, decaf=options.decaf)["variants"]
    if any(v["sweetness"] in {"덜 달아요", "달아요", "꽤 달아요"} for v in variants):
        keys.append("sweetness")
    if product.get("whippedCream"): keys.append("whippedCream")
    return keys


def question(keys, options):
    if keys[0] == "temperature":
        return "따뜻하게 드릴까요, 차갑게 드릴까요?"
    labels = {
        "size": "기본 크기" if options.size == "regular" else "큰 크기",
        "ice": {"normal":"얼음 보통", "more":"얼음 많이", "less":"얼음 적게", "none":"얼음 없이"}[options.ice],
        "whippedCream": {"normal": "기본 휘핑", "extra": "휘핑 추가", "none": "휘핑 없이"}[options.whippedCream],
        "sweetness": {"normal":"기본 당도", "less":"덜 달게", "none":"첨가 시럽 없이"}[options.sweetness],
    }
    return ", ".join(labels[key] for key in keys) + ", 이렇게 해 드릴까요?"


def add_with_preferences(store, product_id, quantity, options, confirmed_options, use_defaults):
    store.editable()
    product = store.product(product_id)
    allowed = {"temperature", "size", "ice", "sweetness", "whippedCream"}
    if set(confirmed_options) - allowed:
        raise OrderError("확인 옵션은 temperature, size, ice, sweetness, whippedCream 중에서 선택해 주세요.")
    # Validate before recording a draft. An unresolved temperature is allowed.
    if type(quantity) is not int or not 1 <= quantity <= MAX_ORDER_QUANTITY:
        raise OrderError("수량은 1~999개로 선택해 주세요.")
    candidate = store.resolved(product, options)
    if candidate.temperature is None and len(product["temperatures"]) == 1:
        candidate.temperature = product["temperatures"][0]
    validation = Options(**asdict(candidate))
    if validation.temperature is None:
        validation.temperature = product["temperatures"][0]
    store.validate(product, validation)
    if product.get("soldOut") or store.stock.get(product_id) == 0:
        raise OrderError("지금은 품절된 메뉴예요.")
    old = store.item_drafts.get(product_id, {})
    values = asdict(candidate)
    reviewed = {k: v for k, v in old.get("reviewed", {}).items() if values[k] == v}
    for key in confirmed_options:
        if values[key] is not None:
            reviewed[key] = values[key]
    keys = important_options(product, candidate)
    if use_defaults:
        # Explicit delegation can accept optional defaults, never guess hot/cold.
        reviewed.update({k: values[k] for k in keys if k != "temperature"})
    missing = [k for k in keys if k not in reviewed or values[k] is None]
    if missing:
        draft = {"product_id": product_id, "name": product["name"], "quantity": quantity,
                 "options": values, "reviewed": reviewed, "next_option": missing[0],
                 "question_options": [missing[0]] if missing[0] == "temperature" else missing,
                 "question": question([missing[0]] if missing[0] == "temperature" else missing, candidate)}
        store.item_drafts[product_id] = draft
        # Keep the editor in the returned state aligned with this turn's choices.
        # Read-only explanations otherwise retain the touch-edited selection.
        if (store.ui_context.get("editor") or {}).get("product_id") == product_id:
            store.ui_context["editor"].update(quantity=quantity, options=values)

        store.changed()
        return {"status": "needs_preference", "added": False, "draft": draft}
    # Keep the draft on failure so stock/cart errors cannot lose the request.
    result = store.add(product_id, quantity, candidate)
    if (store.ui_context.get("editor") or {}).get("product_id") == product_id:
        store.ui_context["editor"] = None
        result["ui_context"] = dict(store.ui_context)
    store.item_drafts.pop(product_id, None)
    result["item_drafts"] = list(store.item_drafts.values())
    return {"status": "added", "added": True, "cart": result}
