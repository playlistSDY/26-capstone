# sdylab 중앙 에이전트와 온라인 AI 키오스크

2026-11-21 기준. 키오스크는 OpenAI에 직접 연결하지 않고 sdylab의 SWitch 에이전트 서버에 주문 텍스트·장바구니·결제 결과를 전달한다. 대화 모델·TTS·주문 도구·세션은 중앙 서버가 처리한다.

## 접속 주소

| 용도 | 주소 | 서비스 |
|---|---|---|
| AI 키오스크 | https://temp.sdy.world/980d563c-35d0-4ee2-9de0-161a08901e29/ | switch-agent-preview-20261121.service, 내부 15174 |
| 기본 키오스크(AI 없음) | https://temp.sdy.world/6bd53630-2b00-4d66-9bab-3810e1e0aa36/ | switch-kiosk-preview-20261119.service, 내부 15173 |
| 중앙 에이전트 | 위 AI 주소의 agent-api/ | switch-order-agent.service, loopback 18732 |

AI 주소는 lab-online에 ttl_hours=0, expires_at=null로 등록했다. 두 화면과 에이전트는 sdylab의 별도 사용자 서비스로 실행되며 Linger=yes로 로그인 여부와 무관하게 시작한다. 주소에 만료 시각은 없고 실제 접속은 서버·서비스가 가동 중일 때 가능하다.

기본 화면의 src와 Vite 설정은 로컬 main의 AI 없는 버전으로 보존했다. 분리 직전의 원격 화면 소스는 /home/sdy/previews/switch-basic-before-split-20261121.tar.gz로 백업했다. 자동 동기화 대상은 새 AI 디렉터리로 변경해 기본 화면을 덮어쓰지 않는다. 로컬 main 브랜치 자체는 수정하지 않는다.

## 호출 경로

온라인 브라우저 → 기존 lab-online UUID 게이트웨이 → AI 키오스크 Vite → loopback 중앙 에이전트 → OpenAI 대화·Realtime TTS. 텍스트와 PCM 음성 스트림, 끼어들기, 최종 전달 확인을 동일 경로로 전달한다.

Mac의 로컬 Vite도 기본적으로 새 AI 주소를 통해 동일한 중앙 에이전트로 프록시한다. 각 브라우저·키오스크에 OpenAI 키를 입력하지 않는다. 세션은 키오스크 대화마다 분리한다. 프린터 등 장치용 /api는 로컬 백엔드 경로를 유지하며 음성·대화 경로와 구분한다.

## 설정과 소스

- AI UI: /home/sdy/previews/switch-agent-20261121/kiosk-web
- 에이전트: /home/sdy/previews/switch-agent-20261121/order-agent
- 중앙 키·모델·음성·허용 Origin: /home/sdy/.config/switch-agent/agent.env, 권한 600. systemd EnvironmentFile로 읽는다. 실제 키는 Git·정적 UI·동기화 대상에 포함하지 않는다.
- 서비스 파일 원본: order-agent/deploy/*.service
- AI 동기화 설정: kiosk-web/dev/live-preview.json
- 기본 화면 주소 기록: kiosk-web/dev/basic-preview.json

키나 모델을 바꾸면 서버의 agent.env 한 곳을 수정하고 systemctl --user restart switch-order-agent.service로 반영한다. 키 변경을 각 키오스크에서 반복하지 않는다.

로컬 전용 진단이 필요한 경우에만 Vite 실행 환경에 SWITCH_AGENT_TARGET=http://127.0.0.1:18732를 지정하고 로컬 에이전트 서버를 실행한다. 기본 동작은 sdylab 경유다. 공개 서버에서는 SWITCH_AGENT_TARGET=http://127.0.0.1:18732로 설정해 같은 서버 안에서 전달한다.

## 자동 동기화

기존 Mac LaunchAgent world.sdy.switch-kiosk-preview-sync가 이제 새 AI 화면의 src/public/설정과 order-agent의 switch_agent/data/requirements/tests를 복사한다. env·가상환경·비밀 키·배포 ZIP·업데이트 파일은 복사하지 않는다. UI는 HMR로 반영하며 에이전트 소스 해시가 바뀔 때만 중앙 에이전트를 다시 시작한다. 서버 재시작 시 메모리 대화는 초기화되고 화면 장바구니로 다시 연결한다. Mac이 꺼져도 sdylab에서 마지막으로 동기화한 버전이 계속 실행된다.

## 홈에서 시작하기

홈에서 ‘주문할게요’라고 하면 매장/포장을 먼저 묻는다. ‘먹고 갈게요’ 또는 ‘포장해 주세요’에 set_order_type을 호출해 메뉴판을 자동으로 연다. 처음 발화에 메뉴를 말한 경우도 기억해 중요 옵션을 이어서 확인한다. 이미 매장/포장을 말했으면 다시 묻지 않는다. 단순 성분 질문은 주문으로 강제 전환하지 않는다.

## 확인 결과

공개 AI 주소에서 실제 모델로 매장/포장 질문 → 포장 아이스 아메리카노 추가 → 주문 확인 → 카드 리더기 명령을 확인했다. 동일 경로로 24kHz TTS 음성을 수신했다. Mac 로컬과 공개 주소의 에이전트 세션 발급 서버가 동일한 것도 확인했다. 기본 주소에는 AI 패널이 없고 새 주소에는 패널·메뉴 이미지·연결 상태가 정상 표시됐다. 로컬 자동 테스트는 81개이며 웹 빌드를 통과했다. 실제 카드 청구와 실물 프린터는 이 공개 데모에 연결하지 않았다.

공개 브라우저에서도 홈의 매장/포장 질문과 자동 메뉴판 이동, 주문 확인 화면, 카드 수단 선택, 기존 데모 리더기, 완료 화면·주문번호·세션 초기화를 끝까지 검증했다. 카드 3,200원 주문 한 건만 저장되는 것을 확인했다. sdylab에서도 자동 테스트 81개를 통과했다.

화면·대화 동기화와 토큰 추적을 추가했다. 자연어 동의·끼어들기·화면 직접 수정의 처리는 [전용 문서](대화동기화와_토큰추적.md)에 정리한다.
