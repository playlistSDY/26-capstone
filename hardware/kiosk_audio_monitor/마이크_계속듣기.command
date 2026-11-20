#!/bin/zsh
set -eu
task_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
exec "$task_dir/마이크_듣기.command" --always --gain 2 "$@"
