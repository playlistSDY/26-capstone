# SWitch의 OpenAI 에이전트 구현 방식 비교

2026년 11월 20일 공식 문서 확인 기준. SWitch는 OpenAI Agents SDK와 Responses 모델을 사용하되 주문·재고·금액·최종 확인은 자체 도메인 코드와 키오스크 API가 관리하는 구조를 선택한다. 에이전트 루프를 전부 직접 만드는 비용을 줄이면서, 주문 시스템이 보장해야 할 규칙을 명시적으로 테스트할 수 있기 때문이다.

## 비교 대상

| 방식 | 제공하는 것 | SWitch에서 직접 만들어야 할 것 | 판단 |
| --- | --- | --- | --- |
| Agent Builder | 시각적 노드 편집, 미리보기, 워크플로 버전, SDK 코드 내보내기 | 주문 규칙, 실제 API, 세션·기기 이벤트 연결 | 신규 기반으로 선택하지 않음 |
| Agents SDK와 Responses 모델 | 코드의 Agent·Runner·함수 도구, 세션, 스트리밍, 추적, 가드레일 | 점원 대화 정책, 주문 상태와 검증, 키오스크 어댑터, 끼어들기 제어 | 현재 권장 및 첫 구현 |
| Responses API 직접 호출 | 모델 응답, 함수 호출, 스트리밍, 대화 연속성 기능 | 도구 실행 루프, 오류 처리, 이벤트 관리, 메모리 전략 | 정밀 제어가 SDK와 충돌할 때 대안 |
| 호스팅 Agents API | 관리형 Codex 하네스, 지속 세션, 복구, 실행 환경·샌드박스 연동 | 주문 도구와 도메인 검증, 기기·사용자 이벤트 연결 | 현재 주문 시제품의 우선 선택에서 제외 |

Agent Builder 공식 안내는 2026년 11월 30일 종료 예정이라고 명시한다. 기존 워크플로의 Agents SDK 코드 내보내기 경로도 제공한다. 따라서 지금 새 워크플로를 Builder에 의존해 구축할 이유가 적다. ChatKit은 별도 제품이며 Builder 종료와 함께 종료된다고 해석하지 않는다. [Agent Builder 공식 안내](https://developers.openai.com/api/docs/guides/agent-builder), [이전 가이드](https://developers.openai.com/api/docs/guides/agent-builder/migrate-from-agent-builder)

Agents SDK는 코드에서 도구와 에이전트를 정의하고 실행할 수 있으며, 세션 구현과 스트리밍 이벤트를 제공한다. 세션은 대화 이력을 관리한다. 메뉴·금액이 검증된 주문 상태를 대신 보장하는 기능은 아니므로 주문 상태는 별도로 둔다. [SDK 빠른 시작](https://openai.github.io/openai-agents-python/quickstart/), [세션](https://openai.github.io/openai-agents-python/sessions/), [스트리밍](https://openai.github.io/openai-agents-python/streaming/)

Responses API는 함수 호출 결과를 애플리케이션이 실행해 다시 전달하는 방식으로도 사용할 수 있다. SDK를 쓰더라도 자체 주문 도구를 구현해야 하는 점은 같다. SDK가 대화 문체나 STT 오인식 복구 품질을 자동으로 완성해 주지는 않는다. [함수 호출](https://developers.openai.com/api/docs/guides/function-calling), [대화 상태](https://developers.openai.com/api/docs/guides/conversation-state)

호스팅 Agents API는 관리형 Codex 하네스와 장기 실행·복구·실행 환경을 제공한다. SWitch의 좁은 주문 도구 집합과 짧은 대화 턴에는 현재 SDK만으로 검증을 시작할 수 있다고 판단했다. 호스팅 방식이 느리거나 비싸다는 실측 결론은 내리지 않았으며, 향후 운영상 이점이 확인되면 재평가한다. [Agents API 개요](https://developers.openai.com/api/docs/guides/agents-api/overview)

## 선택 이유와 책임 분담

점원과 손님의 대화는 메뉴 선택, 질문, 추천, 수정, 대기, 마무리를 자유롭게 오간다. 첫 단계는 단일 에이전트로 대화의 연속성을 유지하고, 주문 조작을 좁은 함수 도구로 제한한다. 메뉴 안내·추천·취소를 별도 에이전트에 나누는 구성은 현재 도입하지 않는다. 추가 에이전트가 품질이나 지연에 미치는 효과는 측정 후 판단한다.

모델은 발화와 문맥을 해석하고 적절한 도구와 다음 안내를 선택한다. 자체 코드는 옵션·수량·재고·금액·확인 유효성을 검사한다. 키오스크 API는 매장의 실제 판매 가능 여부, 장바구니와 결제 화면 상태의 최종 권위가 된다. 실패한 호출을 성공했다고 말하는 것은 대화 평가에서도 실패로 처리한다.

SDK의 함수 스키마는 인자 형태를 제한하지만 상호 배타 옵션, 원재료 소진, 최신 가격 같은 사업 규칙을 대신 검증하지 않는다. 주문 변경 도구는 순차 실행하고, 서버에서 버전 검사와 멱등 처리를 수행한다. [도구 정의](https://openai.github.io/openai-agents-python/tools/), [모델 설정](https://openai.github.io/openai-agents-python/ref/model_settings/)

## 비용과 지연 검증

2026년 11월 20일 확인한 Standard 텍스트 API 가격은 아래와 같다. 단위는 100만 토큰당 USD이며 캐시 쓰기·음성 생성·Fast/Ultrafast·긴 컨텍스트 요금은 별도다.

| 모델 | 입력 | 캐시 입력 | 출력 |
| --- | --- | --- | --- |
| gpt-6-sol | $2.00 | $0.20 | $10.00 |
| gpt-6.1-sol | $2.00 | $0.10 | $10.00 |
| gpt-6.2-sol | $2.00 | $0.10 | $10.00 |
| gpt-6-luna | $0.10 | $0.01 | $0.50 |

출처는 [가격표](https://developers.openai.com/api/docs/pricing), [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)다. 현재 대화 모델은 사용자 설정인 gpt-6.2-sol이다. 같은 평가 시나리오를 Luna와 비교하는 것은 후속 비용·품질 실험 후보이며 임의로 모델을 변경하지 않는다.

같은 모델을 사용해도 호출 횟수, 도구 결과 크기, 대화 이력, 재시도, 실행 환경에 따라 비용과 지연이 달라진다. Builder·SDK·직접 구현 중 어느 하나가 무조건 저렴하거나 대화가 더 자연스럽다고 가정하지 않는다. 모델 ID는 환경변수로 지정하며, 실제 대화 평가 전 특정 모델을 최종 확정하지 않는다.

공통 시나리오로 첫 응답까지의 시간, 전체 응답 시간, 턴별 모델 호출 횟수와 토큰, 도구 실패율, 주문 정확도, 불필요한 질문 수를 비교한다. 스트리밍은 첫 응답 체감을 개선할 수 있지만 도구 성공 전의 “변경했어요”를 먼저 재생하지 않아야 한다.

SDK 사용 중 중단·재개나 도구 순서 제어가 요구사항과 충돌하고 우회 코드가 늘어나면 Responses API 직접 구현을 비교한다. 이번에는 실제 모델 비용·지연 벤치마크를 수행하지 않았다.
