#!/bin/zsh
set -eu
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$task_dir"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if ! .venv/bin/python -c 'import numpy, serial, openai, onnxruntime' >/dev/null 2>&1; then
  .venv/bin/python -m pip install -r requirements-stt.txt
fi
.venv/bin/python -u serial_stt.py "$@" || {
  read -r "?오류를 확인한 뒤 Enter를 누르면 닫힙니다. "
  exit 1
}
