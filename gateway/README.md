# local-tester LLM gateway

A tiny Node HTTP service that holds the shared OpenRouter API key, authenticates
clients with bearer tokens, pins the model per task type, and forwards to
OpenRouter. Zero runtime dependencies (Node 18+ built-ins only). Fronted by Caddy
for automatic HTTPS.

Three ways to authenticate a `POST /v1/chat/completions` call:

- **Shared operator tokens** from `PROXY_TOKENS` (env): unlimited, for the
  operator and hand-issued trusted users.
- **Issued tokens** from the self-service request flow: per-email, approved by the
  operator on the admin dashboard, delivered by email, limited to
  `DEFAULT_DAILY_LIMIT` calls per day (20 by default, adjustable/revocable per
  token). Only a sha256 hash of each issued token is persisted.
- **A caller's own OpenRouter key (BYOK)**, sent as `X-OpenRouter-Key:
  sk-or-...`. **This requires no proxy/issued token at all** — the caller pays
  OpenRouter directly, so the gateway has nothing to gate: it does not check
  for a bearer token, does not look it up in the token registry, and never
  applies a daily limit to a BYOK-only call. It only proxies the request and
  pins the model. See [Request contract](#request-contract) below for the
  exact rule when a bearer token is presented alongside a BYOK key.

Persistent state (issued-token registry + global stats aggregates) lives as JSON
files under `STATE_DIR` (default `.data` relative to the working directory).
Writes are atomic; deleting the directory resets the registry and the stats.

## Request contract

- `GET /health` → `{"ok":true}`. Unauthenticated for plain liveness (uptime pings), but if an `Authorization: Bearer <proxy-token>` header is presented — as the MCP client's health check does — the token is validated (without consuming a daily use) and an invalid one is rejected with `401`, so misconfigured tokens are caught at health-check time.
- `POST /v1/chat/completions` → OpenAI-compatible.
  The `X-Task-Type` header (`verdict|triage|review|digest|scout|query`) selects the
  pinned model. The client's `model` field is always ignored.
  - **Without** a valid `X-OpenRouter-Key`: requires `Authorization: Bearer
    <proxy-token>`. Issued tokens consume one daily use per call; past the
    limit the gateway returns
    `429 {"error":"daily limit reached","dailyLimit":N,"resetsAt":"midnight UTC"}`.
  - **With** a valid `X-OpenRouter-Key: sk-or-...`: **no `Authorization`
    header is required at all.** The call bills against that key upstream
    instead of the operator's `OPENROUTER_API_KEY`, and no daily limit ever
    applies. If a bearer token happens to be presented too, its validity is
    not checked — only used to bucket per-minute rate limiting; without one,
    rate limiting is bucketed by a hash of the BYOK key instead, so anonymous
    BYOK traffic is still throttled. A missing/malformed `X-OpenRouter-Key`
    (or `ALLOW_BYOK=false`) falls back to requiring the normal proxy/issued
    token — a bad key never grants access on its own, it just loses the
    tokenless path.
- `POST /v1/analytics` → sanitized aggregate analytics ingest from MCP clients.
  Requires a valid bearer token but never consumes a daily use. The payload is
  re-sanitized server-side (name whitelisting, numeric clamping); everything else
  is discarded. Returns `202 {"ok":true}`.
- `GET /v1/stats` → public aggregate-only global stats JSON (no auth). Contains
  counters, percentages, model/tool breakdowns, and per-day buckets — never
  emails, tokens, workspace paths, commands, or log content.
- `GET /stats` → public HTML showcase page rendering the same aggregates.
- `POST /v1/token-requests` `{"email":"you@example.com"}` → public self-service
  token request. **One request per email, ever** — any existing record (pending,
  approved, denied, or revoked) returns `409`. Per-IP rate-limited
  (`TOKEN_REQUESTS_PER_MIN`, default 3/min).
- `GET /admin` + `/admin/api/*` → operator dashboard and API (see below). All
  admin routes return `404` unless `ADMIN_TOKEN` is set.

## Admin dashboard and token lifecycle

Set `ADMIN_TOKEN` in the env file (generate with `openssl rand -hex 32`), then
open `https://<gateway-host>/admin`, paste the admin token into the page, and
Load. From there you can:

- **Approve** a request: generates a token, emails it to the requester (when
  email delivery is configured), and activates it with the default daily limit.
  If email delivery is not configured or fails, the plaintext token is shown
  once in the dashboard so you can deliver it manually.
- **Deny** a pending request, or **Revoke** an issued token (takes effect on the
  holder's next call).
- **Change the daily limit** per email inline (0 blocks all use without revoking).

The JSON API behind the page (all require `Authorization: Bearer <ADMIN_TOKEN>`):
`GET /admin/api/requests`, `POST /admin/api/approve|deny|revoke` `{"email":...}`,
and `POST /admin/api/limit` `{"email":...,"dailyLimit":N}`. Token hashes never
leave the server, not even to the admin API.

Re-approving an email deliberately regenerates its token (old one stops working);
the "one per email ever" rule only constrains the public request endpoint.

## Email delivery (optional)

Set `RESEND_API_KEY` and `EMAIL_FROM` (a sender on a domain verified with
[Resend](https://resend.com)) to have approved tokens emailed automatically.
Without them, approvals still work and the dashboard shows each token once for
manual delivery. Email sending is a single HTTPS call; no dependency is added.

## Global stats

MCP clients push a sanitized aggregate record after each tool call (default-on
when the gateway is configured; users opt out with
`LLM_GATEWAY_SHARE_ANALYTICS=off`). The gateway folds records into aggregate
counters only — per-day buckets are kept for 180 days, tool/model breakdowns are
capped, numbers are clamped — and persists them in `STATE_DIR/global-stats.json`.
Point people at `https://<gateway-host>/stats` to showcase the tool's impact.

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

### Issuing a token to a person

For most users, prefer the self-service flow: they `POST /v1/token-requests` with
their email, you approve on `/admin`, and the daily-limited token is emailed to
them — no redeploy needed. The manual `PROXY_TOKENS` flow below issues an
**unlimited** shared-class token and requires a redeploy per change:

1. Generate a token: `openssl rand -hex 32`.
2. Add it to the comma-separated `PROXY_TOKENS` in `gateway/deploy/gateway.env`.
3. Redeploy: `./deploy-pm2.sh` (or restart the service) so the gateway reloads the list.
4. Hand that token to the person; they run `npm run gateway:config -- setup` (or set
   `LLM_GATEWAY_TOKEN` manually) on their machine. Revoke by removing their token
   from `PROXY_TOKENS` and redeploying.
