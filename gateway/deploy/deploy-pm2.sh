#!/usr/bin/env bash
set -euo pipefail

# Deploys/updates the local-tester LLM gateway on this droplet under pm2.
# Run this ON THE DROPLET. Assumes gateway/dist/ and this gateway/deploy/
# directory have already been copied up (e.g. via scp/rsync) to APP_DIR's
# parent — see the copy step below, or run this script from a checkout of
# the repo itself on the droplet.
#
# Usage:
#   ./deploy-pm2.sh [/path/to/gateway]   # defaults to the script's own gateway/ dir
#
# Idempotent: safe to re-run after editing the env file or redeploying dist/.
#
# To manage secrets/model config from your own machine instead of SSH-editing
# the droplet: copy gateway/deploy/gateway.env.example to gateway/deploy/gateway.env
# (gitignored — never commit it), fill in real values, then scp/rsync the whole
# gateway/ directory up and re-run this script. A staged gateway.env always wins
# and overwrites /etc/local-tester-gateway.env; without one, an existing droplet
# env file is left untouched.

APP_DIR="/opt/local-tester-gateway"
ENV_FILE="/etc/local-tester-gateway.env"
LOG_DIR="/var/log/local-tester-gateway"
SOURCE_GATEWAY_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "==> Source gateway dir: $SOURCE_GATEWAY_DIR"

if [ ! -d "$SOURCE_GATEWAY_DIR/dist" ]; then
  echo "ERROR: $SOURCE_GATEWAY_DIR/dist not found." >&2
  echo "Build it locally first with 'npm run build:gateway' and copy gateway/ to the droplet," >&2
  echo "or pass the path to a gateway/ directory that already contains dist/." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed. Install Node 18+ first (e.g. via NodeSource or nvm)." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed. Install npm alongside Node.js first." >&2
  exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node 18+ required, found $(node --version)." >&2
  exit 1
fi

echo "==> Node $(node --version) OK"

if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2 globally"
  sudo env "PATH=$PATH" npm install -g pm2
else
  echo "==> pm2 already installed ($(pm2 --version))"
fi

echo "==> Ensuring $APP_DIR exists"
sudo mkdir -p "$APP_DIR"

if [ ! -f "$SOURCE_GATEWAY_DIR/package.json" ] || [ ! -f "$SOURCE_GATEWAY_DIR/package-lock.json" ]; then
  echo "ERROR: gateway/package.json and gateway/package-lock.json are required beside dist/." >&2
  exit 1
fi

echo "==> Syncing dist/, runtime manifest, and ecosystem.config.js into $APP_DIR"
sudo rsync -a --delete "$SOURCE_GATEWAY_DIR/dist/" "$APP_DIR/dist/"
sudo cp "$SOURCE_GATEWAY_DIR/package.json" "$APP_DIR/package.json"
sudo cp "$SOURCE_GATEWAY_DIR/package-lock.json" "$APP_DIR/package-lock.json"
sudo cp "$SOURCE_GATEWAY_DIR/deploy/ecosystem.config.js" "$APP_DIR/ecosystem.config.js"

echo "==> Installing gateway production dependencies"
sudo env "PATH=$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$APP_DIR"

if [ -f "$SOURCE_GATEWAY_DIR/deploy/gateway.env" ]; then
  # A real, filled-in env file was staged locally (gateway/deploy/gateway.env,
  # gitignored) and shipped up with this deploy — it's the intended source of
  # truth, so it always wins, overwriting whatever's on the droplet.
  echo "==> Deploying staged gateway.env from $SOURCE_GATEWAY_DIR/deploy/gateway.env (overwriting $ENV_FILE)"
  sudo cp "$SOURCE_GATEWAY_DIR/deploy/gateway.env" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
elif [ ! -f "$ENV_FILE" ]; then
  echo "==> No env file found; seeding $ENV_FILE from gateway.env.example"
  echo "    EDIT IT before real use: real OPENROUTER_API_KEY + a generated PROXY_TOKENS value."
  sudo cp "$SOURCE_GATEWAY_DIR/deploy/gateway.env.example" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
else
  echo "==> Env file already exists at $ENV_FILE and no staged gateway.env was provided (not touching it)"
fi

echo "==> Ensuring log dir $LOG_DIR exists"
sudo mkdir -p "$LOG_DIR"
sudo chown "$(id -un):$(id -gn)" "$LOG_DIR" 2>/dev/null || true

echo "==> Starting/reloading local-tester-gateway under pm2"
cd "$APP_DIR"
if pm2 describe local-tester-gateway >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js
else
  pm2 start ecosystem.config.js
fi

echo "==> Persisting pm2 process list"
pm2 save

echo "==> One-time step (skip if already done on a prior run): make pm2 itself"
echo "    survive a reboot and resurrect this process. pm2 prints a command below —"
echo "    copy/run the exact 'sudo env PATH=... pm2 startup ...' line it outputs:"
pm2 startup || true

echo "==> Done. Check status with: pm2 status"
echo "==> Tail logs with:          pm2 logs local-tester-gateway"
echo "==> Verify health with:      curl -s http://127.0.0.1:\$(grep '^PORT=' $ENV_FILE | cut -d= -f2)/health"
