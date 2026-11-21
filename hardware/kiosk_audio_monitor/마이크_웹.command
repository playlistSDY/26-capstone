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
exec .venv/bin/python -u voice_dashboard.py "$@"
