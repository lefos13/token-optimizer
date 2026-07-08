# local-tester LLM gateway

A tiny Node HTTP service that holds the shared OpenRouter API key, authenticates
clients with a shared bearer token, pins the model per task type, and forwards to
OpenRouter. Zero runtime dependencies (Node 18+ built-ins only). Fronted by Caddy
for automatic HTTPS.

## Request contract

- `GET /health` → `{"ok":true}`. Unauthenticated for plain liveness (uptime pings), but if an `Authorization: Bearer <proxy-token>` header is presented — as the MCP client's health check does — the token is validated and an invalid one is rejected with `401`, so misconfigured tokens are caught at health-check time.
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

## Alternative: run under pm2 instead of systemd

If you'd rather supervise the gateway with pm2 than a systemd unit, skip step 4-5
above and instead:

1. Copy the whole `gateway/` directory (with `dist/` already built) to the droplet,
   e.g. `scp -r gateway droplet:/tmp/gateway`.
2. On the droplet: `cd /tmp/gateway/deploy && ./deploy-pm2.sh`.

That script installs pm2 if missing, syncs `dist/` and `gateway/deploy/ecosystem.config.js`
into `/opt/local-tester-gateway`, seeds `/etc/local-tester-gateway.env` from the example
on first run (edit it with your real key + token before relying on it), starts/reloads
the process under pm2, and runs `pm2 save`. It prints a one-time `pm2 startup` command
you copy/run once so pm2 itself resurrects the gateway after a droplet reboot. Steps
1, 2 (Node/Caddy install), 6 (Caddy config), 7 (ufw), and 8 (verify) above are unchanged
— only the process supervisor differs.

Re-running `./deploy-pm2.sh` after a new build or an env-file edit picks up the changes
and reloads the process; it never touches an existing `/etc/local-tester-gateway.env`
**unless** you stage one locally (see below).

### Managing secrets/model config from your own machine

Instead of `nano`-editing the env file over SSH every time you want to change the
OpenRouter key or model, you can prepare it locally and ship it with the deploy:

```bash
cp gateway/deploy/gateway.env.example gateway/deploy/gateway.env   # gitignored, never commit it
# edit gateway/deploy/gateway.env with your real OPENROUTER_API_KEY, PROXY_TOKENS, DEFAULT_MODEL, ...
npm run build:gateway
scp -r gateway droplet:/tmp/gateway
ssh droplet 'cd /tmp/gateway/deploy && ./deploy-pm2.sh'
```

When `gateway/deploy/gateway.env` is present in the directory you ship up, `deploy-pm2.sh`
always copies it to `/etc/local-tester-gateway.env` (overwriting) before reloading — so
editing that one local file and re-running the two commands above is the whole workflow
for rotating the key, the token, or the model. Without a staged `gateway.env`, an existing
droplet env file is left alone, so you can still edit it directly on the droplet if you
prefer.

## Changing the model centrally

Edit `/etc/local-tester-gateway.env` (`DEFAULT_MODEL` or a `MODEL_<TASK>` line),
then `sudo systemctl restart local-tester-gateway`. Every client follows on its
next call; no client update needed.

## Rotating / revoking the shared token

`PROXY_TOKENS` accepts a comma-separated list, so you can add a new token, roll
clients over, then drop the old one — all via the env file + a restart.
