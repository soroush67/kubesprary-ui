#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/backend"
export PATH="$HOME/.local/bin:$PATH"
exec python3 -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8420}"
