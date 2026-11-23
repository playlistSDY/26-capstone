"""Sync the kiosk contract and reuse existing, source-labelled drink facts offline."""
from copy import deepcopy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'order-agent/data'


def sync():
    products = json.loads((ROOT / 'kiosk-web/src/drink-catalog.json').read_text())
    old = {p['id']: p for p in json.loads((DATA / 'catalog.json').read_text())}
    knowledge = json.loads((DATA / 'menu-knowledge.json').read_text())
    original = knowledge['items']
    fields = ('id', 'name', 'sourceName', 'price', 'priceSource', 'description', 'categories', 'temperatures', 'coffee', 'milk', 'decaf', 'decafOnly', 'whippedCream', 'packaged', 'fixedOptions', 'fixedSize', 'iceAdjustable', 'soldOut')
    catalog, facts = [], {}
    for p in products:
        row = {key: p[key] for key in fields if key in p}
        row.setdefault('priceSource', 'prototype')
        catalog.append(row)
        source = p['id'] if p['id'] in original else next((pid for pid, item in old.items() if item['sourceName'] == p['sourceName'] and pid in original), None)
        if source is None:
            raise ValueError(f"메뉴 지식을 먼저 등록해 주세요: {p['id']} {p['name']}")
        item = deepcopy(original[source])
        item['name'], item['source_name'] = p['name'], p['sourceName']
        if p.get('decafOnly') and not any(v['decaf'] for v in item['variants']):
            if '아샷추' not in p['sourceName']:
                raise ValueError(f"디카페인 배합 정보를 먼저 등록해 주세요: {p['id']}")
            # Explicit demo recipe: peach iced tea (35mg) + decaf shot (7mg).
            estimated = []
            for v in item['variants']:
                candidate = deepcopy(v)
                candidate['decaf'] = True
                candidate['values']['caffeine_mg'] = round(42 * (1.4 if v['size'] == 'large' else 1), 1)
                candidate['value_origins'] = {key: 'demo_estimate' for key in candidate['values']}
                candidate['caffeine_level'] = '적음' if candidate['values']['caffeine_mg'] <= 50 else '보통'
                candidate['allergen_origin'] = 'demo_estimate'
                candidate['reference_recipe'] = '일반 아샷추 자료를 참고한 데모 디카페인 배합. 홍차 35mg과 디카페인 샷 7mg을 가정하며 공식 측정값이 아님.'
                candidate['official_name'] = '기본 아샷추 자료를 참고한 데모 디카페인 조합'
                if 'official_id' in candidate: candidate['reference_official_id'] = candidate.pop('official_id')
                estimated.append(candidate)
            item['variants'] = estimated
        variants = [v for v in item['variants'] if v['temperature'] in p['temperatures'] and (not p['fixedSize'] or v['size'] == 'regular') and (v['decaf'] is True if p.get('decafOnly') else (p['decaf'] or not v['decaf']))]
        if not variants:
            raise ValueError(f"판매 조합의 기존 메뉴 지식이 없어요: {p['id']}")
        item['variants'] = variants
        if source != p['id']:
            item['derived_from_product_id'] = source
        facts[p['id']] = item
    knowledge['items'] = facts
    # Write only after all menu/knowledge mappings validate.
    (DATA / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
    (DATA / 'menu-knowledge.json').write_text(json.dumps(knowledge, ensure_ascii=False, indent=2) + '\n')
    print(f"Synced {len(catalog)} menus and {sum(len(i['variants']) for i in facts.values())} supported knowledge variants")


if __name__ == '__main__':
    sync()
