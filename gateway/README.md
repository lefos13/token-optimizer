# local-tester LLM gateway

A tiny Node HTTP service that holds the shared OpenRouter API key, authenticates
clients with a shared bearer token, pins the model per task type, and forwards to
OpenRouter. Zero runtime dependencies (Node 18+ built-ins only). Fronted by Caddy
for automatic HTTPS.

## Request contract

- `GET /health` → `{"ok":true}` (no auth; used by the MCP client's health check).
- `POST /v1/chat/completions` → OpenAI-compatible. Requires `Authorization: Bearer <proxy-token>`.
  The `X-Task-Type` header (`verdict|triage|review|digest|scout|query`) selects the
  pinned model. The client's `model` field is always ignored.

## Deploy to the droplet

1. **DNS:** add an A record `llm-proxy.lnf.gr` → droplet IP. Wait for it to resolve.
2. **Install Node 18+ and Caddy** on the droplet.
3. **Build locally and copy the compiled service:**
   ```bash
   npm run build:gateway
   ssh droplet 'sudo mkdir -p /opt/local-tester-gateway'
   scp -r gateway/dist droplet:/tmp/gateway-dist
   ssh droplet 'sudo mv /tmp/gateway-dist /opt/local-tester-gateway/dist'
   ```
4. **Create a service user and the env file:**
   ```bash
   sudo useradd --system --no-create-home gateway
   sudo cp gateway/deploy/gateway.env.example /etc/local-tester-gateway.env
   sudo chmod 600 /etc/local-tester-gateway.env
   sudo nano /etc/local-tester-gateway.env   # fill in the real key + a random PROXY_TOKENS value
   ```
5. **Install and start the systemd unit:**
   ```bash
   sudo cp gateway/deploy/local-tester-gateway.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now local-tester-gateway
   sudo systemctl status local-tester-gateway
   ```
6. **Configure Caddy:**
   ```bash
   sudo cp gateway/deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
7. **Firewall (ufw):** allow only 80/443; the gateway port stays loopback-bound.
   ```bash
   sudo ufw allow 80,443/tcp && sudo ufw enable
   ```
8. **Verify:**
   ```bash
   curl https://llm-proxy.lnf.gr/health   # → {"ok":true}
   ```

## Changing the model centrally

Edit `/etc/local-tester-gateway.env` (`DEFAULT_MODEL` or a `MODEL_<TASK>` line),
then `sudo systemctl restart local-tester-gateway`. Every client follows on its
next call; no client update needed.

## Rotating / revoking the shared token

`PROXY_TOKENS` accepts a comma-separated list, so you can add a new token, roll
clients over, then drop the old one — all via the env file + a restart.
