# Centralized LLM Gateway — Design

Date: 2026-07-08
Status: Approved (brainstorming), pending implementation plan

## Goal

Centralize the OpenRouter-calling layer of `local-tester-mcp` so that:

1. **One shared API key / billing** — users no longer each hold an OpenRouter key. A single key lives on a server the maintainer controls; all usage bills to one account.
2. **Easy central config** — the model (and prompts-adjacent model choice) can be changed in one place and every user follows without re-installing a plugin.

Non-goals (explicitly deferred):

- **Per-user access control / quotas** — not required now. The design leaves an additive upgrade path (see "Deferred").
- **Centralized analytics** — analytics stay per-workspace as today (YAGNI).

## Key constraint that shapes the design

The MCP server does two different kinds of work:

- **Local, machine-bound work** — runs `child_process.exec` in the user's workspace (build/lint/test), reads changed files, writes logs to the user's disk. This *cannot* move to a droplet; it must run where the user's code lives.
- **LLM work** — an HTTP call to OpenRouter with an API key. This *is* centralizable.

Therefore "centralize the server" means: **keep the command executor local, move only the OpenRouter-calling layer behind a shared HTTP gateway on the droplet.**

## Decisions

| Decision | Choice |
| --- | --- |
| Split | **Thin proxy.** Gateway is a minimal OpenAI-compatible endpoint; the client keeps its prompts/parsing/fallback and only swaps base URL + auth. |
| Fallback | **Keep local as fallback.** Gateway is primary; if unreachable, the client falls back to the user's local model if configured. Same fallback *shape* as today, repointed. |
| Model control | **Server pins the model.** Gateway overrides the client-sent model using a server-side task→model map (with a default). |
| TLS / host | **Caddy + Let's Encrypt** at `llm-proxy.lnf.gr` (A record → droplet). |
| Auth | **Single shared bearer token** the client holds instead of the real OpenRouter key. Security floor, not access control. |

## Architecture & request flow

Two components:

- **Local MCP server** (per user): unchanged responsibilities — detect/run commands, read changed files, trim logs, write per-workspace analytics. Stops talking to OpenRouter directly.
- **Gateway** (droplet): holds the real OpenRouter key; authenticates the caller, pins the model, forwards to OpenRouter. Fronted by Caddy for HTTPS.

```
MCP (local)                    Caddy + Gateway (droplet)              OpenRouter
  build prompt
  POST /v1/chat/completions ──▶ TLS terminate
    Authorization: Bearer <PROXY_TOKEN>
    X-Task-Type: verdict          ├─ reject if token invalid (401)
    model: "(ignored)"            ├─ map task→model (server config)
                                  ├─ overwrite body.model
                                  └─ forward w/ real key ──────────▶ chat/completions
  read verdict + data.model ◀────  return response verbatim ◀───────  {…, model}
```

If the gateway is unreachable, the client falls back to the user's local model and records `fallbackReason` — the same conservative behavior that exists today.

## Gateway service

Small Node/TypeScript service in a new `gateway/` folder in this repo (shares task-type types + build toolchain; docs stay together).

Endpoints:

- **`POST /v1/chat/completions`** — OpenAI-compatible so the client barely changes. Steps:
  1. Check `Authorization: Bearer <token>` against configured token(s); `401` if invalid.
  2. Read `X-Task-Type`; look up the pinned model from the server-side task→model map (fall back to default model).
  3. Overwrite `body.model` with the pinned model.
  4. Forward to `https://openrouter.ai/api/v1/chat/completions` with the real key.
  5. Return the response verbatim, including the real `model` field (so the client's analytics/metadata reflect central config automatically).
- **`GET /health`** — cheap liveness (no OpenRouter spend) for the client's `check_local_llm_health` tool to verify reachability + token.

Config on the droplet (env / small `config.json`, never committed): real `OPENROUTER_API_KEY`, shared `PROXY_TOKEN`(s), task→model map, default model. Changing a model = edit the map + reload; every user follows instantly.

Guardrails: HTTPS-only, `401` on bad token, basic rate limit (insurance if the token leaks), request timeout + body-size cap, no logging of request bodies (they contain users' code and log snippets).

## Client (MCP server) changes

Contained to `src/llm.ts` plus config/docs. Today's logic is already "remote primary → local fallback," so we repoint rather than rewrite.

- **New env vars:** `LLM_GATEWAY_URL` (e.g. `https://llm-proxy.lnf.gr/v1`) and `LLM_GATEWAY_TOKEN`. These replace `OPENROUTER_API_KEY` / `OPENROUTER_API_URL` in user-facing config.
- **`resolveProvider(taskType)`:** if `LLM_GATEWAY_TOKEN` is set, build a `gateway` provider — base URL from `LLM_GATEWAY_URL`, `Authorization: Bearer <token>`, header `X-Task-Type: <taskType>`. No client-side model config needed; it sends a nominal `model` the gateway overrides.
- **`callChatCompletion`:** set the reported model from `data.model` (what the gateway actually used) so metadata/analytics reflect central config with no client update.
- **`callWithFallback`:** generalize the "primary is remote → retry local" branch to be provider-name-agnostic (currently checks specifically for the OpenRouter provider name), so the gateway also falls back to local.
- **`checkLocalLLMHealth`:** when the gateway is configured, ping `GET /health` (confirm reachability + token) instead of the current blind skip.
- **Backward-compat:** keep the direct `OPENROUTER_API_KEY` path as a dev/testing fallback; the gateway takes precedence when its token is present. Local-only path unchanged.

Untouched: other tools, `runner.ts`, `detector.ts`, `registry.ts`, `analytics.ts`, `types.ts` (aside from any provider-name enum addition).

## Deployment (droplet)

- **Caddy** reverse proxy: `llm-proxy.lnf.gr { reverse_proxy 127.0.0.1:<port> }` — automatic Let's Encrypt certs + renewal.
- **Gateway** on `127.0.0.1:<port>` (loopback-bound; only Caddy reaches it), managed by a **systemd** unit (auto-restart, boot-start, journald logs).
- **Secrets** via systemd `EnvironmentFile` (`/etc/local-tester-gateway.env`, `chmod 600`). Never in git.
- **Firewall (ufw):** allow 80/443 only; gateway port stays loopback.
- Deployment doc (`gateway/README.md` or `docs/deployment.md`) with exact steps: DNS, install Node + Caddy, build, env file, systemd enable, verify via `curl https://llm-proxy.lnf.gr/health`.

## Security, errors, analytics

- **Security floor:** shared bearer token (`401` without it), HTTPS-only, loopback-bound gateway, basic rate limit, body-size + timeout caps, no request-body logging.
- **Error handling:** gateway forwards OpenRouter's status/body on upstream errors; the client treats any non-2xx as a gateway failure → local fallback → conservative `uncertain`/advisory result. Command exit codes remain authoritative.
- **Analytics:** storage unchanged (per-workspace, per project rule). Provider label becomes `gateway`; model comes from `data.model`. No server-side analytics.

## Docs & plugin sync (required by AGENTS.md)

- Update `README.md` and `skill/skill-example.md` for new env vars + setup.
- Update the `.mcp.json` example (drop real key; add `LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN`).
- Bump `VERSION` in all three generators (`generate-plugin-antigravity.js`, `generate-plugin-claude.js`, `generate-plugin-codex.js`).
- Run `npm run build:plugin`; do not edit `plugin/` by hand.

## Testing

- **Gateway unit:** `401` on bad/missing token; task→model pinning (incl. default when `X-Task-Type` absent/unknown); upstream error passthrough; `/health`.
- **Client:** gateway preferred when token set; fallback-to-local on gateway failure; model read from response body.
- **Integration:** run the gateway locally, point a client at it, exercise `run_test_verdict` and `check_local_llm_health`.
- **Server build:** `npm run build`; then `npm run build:plugin` and confirm docs/plugin outputs describe the new behavior.

## Deferred (additive later)

- **Per-user tokens** (revoke/quota individuals) — the "access control" goal not chosen now. Designed so upgrading is additive: replace the single-token check with a token lookup; no rewrite of the request path.

## Risks

- Gateway outage centralizes a failure point; mitigated by keeping the local-model fallback.
- Shared token distribution is still a secret handed to each user — but it is a *revocable proxy token*, not the real OpenRouter key. Per-user tokens (deferred) remove even this.
- Model pinning means a bad central model choice affects all users at once; mitigated by the fast edit-map-and-reload rollback.
