"""Read source-labeled menu facts without exposing the whole catalog to the LLM."""
from functools import lru_cache
import json
from pathlib import Path


@lru_cache(maxsize=1)
def database():
    return json.loads((Path(__file__).parents[1] / "data/menu-knowledge.json").read_text())


@lru_cache(maxsize=1)
def service_policy():
    return json.loads((Path(__file__).parents[1] / "data/store-service-policy.json").read_text())


def store_profile(item, variants):
    """Explicit fictional store facts, separate from reference provenance."""
    return {
        "scope": "fictional_demo_store_only",
        "name": item["name"],
        "description": item["summary"],
        "recipe": [{"ingredient": i["name"], "amount": i["amount_demo"], "unit": i["amount_unit"]} for i in item["ingredients"]],
        "recipe_basis": "등록된 기본 배합 예시. 온도·크기·추가 옵션별 영양 재계산은 하지 않는다.",
        "variants": [{"temperature": v["temperature"], "size": v["size"], "decaf": v["decaf"],
                      "sweetness": v["sweetness"], "caffeine_level": v["caffeine_level"],
                      "nutrition": v["values"], "allergy_ingredients": v["allergens"]} for v in variants],
        "preparation": service_policy()["preparation"],
        "allergy_handling": service_policy()["allergy_handling"],
        "response_policy": "등록된 데모 매장의 레시피·맛·수치를 사실형으로 짧게 안내한다. 출처 추정 표시는 내부 근거이며 고객에게 매번 읽지 않는다. 실제 이디야 공식 정보인지 물으면 구별한다. 알레르기 안전 보증과 미계산 옵션 영양 수치의 생성은 금지한다.",
    }


def details(product_id, temperature=None, size="regular", decaf=None):
    item = database()["items"][product_id]
    if decaf is None: decaf = all(v["decaf"] for v in item["variants"])
    ingredient_names = [ingredient["name"] for ingredient in item["ingredients"]]
    variants = [{**v, "ingredient_names": ingredient_names + [item["name"], item["source_name"]]} for v in item["variants"] if (temperature is None or v["temperature"] == temperature) and v["size"] == size and v["decaf"] == decaf]
    return {"store_profile": store_profile(item, variants), "summary": item["summary"], "ingredients": item["ingredients"], "ingredient_amounts_demo": item["ingredient_amounts_demo"], "variants": variants, "checked_at": item["checked_at"], "classification_policy": database()["classification_policy"], "default_response_policy": "고객이 수치를 묻지 않으면 짧고 쉬운 말로 맛·카페인·관련 주의 재료만 안내. 등록된 데모 매장 설정은 단정적으로 안내하고, 실제 브랜드 공식 정보와 혼동하지 않음."}


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
