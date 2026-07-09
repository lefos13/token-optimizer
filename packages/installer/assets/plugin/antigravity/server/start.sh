#!/usr/bin/env bash
set -euo pipefail

ROOT="${ANTIGRAVITY_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export ANTIGRAVITY_PLUGIN_DATA="${ANTIGRAVITY_PLUGIN_DATA:-$ROOT/.data}"
exec node "$ROOT/server/start.js"
