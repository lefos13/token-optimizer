#!/usr/bin/env bash
set -euo pipefail

ROOT="${PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}}}"
DATA="${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$ROOT/.data}}"
mkdir -p "$DATA"

# Diagnostic log at a STABLE, predictable path (overridable) so it is easy to
# find no matter where Codex installs the plugin. Every stderr line from this
# script AND the server is tee'd here while still flowing to the host; stdout is
# left untouched so the JSON-RPC channel stays clean.
LOG_DIR="${LOCAL_TESTER_LOG_DIR:-$HOME/.local-tester-mcp}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/start.log"
exec 2> >(tee -a "$LOG" >&2)

echo "==== local-tester start: $(date '+%Y-%m-%dT%H:%M:%S%z') (pid $$) ====" >&2
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
  echo "local-tester: 'node' not found on PATH. Install Node.js (or add it to PATH) so the MCP server can start." 1>&2
  exit 127
fi

echo "node=$(command -v node) ($(node -v 2>&1))" >&2
echo "npm=$(command -v npm 2>/dev/null || echo 'NOT FOUND') ($(npm -v 2>&1 || true))" >&2

# (Re)install runtime deps only when the manifest changes. Output goes to
# stderr/null so stdout stays a clean JSON-RPC channel.
if ! diff -q "$ROOT/server/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  echo "installing runtime deps into $DATA" >&2
  cp "$ROOT/server/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
else
  echo "runtime deps up to date" >&2
fi

echo "exec node $ROOT/server/index.js" >&2
export NODE_PATH="$DATA/node_modules"
exec node "$ROOT/server/index.js"
