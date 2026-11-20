#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$task_dir"
if ! command -v npm >/dev/null 2>&1; then
  print "Node.js 22.12 이상과 npm을 먼저 설치해 주세요."
  read -r "?Enter를 누르면 닫힙니다. "
  exit 1
fi
if [[ "$(curl -fsS --max-time 2 http://127.0.0.1:5173/app-info.json 2>/dev/null || true)" == *'"switch-kiosk"'* ]]; then
  open -a 'Google Chrome' http://127.0.0.1:5173/
  exit 0
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
print 'SWitch 개발 서버를 실행합니다. 종료하려면 Ctrl+C를 누르세요.'
npm run dev -- --open
