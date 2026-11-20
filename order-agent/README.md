# SWitch 텍스트 주문 에이전트

앞단에서 STT가 끝난 텍스트로 점원처럼 대화하는 첫 프로토타입이다. OpenAI Agents SDK를 사용하며 실제 UI·재고 서버·결제·직원 호출에는 연결하지 않았다. 설계와 키오스크 API 요청 사항은 [설계 문서](../docs/agent/README.md)를 참고한다.

## 설치와 실행

Python 3.11 이상을 사용한다. 이번 검증 환경은 Python 3.14다.

```sh
cd order-agent
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

모델 ID와 키를 서버의 환경변수로 설정한 뒤 실행한다. API 키를 소스 파일에 저장하지 않는다. 모델은 함수 호출과 Responses API를 지원해야 한다.

```sh
export OPENAI_MODEL='사용할-모델-ID'
# OPENAI_API_KEY는 비밀 관리 도구나 현재 셸 환경에서 설정
.venv/bin/python -m switch_agent
```

`/state`는 실제 가상 장바구니 조회, `/quit`는 종료다. 각 실행은 독립적인 메모리 세션이며 종료하면 주문과 대화가 사라진다. 실제 모델 대화에는 OpenAI API 사용 비용이 발생한다. 이번 작업에서는 실제 모델 호출을 실행하지 않았다.

## 키 없이 실행

```sh
.venv/bin/python -m switch_agent --demo
.venv/bin/python -m unittest discover -s tests -v
```

`--demo`는 정해진 주문 도구 순서로 라떼 두 잔 중 한 잔만 차갑게 바꾸고 확인 후 가상 결제 진입 이벤트를 만드는 시연이다. 자연어 해석 시연이 아니다. 자동 테스트의 SDK 모델도 고정된 응답을 사용한다.

## 구현 파일

- `switch_agent/prompt.txt`: 짧은 진행 안내, 기억 도움, 필요한 질문, 추천과 마무리 정책.
- `switch_agent/domain.py`: 주문 상태, 옵션·수량·재고 검증, 최종 확인 게이트.
- `switch_agent/tools.py`: 13개 모델 도구와 가상 어댑터.
- `switch_agent/runtime.py`: 단일 세션의 SDK 실행과 대화 이력.
- `data/catalog.json`: 기존 키오스크 시제품 112개 메뉴의 메타데이터 복사본. 실제 매장 정보와 자동 동기화되지 않음.

가격·옵션 추가 금액은 기존 시제품 기준이다. 실제 재고 수량은 기본 null이며 soldOut만 카탈로그에서 읽는다. 테스트에서만 가상 재고 수량을 주입한다. 원재료·영양·알레르기 자료는 없다.

## 현재 한계

현재는 완성된 턴의 텍스트를 반환하며 스트리밍·재생·끼어들기 전송 계층은 없다. 미확정 요청은 대화 이력에서 기억하고, 동의 표현은 제한된 명확한 문구만 코드가 허용한다. 실제 모델 평가와 구조화된 draft 검증이 다음 과제다. 최종 확인 문구 반환은 CLI에서 전달 완료로 취급하며 실제 음성 연결에서는 전체 재생 완료 이벤트가 필요하다.

실제 배포에서는 환경변수 키를 신뢰된 백엔드에서만 사용하고, 세션 인증·지속 저장·이벤트 중복 방지·버전 충돌·quote와 재고 예약을 구현해야 한다. 현재 도구의 가상 결과를 실제 주문 접수·결제 완료·직원 알림으로 표시하지 않는다.
