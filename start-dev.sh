#!/usr/bin/env bash
# 一键启动前后端（macOS / Linux / Git Bash）
# 用法: ./start-dev.sh [--port 8787] [--web-port 5273] [--no-open] [--build]
set -euo pipefail
cd "$(dirname "$0")"
exec node scripts/dev.mjs "$@"
