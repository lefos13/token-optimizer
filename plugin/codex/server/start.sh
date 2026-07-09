#!/usr/bin/env bash
set -euo pipefail

ROOT="${PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}}"
DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$ROOT/.data}}"
mkdir -p "$DATA"

# Diagnostic log at a STABLE, predictable path (overridable) so it is easy to
# find no matter where Codex installs the plugin. Every stderr line from this
# script AND the server is tee'd here while still flowing to the host; stdout is
# left untouched so the JSON-RPC channel stays clean.
LOG_DIR="${TOKEN_OPTIMIZER_LOG_DIR:-$HOME/.token-optimizer-mcp}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/start.log"
exec 2> >(tee -a "$LOG" >&2)

echo "==== token-optimizer start: $(date '+%Y-%m-%dT%H:%M:%S%z') (pid $$) ====" >&2
echo "ROOT=$ROOT" >&2
echo "DATA=$DATA" >&2
echo "PWD=$(pwd)" >&2
echo "PATH=$PATH" >&2

# GUI apps (e.g. the Codex desktop app) spawn this server with a minimal PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) and do NOT source the shell profile, so a
# version-manager node (nvm) or a Homebrew node is invisible and the server
# silently fails to start. If node is not already resolvable, prepend the
# common install locations so npm/node can be found.
if ! command -v node >/dev/null 2>&1; then
  echo "node not on inherited PATH; probing common install locations" >&2
  NVM_NODE_BIN="$(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$NVM_NODE_BIN"; do
    if [ -n "$d" ] && [ -x "$d/node" ]; then
      echo "found node in $d" >&2
      PATH="$d:$PATH"
      break
    fi
  done
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "token-optimizer: 'node' not found on PATH. Install Node.js (or add it to PATH) so the MCP server can start." 1>&2
  exit 127
fi

echo "node=$(command -v node) ($(node -v 2>&1))" >&2
echo "npm=$(command -v npm 2>/dev/null || echo 'NOT FOUND') ($(npm -v 2>&1 || true))" >&2

echo "exec node $ROOT/server/start.js" >&2
export PLUGIN_DATA="$DATA"
exec node "$ROOT/server/start.js"
