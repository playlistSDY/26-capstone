# 키오스크 API 제공 요청 명세

SWitch 에이전트가 메뉴를 정확히 안내하고 주문 변경 결과를 확인하려면, 키오스크 서버가 메뉴·옵션·재고·장바구니·결제 화면의 상태를 구조적으로 제공해야 한다. 아래는 키오스크 개발팀에 전달하기 위한 v0.1 제안이다. 현재 제공되는 API가 아니며, HTTP 경로는 협의 가능한 이름이다. 데이터 의미와 서버의 보장 조건을 우선 합의한다.

## 책임과 우선순위

키오스크 서버는 판매 가능 여부, 옵션 유효성, 금액 계산, 장바구니 저장, 결제 상태의 최종 권위다. 에이전트는 자연어를 요청으로 변환하며, 추측한 재고나 자체 계산값으로 결제를 확정하지 않는다. 화면 터치와 에이전트 변경은 같은 장바구니를 공유한다.

P0는 주문 에이전트 연동에 필수다. P1은 운영과 대화 품질을 개선하는 항목이다. 재고 수량을 제공할 수 없는 매장은 null을 반환할 수 있지만, 주문 가능 여부와 최종 서버 검증은 P0다. 알레르기 정보는 값이 없을 때 unknown으로 구별하는 계약이 P0이며, 모든 메뉴의 성분 데이터 구축 자체는 별도 업무다.

## 공통 규칙

- 기준 경로는 `/v1/stores/{store_id}`. 인증된 기기 자격증명에 매장·기기·접근 가능한 세션을 묶는다. 모델이 보낸 store_id만 신뢰하지 않는다. API 키를 모델 입력이나 프론트엔드에 넣지 않는다.
- JSON은 UTF-8, 금액은 KRW의 정수 원, 시각은 UTC RFC 3339다. 수량은 정수이며 단위도 반환한다. null은 모름이며 0과 다르다.
- 성공 응답은 `request_id`, `server_time`, `data`를 포함한다. 목록은 `items`, `next_cursor`를 반환한다. 모든 변경은 변경 후의 서버 장바구니를 반환한다.
- 모든 장바구니 변경에는 `Idempotency-Key`와 `expected_cart_version`을 보낸다. 같은 키·같은 내용은 같은 결과를 반환하며 효과를 반복하지 않는다. 같은 키·다른 내용은 `IDEMPOTENCY_CONFLICT`다. 키 보존 기간은 최소 세션 수명과 네트워크 재시도 기간을 포함하도록 합의하고 capabilities로 공개한다.
- 버전 충돌은 409와 최신 장바구니를 반환한다. 수정 의도를 최신 장바구니에서 다시 해석하며 자동 덮어쓰지 않는다. 부분 변경을 허용하지 않는 요청은 전체 성공 또는 전체 실패다.
- 타임아웃은 실패 확정이 아니다. `GET /operations/{idempotency_key}`로 상태를 확인하고, 같은 키로만 재시도한다.
- 읽기 데이터의 `catalog_version`, `inventory_version`, `observed_at`, `valid_until`을 구별한다. 장바구니에 담았다고 재고가 확보되었다고 말하지 않는다. 재고 확보 정책은 checkout 견적 응답에 명시한다.

## 필요한 API 목록

아래 경로는 공통 기준 경로 뒤에 붙는다.

| 우선순위 | 메서드와 경로 | 제공할 기능 |
| --- | --- | --- |
| P0 | GET `/capabilities` | 지원 기능, 옵션 규칙 버전, 재고 정책, 호출 제한, 멱등 보존 기간 |
| P0 | GET `/catalog/categories` | 카테고리 ID·이름·순서·활성 여부 |
| P0 | GET `/catalog/items` | 검색·필터·페이지 구분된 메뉴 목록 |
| P0 | GET `/catalog/items/{item_id}` | 메뉴·변형·필수 옵션·옵션 제약·기본값 |
| P0 | POST `/availability/check` | 요청한 메뉴·옵션 조합과 수량의 현재 판매 가능 여부 |
| P0 | POST `/sessions` | 익명 주문 세션과 장바구니 생성, 세션 만료 조건 |
| P0 | GET `/sessions/{session_id}/cart` | 터치 변경까지 반영한 현재 주문·금액·버전 |
| P0 | POST `/sessions/{session_id}/cart/commands` | 추가·수정·분리·삭제·전체 비우기·매장/포장 변경 |
| P0 | POST `/sessions/{session_id}/quotes` | 최신 가격·판매 가능 여부 검증, 최종 확인용 견적 |
| P0 | POST `/sessions/{session_id}/checkout` | 확인한 견적에 대해 결제 화면 진입 |
| P0 | GET `/sessions/{session_id}/checkout` | 실제 결제 화면과 승인 진행 상태 |
| P0 | POST `/sessions/{session_id}/checkout/return` | 결제 진행 상태를 확인해 주문 수정 화면으로 복귀 |
| P0 | GET `/operations/{idempotency_key}` | 실행 중·성공·실패·미접수 여부와 확정 결과 |
| P0 | GET `/sessions/{session_id}/view` | 화면 단계·현재 선택 항목·허용 동작 |
| P1 | POST `/sessions/{session_id}/view/commands` | 카테고리·메뉴·주문 항목 선택, 상세/장바구니 표시, 이전 화면 |
| P1 | GET `/events` | SSE 또는 WebSocket으로 장바구니·품절·옵션·결제 변경 알림 |
| P1 | POST `/sessions/{session_id}/handoffs` | 직원에게 실제 알림과 인계 내용 전송, 수신 상태 |

`view` 명령은 실제 화면 이동이 필요할 때만 사용한다. 에이전트가 메뉴를 읽는 동작은 카탈로그를 조회한 뒤 텍스트로 설명하는 것이며, 모든 읽기마다 화면을 이동시키지 않는다. view 명령으로 금액이나 주문을 변경하지 않는다.

## 메뉴 데이터

메뉴 목록은 `query`, `category_id`, `available_only`, `max_price`, `cursor`, `limit`를 지원한다. 메뉴명 검색에는 별칭·띄어쓰기 변형을 포함한다. 검색 점수는 추천 후보의 참고이며 주문 확정 근거가 아니다. 다음은 예시 데이터이고 실제 판매 정책이 아니다.

```json
{
  "item_id": "latte",
  "name": "카페라떼",
  "aliases": ["카페 라떼", "라떼"],
  "description": "메뉴 설명",
  "category_ids": ["coffee"],
  "base_price": 4200,
  "currency": "KRW",
  "price_source": "prototype",
  "tax_included": true,
  "image_url": null,
  "active": true,
  "available_order_types": ["store", "takeout"],
  "sale_windows": [],
  "quantity_limit": {"min": 1, "max_per_line": 999, "max_per_cart": 999},
  "availability": {
    "status": "available",
    "reason_code": null,
    "stock_quantity": null,
    "stock_unit": "cup",
    "observed_at": "2026-11-20T12:00:00Z"
  },
  "allergen_info": {"status": "unknown", "contains": null, "cross_contact": null},
  "caffeine_mg": null,
  "catalog_version": "catalog-17"
}
```

`active=false`는 판매 중단이며 일시 품절과 구분한다. availability.status는 available, sold_out, temporarily_unavailable, unknown을 구분한다. unknown 상태에서 실제로 접수할 수 있는지는 서버 검증 정책으로 결정하고 응답에 명시한다. 시제품과 실제 매장 데이터를 혼용하지 않는다.

카페인 0과 정보 없음, 우유 미함유와 성분 정보 없음도 구별한다. 알레르기 정보에는 출처·갱신 시각·교차 접촉 가능성을 제공하는 것을 권장한다. 단순 메뉴 카테고리로 알레르기 안전성을 추정하지 않는다.

## 옵션과 제한사항

메뉴 상세에 option_groups와 variant_id를 제공한다. 온도·크기별 실제 상품이나 재고 단위가 다르면 변형 ID로 구별한다. 옵션 그룹·선택지 ID는 표시 문자열과 별도로 안정적으로 유지한다.

| 필드 | 의미 |
| --- | --- |
| group_id, name | 옵션 그룹의 안정적 ID와 읽기 쉬운 이름 |
| required, min_selections, max_selections | 필수 여부와 선택 개수 제한 |
| default_choice_ids | 사용자가 선택하지 않았을 때 적용할 기본값 |
| selection_mode | single 또는 multiple |
| choice_id, name, aliases | 선택지 ID·이름·발화 별칭 |
| price_delta 또는 price_rule_id | 추가 금액. 복잡한 금액은 quote가 최종 계산 |
| min_quantity, max_quantity, step | 샷·시럽 등 선택지별 개수 제한 |
| available, disabled_reason | 선택지 자체의 품절·비활성 상태 |
| scope | per_unit 또는 per_line. 두 잔에 적용되는 추가 금액의 기준 |
| rules | 선행 선택, 상호 배타, 허용·금지 조합 |
| removable, removal_effect | 옵션 제외 가능 여부와 기본 복원/성분 제거의 차이 |

필수 그룹에 기본값이 없다면 선택을 요구한다. “샷 추가 제외”는 추가 샷을 0으로 되돌릴 수 있지만, “기본 에스프레소를 전부 빼기”는 별도 허용 규칙이 있어야 한다. “우유 빼 주세요”도 오트밀크로 바꾸는 것과 다르다. 제거 불가능한 기본 재료를 제거했다고 응답해서는 안 된다.

규칙은 자연어 설명만 주지 말고 평가 가능한 구조를 함께 제공한다. 아래의 규칙 표현식은 제안이며 지원 연산자는 capabilities의 rule_schema_version으로 고정한다. 에이전트에서 미리 안내하더라도 서버가 같은 규칙을 최종 검사해야 한다.

```json
{
  "option_groups": [
    {
      "group_id": "temperature",
      "name": "온도",
      "required": true,
      "selection_mode": "single",
      "min_selections": 1,
      "max_selections": 1,
      "default_choice_ids": [],
      "choices": [
        {"choice_id": "hot", "name": "따뜻하게", "price_delta": 0, "available": true},
        {"choice_id": "ice", "name": "차갑게", "price_delta": 0, "available": true}
      ]
    }
  ],
  "rules": [
    {
      "rule_id": "hot-no-ice-control",
      "when": {"group_id": "temperature", "choice_id": "hot"},
      "effect": {"disable_group_id": "ice_amount"},
      "reason": "따뜻한 음료에서는 얼음 양을 선택할 수 없어요."
    }
  ]
}
```

최소한 온도별 크기 제한, 병음료 고정 옵션, 디카페인 가능 메뉴, 우유 대체 가능 여부, 추가 샷 범위, 시럽 제거 가능 여부, 얼음 조절 가능 여부, 유료 옵션, 옵션 품절을 제공해야 한다. 옵션 변경으로 기존 선택이 무효가 되면 서버가 조용히 지우지 말고 `invalidated_selections`와 재선택 필요 여부를 반환한다. 자동 보정은 요청이 허용한 경우에만 하고 반영 내용을 응답에 명시한다.

## 재고와 품절

품목 단위, 변형 단위, 옵션 단위, 공용 원재료 소진으로 인한 판매 불가를 구별할 수 있어야 한다. 원재료 레시피 전체를 공개할 필요는 없지만 요청한 조합을 몇 개까지 판매할 수 있는지 또는 왜 불가능한지 서버가 판단해야 한다.

```json
{
  "lines": [
    {
      "client_line_id": "candidate-1",
      "item_id": "latte",
      "variant_id": "latte-ice",
      "quantity": 2,
      "selections": [{"group_id": "milk", "choice_id": "oat", "quantity": 1}]
    }
  ],
  "cart_id": "cart-123",
  "expected_cart_version": 7
}
```

availability/check는 각 후보에 `orderable`, `max_orderable_quantity`(모르면 null), `reason_code`, `affected_option_ids`, `alternatives`, `inventory_version`, `observed_at`, `valid_until`을 반환한다. 같은 장바구니의 다른 항목이 공용 원재료를 소비하는 상황도 함께 계산한다. 단순 메뉴별 재고를 각각 통과시키는 것으로 충분하지 않다.

품절 사유는 ITEM_SOLD_OUT, VARIANT_SOLD_OUT, OPTION_SOLD_OUT, INGREDIENT_UNAVAILABLE, OUTSIDE_SALE_WINDOW, QUANTITY_EXCEEDED, STOCK_UNKNOWN 등으로 구분한다. 대안은 실제 가능한 메뉴·옵션 ID만 반환하며, 대안으로 자동 교체하지 않는다.

초기 장바구니 추가와 결제 직전 재고가 달라질 수 있다. 견적에서 재고를 확보한다면 reservation_id, expires_at, 대상 수량을 반환하고 변경·취소·만료 시 해제 정책을 정한다. 확보하지 않는다면 reserved=false를 명시하고 결제 진입 시 원자적으로 다시 검증한다.

## 장바구니 명령

한 명령 요청에 `expected_cart_version`과 `commands`를 넣는다. 여러 명령은 전체 원자적 적용을 기본으로 한다. UI 터치와 에이전트 요청이 경쟁하면 먼저 반영된 버전만 성공한다.

| command.type | 필수 내용 | 의미 |
| --- | --- | --- |
| add_line | client_line_id, item_id, variant_id, quantity, selections | 항목 추가 |
| update_line | line_id, quantity, selections | 절대 수량과 전체 옵션 집합으로 변경 |
| replace_line | line_id, 새 item_id·variant_id·selections·quantity | 메뉴 교체를 하나의 원자적 요청으로 처리 |
| split_line | line_id, split_quantity, selections | 일부 수량만 다른 옵션으로 분리 |
| remove_line | line_id | 항목 전체 삭제 |
| clear_cart | 명시적 사용자 요청에 연결한 command_id | 전체 주문 비우기 |
| set_order_type | order_type | store 또는 takeout |

수량은 절대값으로 지정한다. “하나 더”를 모델이 해석해 현재 2개를 3개로 요청하고, 버전 충돌이 나면 다시 조회한다. 상대 증가 명령을 재시도해 수량이 중복 증가하는 일을 막는다. 두 잔 중 한 잔 옵션 변경은 split_line으로 한 번에 반영한다.

성공 응답의 cart에는 cart_id, version, order_type, lines, total_quantity, totals, unresolved_requirements를 포함한다. 각 line에는 안정적인 line_id, item_id, variant_id, quantity, selections, 표시 이름·옵션 문구, base_unit_price, option_unit_price, line_total, available을 포함한다. 합쳐진 항목은 line_id 매핑을 반환해 에이전트의 선택 대상이 사라지지 않게 한다.

할인·쿠폰·세금·포장비가 있다면 subtotal, discounts, fees, tax, total과 적용 사유를 분리해 반환한다. 에이전트가 메뉴 단가를 곱해서 만든 금액을 결제 금액으로 사용하지 않는다.

## 최종 견적과 결제 진입

`POST /quotes`는 cart_version과 현재 판매 조건을 검증해 quote_id, cart_version, 금액 상세, 읽기용 주문 요약 데이터, expires_at, reservation 상태, confirmation_token을 반환한다. 미선택 필수 옵션·빈 주문·누락된 매장/포장·품절이 있으면 견적을 만들지 않는다.

에이전트 호스트는 최종 요약의 메시지 ID와 전체 전달 완료를 기록한다. 후속 음성 출력에서 중간에 끊긴 요약은 확인 대상으로 활성화하지 않는다. 사용자 동의는 해당 메시지에 대한 새로운 최종 발화 이벤트와 연결한다.

```json
{
  "expected_cart_version": 8,
  "quote_id": "quote-456",
  "confirmation_token": "opaque-server-issued-token",
  "confirmation_evidence": {
    "summary_message_id": "msg-10",
    "delivery_event_id": "delivery-10",
    "utterance_event_id": "utt-11",
    "confirmed_at": "2026-11-20T12:00:20Z"
  }
}
```

confirmation_token은 서버가 세션·장바구니 버전·quote·금액·만료에 묶어 발급한다. evidence는 신뢰된 에이전트 호스트가 인증된 이벤트로 채우고 모델의 함수 인자로 노출하지 않는다. 문자열 ID만 있다고 동의를 입증하는 것은 아니므로 이벤트의 소유 세션·순서·전달 완료를 서버 또는 신뢰된 호스트에서 검증한다. 자연어의 동의 의도 판단 자체는 여전히 대화 계층의 책임이다.

장바구니·가격·필수 옵션이 바뀌거나 견적이 만료되면 기존 token으로 진입할 수 없다. 재고가 부족하면 사용자에게 대안을 안내하고 변경된 주문으로 다시 확인받는다. 서버가 결제 화면을 실제 열었다는 응답을 받아야 이동했다고 안내한다.

checkout 응답은 checkout_id, status, cart_version, quote_id, payment_executed=false를 반환한다. 상태는 not_started, opening, ready, processing, succeeded, failed, canceled, unknown으로 구분한다. opening은 실제 표시 완료와 다르다. 결제 승인 succeeded는 결제 시스템이 제공한 결과에만 사용한다.

checkout/return은 결제 승인 중이면 임의로 주문을 수정하지 않고 CANNOT_RETURN_WHILE_PROCESSING 등을 반환한다. 승인 여부를 모르면 서버 상태를 조회해야 한다. 결제 후 취소·환불은 이번 에이전트 도구에 포함하지 않는다.

## 이벤트와 화면 상태

이벤트는 event_id, sequence, type, session_id, cart_version, occurred_at, data를 포함한다. Last-Event-ID 또는 sequence로 재연결과 누락 복구를 지원한다. 이벤트가 누락되거나 순서가 역전되면 GET cart/checkout/view로 상태를 다시 동기화한다.

필요 이벤트는 catalog.updated, availability.changed, cart.updated, selection.changed, checkout.ready, payment.status_changed, session.expiring, staff.handoff_acknowledged다. touch/agent/system 등 변경 출처도 반환하되, 출처만으로 오래된 장바구니 버전을 무시하지 않는다. 터치로 주문이 바뀌면 이전 최종 확인도 무효다.

view 응답은 screen(stage), selected_item_id, selected_line_id, allowed_actions를 반환한다. view 명령은 select_category, show_item, select_cart_line, show_cart, go_back 등 의미 기반 동작을 제공한다. 픽셀 좌표나 DOM 선택자는 이 API 계약에 넣지 않는다.

## 오류와 복구

```json
{
  "request_id": "req-789",
  "error": {
    "code": "OPTION_SOLD_OUT",
    "message": "오트밀크를 지금 선택할 수 없어요.",
    "retryable": false,
    "field": "lines[0].selections[1]",
    "current_cart_version": 8,
    "details": {"group_id": "milk", "choice_id": "oat", "alternatives": ["regular"]}
  }
}
```

필수 오류는 INVALID_SELECTION, MISSING_REQUIRED_OPTION, INCOMPATIBLE_OPTIONS, ITEM_SOLD_OUT, OPTION_SOLD_OUT, INSUFFICIENT_STOCK, CART_VERSION_CONFLICT, PRICE_CHANGED, QUOTE_EXPIRED, CONFIRMATION_INVALID, IDEMPOTENCY_CONFLICT, PAYMENT_STATE_UNKNOWN, SESSION_EXPIRED, RATE_LIMITED다. 401/403 인증 실패와 409 상태 충돌, 422 선택 오류, 429 호출 제한, 5xx 서버 장애를 구별한다.

retryable=true라도 변경 요청은 상태 확인과 같은 멱등 키를 사용한다. 사용자에게 내부 오류 코드나 스택을 읽지 말고 주문이 유지되는지와 다음 가능한 행동을 설명한다. 직원 인계 요청도 실제 수신 확인 이전에는 “직원을 불렀다”고 말하지 않는다.

## 키오스크 팀과 먼저 합의할 내용

1. 메뉴와 옵션의 안정적인 ID, 변형 상품 구분, 실제 데이터 소유자와 갱신 주기.
2. 수량을 모르는 재고의 접수 정책, 옵션·공용 원재료 품절 판단, 재고 확보 시점.
3. 장바구니 버전과 멱등 키, 터치와 음성 요청이 충돌할 때의 응답.
4. 최종 확인용 견적·가격 변경·만료 정책, 실제 결제 화면 표시 완료 이벤트.
5. 성분·카페인·알레르기 데이터의 존재 여부와 unknown 의미.
6. 직원 인계 수신 시스템과 확인 상태. 아직 없다면 capability=false로 명시.

현재 가상 도구는 이 명세의 일부 의미만 구현한다. 실제 HTTP 서버, 동적 옵션 그룹 규칙, 공용 원재료, 원자적 재고 예약, quote/token, operation 조회, 이벤트 채널은 아직 구현하지 않았다. 가상 도구를 실제 API와 동일한 보장 수준으로 해석하지 않는다.


### 중요 옵션 응대 정책

옵션 그룹에 `ask_before_add`(선호 확인 필요), `ask_priority`, `question_label`, `default_proposal`, `adjustable`, `applies_when`, `extra_price`를 제공한다. 사이즈·얼음·당도도 기본값이 있다는 이유만으로 확인을 생략하지 않는다. 이미 선택했거나 고객이 기본값 적용을 명시적으로 위임한 항목은 다시 묻지 않는다. 뜨거운 음료의 얼음, 고정 크기, 레시피상 조절 불가능한 당도는 질문 대상에서 제외한다. 단맛 정도와 당도 조절 가능 여부는 별개 필드다.

현재 데모는 제품 플래그와 단맛 분류를 이용한 임시 정책이다. 실제 API에서는 시럽·소스·파우더·원액별 제거/감량 가능 여부와 조절해도 남는 단맛을 제공해야 한다. 실제 이디야에서 모든 데모 옵션을 지원한다는 의미가 아니다.


### 결제 대화 연결에 필요한 서버 정보

데모는 payment_action(id/kind/method/expected_attempt/total)을 브라우저에 전달하고 payment_ui와 last_action_id로 진행 상태를 돌려받는다. 운영 API는 결제수단 목록, 지원·점검 여부, 결제 시도 생성·조회·취소, 실패 코드와 재시도 가능 여부, 견적 ID와 주문 버전, 인증된 승인 이벤트, 영수증의 주문번호·거래 ID·금액을 제공해야 한다. 리더기 대기·인식·승인 중·승인·실패·시간 초과·취소·결과 미확정을 구별한다.

멱등성 키는 각 결제 시도에 고정한다. 승인 중인 시도 위에 다른 수단을 시작하지 않고 취소 결과를 기다린다. 운영 환경에서는 브라우저가 보낸 완료 주장이나 사용자의 ‘결제했어’를 승인 근거로 삼지 않고 결제 서버의 거래 결과를 검증한다. 승인 여부가 미확정이면 조회로 정리한 후 재시도해 중복 청구를 막는다.


## 화면 하이라이트와 조작 안내 계약 (2026-11-22)

대화 응답 상태에 `guidance` 명령을 포함한다. 필드는 `id`, `target`, `instruction`, 선택적 `product_id`, `line_id`, `option`, `value`다. 메뉴·옵션·장바구니 항목·결제 버튼을 의미 ID로 지정하며 임의 선택자·좌표·스크립트는 받지 않는다. 하이라이트 자체는 옵션 선택이나 주문 변경·청구가 아니다. UI는 해당 요소가 보이도록 메뉴 위치·옵션 창을 준비하고 실제 화면 버튼을 강조한다.

다음 요청의 `ui_context.guidance`에 showing/done 상태를, `ui_context.interaction`에 실제 화면 조작 횟수·최근 조작 종류·경과 시간을 보낸다. 에이전트 조작은 사용자 조작 횟수에서 제외한다. 기존 editor·이벤트 이력과 함께 최신 직접 선택을 우선한다. 대상 미존재·지원하지 않는 옵션은 표시 성공으로 보고하지 않는다. 세션 종료 시 표시·지표를 초기화한다. 상세 타깃 목록·동작·검증은 [화면 하이라이트와 적응형 안내](화면_하이라이트와_적응형_안내.md)를 따른다.


## 아바타·음성 상태 (2026-11-23)

키오스크 안의 점원은 기존 화면·주문·guidance 상태와 실제 TTS PCM 재생 시각을 사용한다. 새 매장 주문 API나 추가 모델 호출은 필요하지 않다. 향후 STT 입력 어댑터는 현재 세션의 `voiceInput.phase`(off/listening/speech/transcribing/error)와 `partial`을 제공하고 중단·세션 종료 시 정리한다. 이 상태는 표시용이며 중간 텍스트만으로 주문을 실행하지 않는다. 사용자 발화와 점원 자막은 구분해 표시하고 실제 수음이 없으면 듣는 중으로 꾸미지 않는다. [화면·모션 계약](아바타와_음성상태_표시.md)


## 메뉴 개편 옵션 계약 (2026-11-23)

카탈로그에는 `decafOnly`(디카페인 전용), `whippedCream`(휘핑 변경 가능),
`temperatures`(판매 가능한 온도)를 제공한다. 에이전트는 메뉴 ID를 고정된
일반 음료명으로 추정하지 않고 최신 카탈로그를 조회한다.

| 필드 | 허용값 | 처리 |
|---|---|---|
| `options.ice` | `normal`, `more`, `less`, `none` | 차가운 얼음 조절 가능 메뉴만 변경 |
| `options.whippedCream` | `normal`, `extra`, `none` | 휘핑 지원 메뉴만 변경 |
| `options.decaf` | boolean | 전용 메뉴는 항상 true, 포함 가격 사용 |

데모에서는 얼음 많이·휘핑 추가/제거의 추가금이 0원이다. 운영 API는 옵션별
가격·제약을 명시하고 최종 금액을 반환해야 한다. 주문 추가·수정·일부 수량 분리,
사용자 직접 조작 이벤트·상태 스냅샷·영수증에 새 필드를 동일하게 전달한다.
휘핑이 없는 기존 클라이언트 요청은 기본 휘핑으로 해석한다. `decaf` 생략은
해당 메뉴 기본값을 사용한다. 지원하지 않는 온도·휘핑·원두 전환은 거부한다.


### 수량 한도 통합 (2026-11-23)

한 항목·동일 옵션 합산·전체 주문의 상한은 모두 999잔이다. 1000잔부터는 거부하고
실재고가 더 적으면 재고 상한을 우선한다. 수량은 1 이상의 정수만 허용한다.
주문 추가·수정·일부 수량 분리·옵션창·터치 상태 동기화·결제·영수증에 같은 한도를
적용한다. 에이전트 요청 본문은 최대 4MiB로 여러 옵션 항목의 최신 상태를 전달한다.

## 언어 선호와 번역 데이터

`cart.ui_context.language`와 에이전트 상태의 `language`는 `ko|en|zh|ja`다.
언어 변경은 주문 항목·가격·결제 확인을 초기화하지 않는다. 키오스크 팀은 메뉴·
카테고리·옵션의 식별자와 원화 금액을 유지하면서 `localized_name`,
`localized_description`, `localized_labels`를 언어별로 제공하면 된다.
실제 매장 재료·알레르기·수량 제한이 번역 과정에서 변하지 않게 같은 원본 레코드를
사용한다. 기존 STT 앞단은 선호 언어를 인식 언어 힌트로 사용할 수 있지만, STT 구현은
현재 텍스트 에이전트의 범위에 포함하지 않는다. 언어 전환만으로 주문을 재실행하지 않는다.
