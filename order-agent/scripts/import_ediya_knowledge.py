"""Build a fully populated, source-labeled demo knowledge base from Ediya facts."""
from pathlib import Path
import re, json, html, urllib.request, urllib.parse, hashlib, unicodedata
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / 'tmp' / 'ediya-source'
CACHE.mkdir(parents=True, exist_ok=True)
BASE = 'https://ediya.com'

def fetch(url, name, post=False):
    path = CACHE / name
    if path.exists(): return path.read_text()
    request = urllib.request.Request(url, data=b'' if post else None, headers={'User-Agent': 'SWitch-coursework-menu-research/1.0'})
    text = urllib.request.urlopen(request, timeout=25).read().decode('utf-8')
    path.write_text(text)
    return text

def clean(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip().replace('\u200b', '')

def field(block, cls):
    m = re.search(r'<div[^>]*class=["\']'+cls+r'["\'][^>]*>(.*?)</div>', block, re.S|re.I)
    return clean(m.group(1)) if m else ''

def normalize(name):
    name=unicodedata.normalize('NFKC', name).lower()
    name=re.sub(r'\((?:l|ex|r|병)\)|hot|iced|ice|디카페인|decaf|\s|[&·,\-]', '', name)
    return name.replace('마끼아또','마키아또').replace('초코렛','초콜릿')

records=[]
for page in range(1, 85):
    url = BASE+'/contents/drink.html' if page == 1 else BASE+f'/inc/ajax_brand.php?gubun=menu_more&product_cate=7&chked_val=&skeyword=&page={page}'
    text=fetch(url, f'page-{page}.html', page > 1)
    if page == 1:
        text=text.split('id="menu_ul"',1)[1]
    starts=list(re.finditer(r'id=["\']nutri_(\d+)["\']', text))
    if not starts: break
    for index,start in enumerate(starts):
        block=text[start.end():starts[index+1].start() if index+1<len(starts) else len(text)]
        title=re.search(r'<h2>(.*?)<span',block,re.S)
        if not title: continue
        name=clean(title.group(1))
        description=field(block,'detail_txt')
        nutrients={}
        for k,v in re.findall(r'<dt>(.*?)</dt>\s*<dd>(.*?)</dd>',block,re.S):
            num=re.search(r'-?\d+(?:\.\d+)?',clean(v).replace(',',''))
            if num: nutrients[clean(k)]=float(num.group())
        if not nutrients: continue
        english=re.search(r'<h2>.*?<span>(.*?)</span>',block,re.S)
        caffeine_note=field(block,'high_caffeine')
        records.append({'official_id':start.group(1),'name':name,'key':normalize(name),
          'temperature':'hot' if re.search(r'\bHOT\b',name,re.I) else 'ice' if re.search(r'\bICED?\b',name,re.I) else 'unspecified',
          'size':'large' if '(EX)' in name else 'regular',
          'decaf': '디카페인' in description or 'decaf' in clean(english.group(1) if english else '').lower(),
          'nutrients':nutrients,'allergy_text':field(block,'pro_allergy'),'size_text':field(block,'pro_size'),
          'ingredient_mentions':[word for word in ['우유','대두','초콜릿','오트','피스타치오','딸기','복숭아','망고','바나나','블루베리','말차','커피','연유','요거트','땅콩','아몬드','밀','꿀','레몬','자몽','유자','토피넛','고구마','흑임자','밤','계피','생강','캐모마일','루이보스','히비스커스','페퍼민트'] if word in description],
          'high_caffeine_warning':bool(caffeine_note),'source_url':url,'source_sha256':hashlib.sha256(block.encode()).hexdigest()})
    print('Page',page,'records',len(records),flush=True)

# Deduplicate by official product ID and save facts only, without copyrighted descriptions.
records=list({r['official_id']:r for r in records}.values())
products=json.loads((ROOT/'order-agent/data/catalog.json').read_text())
checked=datetime.now(timezone.utc).isoformat()
aliases={'초콜릿':'초콜릿','감귤레몬에이드':'감귤레몬에이드','말차라떼':'말차라떼'}

def taste_label(p, sugar):
    n=p['sourceName']
    sweetened=['제로슈가','바닐라','연유','흑당','모카','초콜릿','초코','쉐이크','플랫치노','주스','에이드','아이스티','스파클링','뽀로로','모구모구','달달','밀크티','헤이즐넛','꿀','카라멜','시그니처']
    if any(word in n for word in sweetened): return '꽤 달아요' if sugar>35 else '달아요'
    return '달지 않아요' if sugar==0 else '덜 달아요' if sugar<=15 else '달아요' if sugar<=35 else '꽤 달아요'

def estimate(p):
    n=p['sourceName']; coffee=p['coffee']; milk=p['milk']
    sweet_names=['라떼','모카','초콜릿','초코','밀크','쉐이크','플랫치노','주스','에이드','흑당','아이스티','달달','식혜','뽀로로','모구모구','스파클링']
    sugar=35 if any(w in n for w in sweet_names) else 0
    if n in ['카페 라떼','카푸치노']: sugar=12
    if '아메리카노' in n: sugar=15 if any(w in n for w in ['꿀','헤이즐넛']) else 0
    if '제로슈가' in n: sugar=0
    caffeine=150 if coffee else 0
    if '콜드브루' in n and coffee: caffeine=180
    if any(w in n for w in ['말차','녹차']): caffeine=60
    elif any(w in n for w in ['밀크티','얼그레이','자스민','아이스티','아샷추']): caffeine=35
    elif any(w in n for w in ['초코','초콜릿','모카']): caffeine=160 if coffee else 10
    if '아샷추' in n: caffeine=150
    ingredients=[]
    if coffee: ingredients += ['커피']
    if milk: ingredients += ['우유']
    ingredient_keys=['연유','바닐라','카라멜','초콜릿','초코','말차','민트','오트','피스타치오','딸기','복숭아','망고','바나나','블루베리','사과','감귤','한라봉','레몬','자몽','유자','고구마','흑임자','밤','꿀','요거트','토피넛','미숫가루','곡물','셀러리','키위','당근','홍시','쌍화','생강','페퍼민트','캐모마일','루이보스','히비스커스','얼그레이','홍차','포도','매실','배','모과','복분자','수박','쌀','리치','체리']
    ingredients += [word for word in ingredient_keys if word in n]
    if '초코' in n and '초콜릿' not in ingredients: ingredients.append('초콜릿')
    if '로열 밀크티' in n: ingredients.append('홍차')
    if not ingredients: ingredients=['정제수'] if any(w in n for w in ['워터','물']) else ['음료 베이스']
    allergens=[]
    if milk or any(w in n for w in ['크림','초콜릿','초코','쉐이크','요거트','연유','화이트','토피넛','미숫가루']): allergens.append('우유')
    if any(w in n for w in ['초콜릿','초코','오트','크림','토피넛','흑임자','미숫가루']): allergens.append('대두')
    if any(w in n for w in ['쿠키','미숫가루']): allergens.append('밀')
    if '복숭아' in n: allergens.append('복숭아')
    if any(w in n for w in ['넛츠','토피넛','피스타치오']): allergens.append('견과류')
    if '쿠키' in n: allergens.append('달걀')
    return {'sugar_g':sugar,'caffeine_mg':caffeine,'calories_kcal':round(sugar*4+(120 if milk else 10)),'protein_g':7 if milk else 0,'saturated_fat_g':3 if milk else 0,'sodium_mg':100 if milk else 10,'volume_ml':300 if p['packaged'] else 350,'ingredients':list(dict.fromkeys(ingredients)),'allergens':list(dict.fromkeys(allergens))}

knowledge={}
matched=0
for p in products:
    e=estimate(p); key=aliases.get(normalize(p['sourceName']),normalize(p['sourceName']))
    candidates=[r for r in records if r['key']==key]
    # Keep decaf and original recipes distinct even if official Korean titles match.
    variants=[]
    for temperature in p['temperatures']:
        for size in ['regular','large'] if not p['fixedSize'] else ['regular']:
            for decaf in [False,True] if p['decaf'] else [False]:
                exact=[r for r in candidates if r['size']==size and r['decaf']==decaf and r['temperature'] in [temperature,'unspecified']]
                exact.sort(key=lambda r:r['temperature']!=temperature)
                r=exact[0] if exact else None
                scale=1.35 if size=='large' else 1
                mapping={'sugar_g':'당류','caffeine_mg':'카페인','calories_kcal':'칼로리','protein_g':'단백질','saturated_fat_g':'포화지방','sodium_mg':'나트륨'}
                values={}; origins={}
                for target,label in mapping.items():
                    if r and label in r['nutrients']:
                        values[target]=r['nutrients'][label];origins[target]='official'
                    else:
                        values[target]=round((e[target] if target!='caffeine_mg' or not decaf else (7 if e[target] else 0))*scale,1);origins[target]='demo_estimate'
                m=re.search(r'(\d+(?:\.\d+)?)\s*ml', r['size_text'],re.I) if r else None
                values['volume_ml']=float(m.group(1)) if m else round(e['volume_ml']*scale)
                origins['volume_ml']='official' if m else 'demo_estimate'
                allergy=(r or {}).get('allergy_text','')
                contains=[s.strip() for s in re.split(r'[,/·]', re.sub(r'^.*?[:：]','',allergy)) if s.strip() and s.strip() not in ['-', '없음', '해당없음']] if allergy else e['allergens']
                variants.append({'temperature':temperature,'size':size,'decaf':decaf,'values':values,'value_origins':origins,
                    'sweetness':taste_label(p,values['sugar_g']),'sweetness_origin':'demo_estimate','sugar_level':'당류 없음' if values['sugar_g']==0 else '당류 적은 편' if values['sugar_g']<=15 else '당류 보통' if values['sugar_g']<=35 else '당류 많은 편',
                    'caffeine_level':'없음' if values['caffeine_mg']==0 else '적음' if values['caffeine_mg']<=50 else '보통' if values['caffeine_mg']<150 else '많음',
                    'allergens':contains,'allergen_origin':'official' if allergy else 'demo_estimate','allergen_note':allergy or ('데모 예상 주의 재료: '+', '.join(contains) if contains else '데모 예상: 알려진 주요 주의 재료 없음. 실제 제품의 무알레르기를 보장하는 뜻은 아님.'),
                    'cross_contact_note':'동일 제조 공간·도구를 통한 교차 접촉 가능성은 수치로 확정하지 않음',
                    'official_name':r['name'] if r else '해당 온도·크기·레시피의 공식 수치를 확인하지 못해 데모 추정',
                    'source_url':r['source_url'] if r else 'https://ediya.com/contents/drink.html?skeyword='+urllib.parse.quote(p['sourceName']),
                    'official_id':r['official_id'] if r else 'not_matched',
                    'reference_recipe':'공식 기본 레시피 또는 데모 추정 레시피. 샷·시럽·우유·얼음·당도 변경 후 수치는 재계산된 공식값이 아님'})
    if candidates: matched+=1
    mentions=list(dict.fromkeys(e['ingredients']+[word for r in candidates for word in r['ingredient_mentions']]))
    knowledge[p['id']]={'name':p['name'],'source_name':p['sourceName'],'summary':p['name']+' 음료예요. '+', '.join(e['ingredients'][:3])+'의 맛을 즐길 수 있어요.',
        'ingredients':[{'name':x,'amount_demo':60 if x=='커피' else 200 if x in ['우유','정제수'] else 2 if x in ['얼그레이','홍차','캐모마일','루이보스','히비스커스','페퍼민트','말차'] else 30,'amount_unit':'ml' if x in ['커피','우유','정제수'] else 'g','amount_origin':'demo_estimate','amount_note':'메뉴 설명·이름에서 확인 또는 추정한 재료. 배합 비율은 데모 기준으로만 사용','origin':'official_description' if any(x in r['ingredient_mentions'] for r in candidates) else 'demo_estimate'} for x in mentions],
        'ingredient_amounts_demo':{'base_liquid_ml':200 if p['milk'] else 250,'flavor_base_g':30 if e['sugar_g']>0 else 0,'coffee_shots':2 if p['coffee'] else 0,'note':'데모용 배합 예시이며 공식 레시피가 아님. 실제 원재료 비율은 비공개일 수 있음'},
        'variants':variants,'matched_official_records':len(candidates),'checked_at':checked,'data_purpose':'demo_with_estimates'}

out={'version':1,'checked_at':checked,'classification_policy':{'sweetness':'맛은 메뉴 종류·향미와 당류를 함께 사용한 데모 추정. 제로슈가·향미 음료는 당류가 낮아도 단맛으로 분류. 당류 등급은 별도 sugar_level이며 건강 기준이 아님','caffeine':'1잔 0mg=없음, 0초과~50mg=적음, 50초과~150미만=보통, 150mg이상=많음. 건강 안전 기준이 아닌 데모 비교','estimates':'확인되지 않은 수치는 메뉴명·음료 종류·일반적 레시피를 기준으로 만든 데모 가정. 실제 판매 제품 수치가 아님'},'items':knowledge}
path=ROOT/'order-agent/data/menu-knowledge.json';path.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
(CACHE/'facts.json').write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
print('Saved',len(knowledge),'items;',matched,'names matched;',len(records),'official variants')
print('Unmatched:',[p['sourceName'] for p in products if not knowledge[p['id']]['matched_official_records']])
