#!/usr/bin/env bash
set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA:-$ROOT/.data}"
exec node "$ROOT/server/start.js"
