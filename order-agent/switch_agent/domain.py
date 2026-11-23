"""Authoritative demo order rules, independent of the model and SDK."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
import re
import time
from uuid import uuid4
from .language import translate, formatted


MAX_ORDER_QUANTITY = 999


class OrderError(ValueError):
    pass


@dataclass
class Options:
    temperature: str | None = None
    size: str = "regular"
    shots: int = 0
    syrup: int = 0
    milk: str = "regular"
    ice: str = "normal"
    sweetness: str = "normal"
    decaf: bool | None = None
    whippedCream: str = "normal"


@dataclass
class Line:
    id: str
    product_id: str
    quantity: int
    options: Options


@dataclass
class OrderStore:
    catalog: dict
    language: str = "ko"
    lines: list[Line] = field(default_factory=list)
    place: str | None = None
    revision: int = 0
    turn: int = 0
    phase: str = "ordering"
    focus: str | None = None
    pending: dict | None = None
    confirmation_at_turn_start: dict | None = None
    final_confirmation_text: str | None = None
    handoff: dict | None = None
    # Explicitly simulated stock, not inferred from kiosk catalog data.
    stock: dict[str, int | None] = field(default_factory=dict)
    utterance: str = ""
    item_drafts: dict = field(default_factory=dict)
    payment_ui: dict = field(default_factory=dict)
    payment_action: dict | None = None
    view: str = "menu"
    ui_context: dict = field(default_factory=dict)
    guidance: dict | None = None

    @classmethod
    def demo(cls):
        path = Path(__file__).parents[1] / "data" / "catalog.json"
        return cls({p["id"]: p for p in json.loads(path.read_text())})

    def begin_turn(self, text: str):
        if not text.strip() or len(text) > 4000:
            raise OrderError("발화는 1~4000자로 보내 주세요.")
        self.guidance = None
        self.turn += 1
        self.utterance = text
        self.final_confirmation_text = None
        self.confirmation_at_turn_start = deepcopy(self.pending)
        # The model interprets agreement in context. Entering method selection
        # never charges a card; cart mutations still invalidate the quote.

    def product(self, product_id):
        if product_id not in self.catalog:
            raise OrderError("등록된 메뉴 ID를 조회한 뒤 선택해 주세요.")
        return self.catalog[product_id]

    def line(self, line_id):
        found = next((l for l in self.lines if l.id == line_id), None)
        if found is None:
            raise OrderError("주문 항목을 다시 조회해 주세요.")
        return found

    def editable(self):
        if self.phase != "ordering":
            raise OrderError("주문 수정 전에 주문 단계로 돌아가 주세요.")

    def changed(self):
        self.revision += 1
        self.pending = self.confirmation_at_turn_start = None
        self.final_confirmation_text = None

    def defaults(self, p):
        return Options(temperature=p["temperatures"][0] if len(p["temperatures"]) == 1 else None, decaf=bool(p.get("decafOnly")))

    def resolved(self, p, o: Options):
        value = deepcopy(o)
        if value.decaf is None: value.decaf = bool(p.get("decafOnly"))
        return value

    def validate(self, p, o: Options):
        if o.temperature not in p["temperatures"]:
            raise OrderError("가능한 온도를 확인하고 선택해 주세요.")
        for name, allowed in {
            "size": {"regular", "large"}, "milk": {"regular", "oat"},
            "ice": {"normal", "more", "less", "none"}, "sweetness": {"normal", "less", "none"},
        }.items():
            if getattr(o, name) not in allowed:
                raise OrderError(f"지원하지 않는 옵션: {name}")
        if o.whippedCream not in {"normal", "extra", "none"}:
            raise OrderError("휘핑 옵션은 기본·추가·제거 중에서 선택해 주세요.")
        if not p.get("whippedCream") and o.whippedCream != "normal":
            raise OrderError("이 메뉴에서는 휘핑을 변경할 수 없어요.")
        if p.get("decafOnly") and o.decaf is not True:
            raise OrderError("이 메뉴는 디카페인 원두로만 주문할 수 있어요.")
        if type(o.decaf) is not bool:
            raise OrderError("디카페인은 참/거짓으로 선택해 주세요.")
        if any(type(n) is not int or not 0 <= n <= 3 for n in (o.shots, o.syrup)):
            raise OrderError("샷과 시럽 추가는 각각 0~3개예요.")
        if p["fixedSize"] and o.size != "regular":
            raise OrderError("이 메뉴는 기본 크기만 가능해요.")
        if p["fixedOptions"] and o != self.defaults(p):
            raise OrderError("이 메뉴는 수량만 변경할 수 있어요.")
        if (not p["coffee"] and o.shots) or (not p["milk"] and o.milk != "regular") or (not p["decaf"] and o.decaf):
            raise OrderError("이 메뉴에서 지원하지 않는 옵션이에요.")
        if o.ice != "normal" and (o.temperature == "hot" or not p["iceAdjustable"]):
            raise OrderError("이 메뉴 또는 온도에서는 얼음 양을 바꿀 수 없어요.")

    def validate_cart(self, lines):
        if sum(l.quantity for l in lines) > MAX_ORDER_QUANTITY:
            raise OrderError("한 주문은 총 999개까지 가능해요.")
        quantities = {}
        combinations = {}
        for l in lines:
            p = self.product(l.product_id)
            self.validate(p, l.options)
            if type(l.quantity) is not int or not 1 <= l.quantity <= MAX_ORDER_QUANTITY:
                raise OrderError("한 항목은 1~999개까지 가능해요.")
            key = (l.product_id, json.dumps(asdict(l.options), sort_keys=True))
            combinations[key] = combinations.get(key, 0) + l.quantity
            if combinations[key] > MAX_ORDER_QUANTITY:
                raise OrderError("같은 옵션의 메뉴는 총 999개까지 가능해요.")
            if p.get("soldOut"):
                raise OrderError(f"{p['name']} 메뉴는 품절이에요.")
            quantities[l.product_id] = quantities.get(l.product_id, 0) + l.quantity
        for pid, quantity in quantities.items():
            stock = self.stock.get(pid)
            if stock is not None and quantity > stock:
                raise OrderError(f"{self.product(pid)['name']} 재고가 부족해요.")

    def unit_price(self, line):
        o = line.options
        return self.product(line.product_id)["price"] + (500 if o.size == "large" else 0) + o.shots * 500 + o.syrup * 300 + (600 if o.milk == "oat" else 0) + (500 if o.decaf and not self.product(line.product_id).get("decafOnly") else 0)

    def snapshot(self):
        return {
            "mode": "mock", "price_source": "prototype", "phase": self.phase, "language": self.language,
            "revision": self.revision, "place": self.place, "focus": self.focus,
            "lines": [dict(asdict(l), name=self.product(l.product_id)["name"], unit_price=self.unit_price(l)) for l in self.lines],
            "total": sum(self.unit_price(l) * l.quantity for l in self.lines),
            "confirmation_pending": self.pending is not None,
            "view": self.view, "ui_context": deepcopy(self.ui_context), "payment_ui": deepcopy(self.payment_ui),
            "payment_action": deepcopy(self.payment_action),
            "guidance": deepcopy(self.guidance),
            "handoff": deepcopy(self.handoff),
            "item_drafts": deepcopy(list(self.item_drafts.values())),
        }

    def add(self, product_id, quantity, options: Options):
        self.editable()
        line = Line(uuid4().hex, product_id, quantity, self.resolved(self.product(product_id), options))
        candidate = self.lines + [line]
        self.validate_cart(candidate)
        self.lines = candidate
        self.focus = line.id
        self.changed()
        return self.snapshot()

    def edit(self, line_id, quantity, options: Options, product_id=None):
        self.editable()
        old = self.line(line_id)
        candidate = [Line(l.id, product_id or old.product_id, quantity, self.resolved(self.product(product_id or old.product_id), options)) if l.id == line_id else deepcopy(l) for l in self.lines]
        self.validate_cart(candidate)
        self.lines = candidate
        self.focus = line_id
        self.changed()
        return self.snapshot()

    def split(self, line_id, quantity, options: Options):
        self.editable()
        old = self.line(line_id)
        if type(quantity) is not int or not 0 < quantity < old.quantity:
            raise OrderError("나눌 수량은 원래 수량보다 적어야 해요.")
        candidate = deepcopy(self.lines)
        next(l for l in candidate if l.id == line_id).quantity -= quantity
        line = Line(uuid4().hex, old.product_id, quantity, self.resolved(self.product(old.product_id), options))
        candidate.append(line)
        self.validate_cart(candidate)
        self.lines = candidate
        self.focus = line.id
        self.changed()
        return self.snapshot()

    def remove(self, line_id):
        self.editable()
        self.line(line_id)
        self.lines = [l for l in self.lines if l.id != line_id]
        if self.focus == line_id:
            self.focus = None
        self.changed()
        return self.snapshot()

    def set_place(self, place):
        if not (self.phase == "checkout" and not self.payment_ui.get("payment")):
            self.editable()
        if place not in {"store", "takeout"}:
            raise OrderError("매장 또는 포장을 선택해 주세요.")
        if self.place != place:
            self.place = place
            self.changed()
        return self.snapshot()

    def summary(self):
        parts = []
        for l in self.lines:
            o = l.options
            labels = ["따뜻한" if o.temperature == "hot" else "차가운", "큰 크기" if o.size == "large" else "기본 크기"]
            if o.decaf and "디카페인" not in self.product(l.product_id)["name"]: labels.append("디카페인")
            if o.shots: labels.append(f"샷 {o.shots}개 추가")
            if o.syrup: labels.append(f"시럽 {o.syrup}개 추가")
            if o.milk == "oat": labels.append("오트밀크")
            if o.ice != "normal": labels.append({"more": "얼음 많이", "less": "얼음 적게", "none": "얼음 없이"}[o.ice])
            if o.whippedCream != "normal": labels.append("휘핑 추가" if o.whippedCream == "extra" else "휘핑 제거")
            if o.sweetness != "normal": labels.append("덜 달게" if o.sweetness == "less" else "시럽 없이")
            if self.language == "ko":
                parts.append(f"{' '.join(labels)} {self.product(l.product_id)['name']} {l.quantity}잔")
            else:
                translated = [translate(self.language, label) for label in labels]
                name = translate(self.language, self.product(l.product_id)['name'])
                parts.append(" ".join(translated) + " " + formatted(self.language, "{name} {quantity}잔", name=name, quantity=l.quantity))
        return ", ".join(parts) if parts else "아직 담은 메뉴가 없어요"

    def request_confirmation(self):
        self.editable()
        if self.ui_context.get("editor"):
            raise OrderError("선택 중인 메뉴를 먼저 담거나 옵션 창을 닫아 주세요.")
        if self.item_drafts:
            raise OrderError("아직 담기 전인 메뉴의 옵션을 선택하거나 그 메뉴를 취소해 주세요.")
        if not self.lines or self.place is None:
            raise OrderError("메뉴와 매장/포장 선택을 먼저 마쳐 주세요.")
        self.validate_cart(self.lines)
        self.view = "review"
        self.pending = {"revision": self.revision, "turn": self.turn, "created": time.monotonic(), "delivered": False}
        self.final_confirmation_text = f"{'매장에서 드시는' if self.place == 'store' else '포장하시는'} 주문은 {self.summary()}, 총 {self.snapshot()['total']:,}원이에요. 이대로 결제할까요?"
        if self.language != "ko":
            self.final_confirmation_text = formatted(self.language, "{place} 주문은 {summary}, 총 {total}원이에요. 이대로 결제할까요?", place=translate(self.language, "매장" if self.place == "store" else "포장"), summary=self.summary(), total=f"{self.snapshot()['total']:,}")
        return {"summary": self.final_confirmation_text, "revision": self.revision}

    def delivered(self):
        if self.pending and self.final_confirmation_text:
            self.pending["delivered"] = True

    def checkout(self):
        # This opens method selection, never approves or charges a payment.
        # Do not gate it on speech playback, message ACKs, or quote tokens.
        if self.phase != "checkout":
            self.editable()
        if not self.lines:
            raise OrderError("먼저 메뉴를 골라 주세요.")
        if self.place is None:
            raise OrderError("드시고 가세요, 포장해 드릴까요?")
        self.validate_cart(self.lines)
        self.phase = "checkout"
        self.view = "payment"
        self.pending = self.confirmation_at_turn_start = None
        return {"event": "checkout.opened", "mode": "mock", "cart": self.snapshot(), "payment_executed": False}

    def return_to_order(self):
        if self.phase in {"handoff", "completed"}:
            raise OrderError("완료되거나 인계한 주문은 새 세션을 시작해 주세요.")
        if self.payment_ui.get("payment") and self.payment_ui["payment"]["status"] not in {"failure", "timeout"}:
            raise OrderError("진행 중인 결제를 먼저 취소해 주세요.")
        self.phase = "ordering"
        self.view = "review"
        self.payment_action = None
        self.changed()
        return self.snapshot()
