"""576-dot monochrome receipt renderer shared by desktop preview and Windows printing."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

WIDTH = 576  # TM-m30, 72mm printable area at 203dpi


def validate_document(doc):
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
        raise ValueError("주문 내역이 올바르지 않아요.")
    if not 1 <= len(doc["items"]) <= 100:
        raise ValueError("주문 항목은 1~100개여야 해요.")
    for item in doc["items"]:
        if not isinstance(item, dict):
            raise ValueError("주문 항목 형식이 올바르지 않아요.")
        for key, limit in [("name", 200), ("optionsLabel", 600)]:
            if not isinstance(item.get(key), str) or len(item[key]) > limit:
                raise ValueError("메뉴명 또는 옵션이 너무 길어요.")
        if type(item.get("quantity")) is not int or not 1 <= item["quantity"] <= 99:
            raise ValueError("수량이 올바르지 않아요.")
        if type(item.get("unitPrice")) is not int or not 0 <= item["unitPrice"] <= 10000000:
            raise ValueError("단가 정보가 없거나 올바르지 않아요.")
    expected = sum(i["unitPrice"] * i["quantity"] for i in doc["items"])
    if type(doc.get("total")) is not int or doc["total"] != expected:
        raise ValueError("주문 합계와 항목 금액이 일치하지 않아요.")
    for key in ["id", "number", "createdAt", "place", "method"]:
        if not isinstance(doc.get(key), str) or len(doc[key]) > 200:
            raise ValueError("주문 정보가 올바르지 않아요.")
    return doc


def render_receipt(doc, variant, settings, font_path: Path, output: Path):
    validate_document(doc)
    scale = settings.get("fontScale", 1)
    measure = ImageDraw.Draw(Image.new("RGB", (WIDTH, 10), "white"))
    fonts = {}
    ops, y = [], 34

    def font(size, weight=450):
        key = (round(size * scale), weight)
        if key not in fonts:
            f = ImageFont.truetype(str(font_path), key[0])
            try:
                f.set_variation_by_axes([weight])
            except (OSError, AttributeError):
                pass
            fonts[key] = f
        return fonts[key]

    def wrap(text, f, width):
        result, line = [], ""
        for char in text:
            if char == "\n" or (line and measure.textlength(line + char, font=f) > width):
                result.append(line.rstrip())
                line = "" if char == "\n" else char
            else:
                line += char
        result.append(line.rstrip())
        return result

    def text(value, size=22, weight=450, align="left", right=None):
        nonlocal y
        f = font(size, weight)
        reserve = measure.textlength(right, font=f) + 28 if right else 0
        lines = wrap(str(value), f, WIDTH - 4 - reserve)
        line_height = round(size * scale * 1.5)
        for index, line in enumerate(lines):
            width = measure.textlength(line, font=f)
            x = (WIDTH - width) / 2 if align == "center" else 2
            ops.append(("text", (x, y), line, f))
            if index == 0 and right:
                ops.append(("text", (WIDTH - 2 - measure.textlength(right, font=f), y), right, f))
            y += line_height

    def gap(n=15):
        nonlocal y
        y += n

    def rule(dashed=True):
        nonlocal y
        gap(12)
        ops.append(("rule", y, dashed))
        gap(20)

    def money(value):
        return f"{value:,}원"

    text("SWitch", 64, 850, "center")
    text("C O F F E E", 19, 650, "center")
    gap(24)
    text("좋은 하루의 시작, 좋은 커피 한 잔.", 19, align="center")
    rule()
    text("픽업 주문서" if variant == "pickup" else "주문 영수증", 24, 750)
    gap(24)
    text("주문번호", 21, align="center")
    text(doc["number"], 140 if variant == "pickup" else 112, 850, "center")
    text(f'{doc["place"]} 주문', 30, 750, "center")
    gap(28)
    from datetime import datetime
    try:
        date = datetime.fromisoformat(doc["createdAt"].replace("Z", "+00:00")).astimezone().strftime("%Y.%m.%d %H:%M")
    except ValueError:
        date = doc["createdAt"][:19]
    quantity = sum(i["quantity"] for i in doc["items"])
    text(date, 20, right=f"총 {quantity}개")
    rule()
    text("주문 메뉴 / 옵션", 19, right="수량" if variant == "pickup" else "수량 · 금액")
    gap(12)
    for index, item in enumerate(doc["items"]):
        if index:
            rule()
        text(item["name"], 32 if variant == "pickup" else 28, 750,
             right=f'{item["quantity"]}개' if variant == "pickup" else money(item["unitPrice"] * item["quantity"]))
        text(item["optionsLabel"], 27 if variant == "pickup" else 24)
        if variant != "pickup":
            text("", 20, right=f'{money(item["unitPrice"])} × {item["quantity"]}')
        gap(12)
    rule()
    text("총 주문" if variant == "pickup" else "합계 금액", 33, 800,
         right=f"{quantity}개" if variant == "pickup" else money(doc["total"]))
    if variant != "pickup":
        gap(12)
        text("결제수단", 22, right=doc["method"])
        text("결제상태", 22, right="승인 완료")
    rule()
    text("옵션을 확인하고 준비해 주세요." if variant == "pickup" else "맛있게 준비해 드릴게요.", 23, 750, "center")
    text("주문번호가 불리면 픽업대에서 받아 주세요.", 18, align="center")
    gap(18)
    text("주문 ID " + doc["id"].replace("-", "")[-12:].upper(), 17, align="center")
    gap(56)
    if y > 15000:
        raise ValueError("영수증이 너무 길어요. 주문을 나눠 주세요.")
    image = Image.new("RGB", (WIDTH, y), "white")
    draw = ImageDraw.Draw(image)
    for op in ops:
        if op[0] == "text":
            draw.text(op[1], op[2], font=op[3], fill="black", anchor="lt")
        else:
            for x in range(0, WIDTH, 14 if op[2] else WIDTH):
                draw.line((x, op[1], min(x + 8, WIDTH), op[1]), fill="black", width=2)
    image.convert("1", dither=Image.Dither.NONE).save(output, dpi=(203, 203))
    return {"widthPx": WIDTH, "heightPx": y, "heightMm": round(y / 203 * 25.4, 2)}
