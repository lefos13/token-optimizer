#!/usr/bin/env bash
set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DATA="${CLAUDE_PLUGIN_DATA:-$ROOT/.data}"
mkdir -p "$DATA"

# (Re)install runtime deps only when the manifest changes. Output goes to
# stderr/null so stdout stays a clean JSON-RPC channel.
if ! diff -q "$ROOT/server/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cp "$ROOT/server/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
fi

export NODE_PATH="$DATA/node_modules"
exec node "$ROOT/server/index.js"
