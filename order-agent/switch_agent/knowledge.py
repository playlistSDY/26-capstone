"""Read source-labeled menu facts without exposing the whole catalog to the LLM."""
from functools import lru_cache
import json
from pathlib import Path


@lru_cache(maxsize=1)
def database():
    return json.loads((Path(__file__).parents[1] / "data/menu-knowledge.json").read_text())


def details(product_id, temperature=None, size="regular", decaf=False):
    item = database()["items"][product_id]
    ingredient_names = [ingredient["name"] for ingredient in item["ingredients"]]
    variants = [{**v, "ingredient_names": ingredient_names + [item["name"], item["source_name"]]} for v in item["variants"] if (temperature is None or v["temperature"] == temperature) and v["size"] == size and v["decaf"] == decaf]
    return {"summary": item["summary"], "ingredients": item["ingredients"], "ingredient_amounts_demo": item["ingredient_amounts_demo"], "variants": variants, "checked_at": item["checked_at"], "classification_policy": database()["classification_policy"], "default_response_policy": "고객이 수치를 묻지 않으면 짧고 쉬운 말로 맛·카페인·관련 주의 재료만 안내. 데모 추정값을 공식 수치로 말하지 않음."}


def normalize_ingredient(name):
    return name.casefold().replace(" ", "").replace("카모마일", "캐모마일").replace("chamomile", "캐모마일")


def normalize_allergen(name):
    name = normalize_ingredient(name)
    if any(word in name for word in ["달걀", "계란", "난류"]): return "달걀"
    if any(word in name for word in ["견과", "땅콩", "아몬드", "피스타치오", "호두", "헤이즐넛"]): return "견과류"
    if any(word in name for word in ["대두", "콩", "두유"]): return "대두"
    if "우유" in name or "유제품" in name: return "우유"
    return name


def suitable(variant, caffeine, sweetness, avoid):
    if caffeine == "none" and variant["values"]["caffeine_mg"] != 0: return False
    if caffeine == "low" and variant["values"]["caffeine_mg"] > 50: return False
    if sweetness == "less" and variant["sweetness"] not in {"달지 않아요", "덜 달아요"}: return False
    if sweetness == "sweet" and variant["sweetness"] not in {"달아요", "꽤 달아요"}: return False
    contains = {normalized for name in variant["allergens"] + variant.get("ingredient_names", []) for normalized in (normalize_ingredient(name), normalize_allergen(name))}
    return not any(excluded and excluded in ingredient for excluded in map(normalize_allergen, avoid) for ingredient in contains)
