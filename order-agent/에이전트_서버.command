#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$task_dir"
if [[ ! -f .env ]]; then
  cp .env.example .env
fi
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import agents' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
fi
print 'SWitch 에이전트 서버를 실행합니다. 설정 파일: order-agent/.env'
print '키오스크에서 주문 대화 테스트를 누르세요. 종료: Ctrl+C'
.venv/bin/python -m switch_agent.web
