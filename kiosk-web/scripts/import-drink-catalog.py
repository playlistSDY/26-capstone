"""Import supplied drink photos without modifying their pixels; keep HOT/ICED as options."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import shutil
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
GROUPS={
'커피': '''카페 아메리카노|에스프레소|카페 라떼|바닐라 라떼|연유 카페 라떼|카라멜 마끼아또|카페 모카|화이트 초콜릿 모카|민트 모카|카푸치노|헤이즐넛 아메리카노|꿀화이트 아메리카노|달달커피|제로슈가 달달커피|시그니처 라떼|콜드브루|콜드브루 라떼|흑당 콜드브루|연유 콜드브루|오트 콜드브루|오트 커피|넛츠 크림 라떼|아포가토 오리지널|에스프레소 쉐이크''',
'논커피': '''가나 시그니처 초콜릿|가나 초코 크림 오트|고구마 라떼|달고나 라떼|달달퐁당 오트 피스타치오|딸기 듬뿍 라떼|딸기 초코 라떼|딸기퐁당 오트 피스타치오|말차라떼|말차초코라떼|미숫가루 라떼|민트 초콜릿|밤 크림 라떼|버블 흑당 라떼|초콜릿|토피넛 라떼|화이트 초콜릿|흑당 라떼|흑임자 크림 라떼|살얼음 식혜|생수박 과일 화채''',
'티': '''구망추|레몬 아이스티|레몬차|로열 밀크티|루이보스|말차폼 자스민티|배모과차|복분자 뱅쇼|복숭아 아이스티|생강차|쌍화차|아망추 복숭아|아샷추 복숭아|얼그레이|유자차|자몽차|제로슈가 아샷추 복숭아|제로슈가 아이스티 복숭아|캐모마일|페퍼민트|히비스커스|히비스커스 청귤티''',
'에이드': '''감귤 레몬 에이드|구아바 자스민 에이드|꿀복숭아 에이드|머스캣 모히또 에이드|샹그리아 에이드|자몽 포멜로 에이드''',
'블렌디드': '''꿀복숭아 요거트 플랫치노|꿀복숭아 플랫치노|딸기 쉐이크|딸기 요거트 플랫치노|말차 초코 쉐이크|망고 플랫치노|민트 초콜릿칩 플랫치노|밀크 쉐이크|블루베리 요거트 플랫치노|유자몽 플랫치노|초코쿠키 쉐이크|초콜릿 칩 플랫치노|토피넛 플랫치노|플레인 요거트 플랫치노''',
'과일 주스': '''딸기바나나주스|딸기주스|망고바나나주스|망고주스|블루베리바나나주스|블루베리주스|사과당근클렌즈주스|청도홍시주스|키위케일셀러리클렌즈주스''',
'병음료': '''(병)프루츠 스파클링 복숭아|(병)프루츠 스파클링 사과|(병)프루츠 스파클링 체리|모구모구(리치)|모구모구(복숭아)|비타민 주스 믹스베리|비타민 주스 애플망고|이디야 감귤&한라봉 주스|이디야 사과주스|이디야 워터|이디야 콤부차 복숭아 망고|이디야 콤부차 석류애플라임|이디야 콤부차 청포도 레몬|이디야키즈 뽀로로 사과매실|이디야키즈 뽀로로 오렌지|이디야키즈 뽀로로 포도블루베리''',
}
# Preserve existing IDs, names and prices so saved carts and historic orders still resolve.
LEGACY={
'카페 아메리카노':('americano','아메리카노',3200),'카페 라떼':('latte','카페라떼',4200),
'바닐라 라떼':('vanilla','바닐라라떼',4500),'연유 카페 라떼':('condensed','연유라떼',4500),
'카라멜 마끼아또':('caramel','카라멜마끼아또',3200),'카페 모카':('mocha','카페모카',4200),
'화이트 초콜릿 모카':('white-mocha','화이트초콜릿모카',4500),'민트 모카':('mint-mocha','민트모카',4500),
'콜드브루':('coldbrew','콜드브루',3200),'콜드브루 라떼':('coldbrew-latte','콜드브루라떼',4200),
'흑당 콜드브루':('brown-coldbrew','흑당콜드브루',4500),'초콜릿':('chocolate','초콜릿라떼',4200),
'말차라떼':('matcha','말차라떼',4500),'망고주스':('mango','망고 주스',4800),
'감귤 레몬 에이드':('lemon','감귤 레몬 에이드',4500),'플레인 요거트 플랫치노':('yogurt','플레인 요거트 플랫치노',4900),
'캐모마일':('chamomile','캐모마일 티',3500),'얼그레이':('earlgrey','얼그레이 티',3500),
}
POLICY=json.loads((Path(__file__).with_name('drink-photo-policy.json')).read_text(encoding='utf-8'))
RECOMMENDED=POLICY['recommended']
DECAF_PHOTOS=set(POLICY['decafPhotos'])
WHIPPED_CREAM=set(POLICY['whippedCreamMenus'])
MILKLESS_COFFEE={'카페 아메리카노','에스프레소','헤이즐넛 아메리카노','꿀화이트 아메리카노','콜드브루'}
DESCRIPTIONS={
'커피':'커피의 풍미를 즐기는 한 잔','논커피':'커피 없이 즐기는 부드럽고 달콤한 한 잔',
'티':'차의 향과 과일의 풍미를 즐겨 보세요','에이드':'상큼한 과일과 청량한 탄산의 만남',
'블렌디드':'시원하고 부드럽게 즐기는 블렌딩 음료','과일 주스':'과일의 풍미를 시원하게 즐겨 보세요',
'병음료':'간편하게 즐기는 완제품 음료',
}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);args=parser.parse_args()
    groups=defaultdict(dict);source_names=[]
    destination=ROOT/'public/assets/drinks';destination.mkdir(exist_ok=True)
    for file in sorted(args.folder.glob('*.png')):
        name=unicodedata.normalize('NFC',file.stem);match=re.match(r'^(HOT|ICED)\s+(.+)$',name)
        base=match[2] if match else name;temperature='hot' if match and match[1]=='HOT' else 'ice'
        group=(base,name+'.png' in DECAF_PHOTOS)
        if temperature in groups[group]:raise ValueError('Duplicate temperature: '+base)
        data=file.read_bytes();sha=hashlib.sha256(data).hexdigest();extension='.jpg' if data.startswith(b'\xff\xd8') else '.png';filename='drink-'+sha[:20]+extension
        shutil.copyfile(file,destination/filename)
        groups[group][temperature]={'path':'assets/drinks/'+filename,'source':unicodedata.normalize('NFC',file.name),'sha256':sha}
        source_names.append(name)
    category_by_name={}
    for category,names in GROUPS.items():
        for name in names.split('|'):
            if name in category_by_name:raise ValueError('Duplicate category: '+name)
            category_by_name[name]=category
    assert set(category_by_name)=={base for base,_ in groups}, 'Photo policy contains unknown/missing menu names'
    assert DECAF_PHOTOS <= {unicodedata.normalize('NFC',p.name) for p in args.folder.glob('*.png')}, 'Missing reviewed decaf photo'
    assert set(RECOMMENDED) <= set(category_by_name)
    order=sorted(groups,key=lambda key:(RECOMMENDED.index(key[0]) if key[0] in RECOMMENDED and not key[1] else len(RECOMMENDED),key))
    result=[]
    for base,is_decaf in order:
        category=category_by_name[base];photos=groups[(base,is_decaf)]
        id,name,price=LEGACY.get(base,('drink-'+hashlib.sha256(base.encode()).hexdigest()[:12],base,{'커피':4200,'논커피':4500,'티':3500,'에이드':4500,'블렌디드':5500,'과일 주스':4800,'병음료':2800}[category]))
        packaged=category=='병음료'
        if base=='이디야 워터':price=1500
        if is_decaf:
            if (base,False) in groups:id+='-decaf'
            name='디카페인 '+name
            price+=500  # Preserve the former decaf surcharge in the displayed base price.
        categories=(["추천 메뉴"] if base in RECOMMENDED and not is_decaf else [])+['디카페인' if is_decaf else category]
        coffee=category=='커피' or base in {'아샷추 복숭아','제로슈가 아샷추 복숭아'}
        milk=(category=='논커피' and base not in {'살얼음 식혜','생수박 과일 화채'}) or (category=='블렌디드' and '요거트' in base) or ('쉐이크' in base) or (coffee and base not in MILKLESS_COFFEE and '아샷추' not in base) or base in {'로열 밀크티','말차폼 자스민티'}
        row={'id':id,'name':name,'sourceName':base,'price':price,'priceSource':'prototype','description':DESCRIPTIONS[category],'categories':categories,
             'temperatures':[t for t in ['ice','hot'] if t in photos],'temperatureImages':{t:v['path'] for t,v in photos.items()},
             'sourcePhotos':list(photos.values()),'coffee':coffee,'milk':milk,'decaf':is_decaf,'decafOnly':is_decaf,'whippedCream':base in WHIPPED_CREAM,
             'packaged':packaged,'fixedOptions':packaged or base=='아포가토 오리지널','fixedSize':packaged or base in {'아포가토 오리지널','에스프레소'},
             'iceAdjustable':not packaged and category!='블렌디드' and base not in {'에스프레소','아포가토 오리지널','에스프레소 쉐이크'}}
        if base=='얼그레이':row['soldOut']=True
        result.append(row)
    assert len({p['id'] for p in result})==len(result)
    used={Path(photo['path']).name for row in result for photo in row['sourcePhotos']}
    for file in destination.glob('drink-*'):
        if file.is_file() and file.name not in used:file.unlink()
    (ROOT/'src/drink-catalog.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report={'sourceFiles':len(source_names),'products':len(result),'decafItems':sum(p['decafOnly'] for p in result),'whippedCreamItems':sum(p['whippedCream'] for p in result),'temperaturePairs':sum(len(p['temperatures'])==2 for p in result),'hotOnly':sum(p['temperatures']==['hot'] for p in result),'iceOnly':sum(p['temperatures']==['ice'] for p in result),'primaryCategories':dict(Counter(p['categories'][-1] for p in result)),'imagePixelsModified':False}
    (ROOT/'qa').mkdir(exist_ok=True)
    (ROOT/'qa/drink-import.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
