#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/.data"
mkdir -p "$DATA"

if ! diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cp "$ROOT/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
fi

export NODE_PATH="$DATA/node_modules"
exec node "$ROOT/index.js"
