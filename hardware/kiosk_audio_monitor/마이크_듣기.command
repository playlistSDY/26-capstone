#!/bin/zsh
set -eu
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$task_dir"
if [[ ! -x .venv/bin/python ]]; then
  if [[ -x /opt/homebrew/bin/python3 ]]; then
    /opt/homebrew/bin/python3 -m venv .venv
  else
    python3 -m venv .venv
  fi
fi
if ! .venv/bin/python -c 'import numpy, serial, sounddevice' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements.txt
fi
.venv/bin/python listen_pc.py "$@" || {
  read -r "?오류를 확인한 뒤 Enter를 누르면 닫힙니다. "
  exit 1
}
