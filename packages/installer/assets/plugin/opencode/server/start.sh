#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PLUGIN_DATA="$ROOT/.data"
exec node "$ROOT/start.js"
