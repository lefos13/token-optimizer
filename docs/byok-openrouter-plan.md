# Plan: Bring-Your-Own OpenRouter Key (unlimited usage)

Status: **implemented**, as the gateway pass-through design described below.
`X-OpenRouter-Key` support lives in [`gateway/src/server.ts`](../gateway/src/server.ts)
and [`src/llm.ts`](../src/llm.ts) (`OPENROUTER_BYOK_KEY`); the installer prompts
are in [`scripts/manage-gateway-config.js`](../scripts/manage-gateway-config.js)
and [`packages/installer`](../packages/installer). This document is kept as the
design record for that implementation.

## Goal

During installation, a user may optionally provide their **own OpenRouter API
key**. Users who do get unlimited usage (no per-day allowance), because the
inference cost lands on their own OpenRouter account instead of the operator's.

## Recommended architecture: gateway pass-through header

The client keeps talking to the gateway exactly as today, but adds one header:

```
X-OpenRouter-Key: sk-or-...        (only when the user configured a BYOK key)
```

Gateway behavior on `/v1/chat/completions`:

1. If `X-OpenRouter-Key` is present and plausibly shaped (`sk-or-` prefix,
   length-capped), **no proxy/issued token is required at all.** The caller
   isn't using the operator's OpenRouter setup, so there is nothing for a
   proxy token to gate — the gateway only proxies and pins the model. Use the
   BYOK key as the upstream `Authorization` key instead of the operator's
   `OPENROUTER_API_KEY`, and skip daily-limit consumption entirely (even if a
   token happens to be presented too, its validity isn't checked; per-minute
   rate limiting stays, bucketed by the token if present, else by a hash of
   the BYOK key).
2. Without a valid `X-OpenRouter-Key`, fall back to the normal proxy/issued
   token requirement exactly as before.
3. Never persist or log the key; it exists only for the lifetime of the request.
4. On upstream `401/402` (bad/expired/unfunded user key), forward the status so
   the client falls back exactly as it does for any other gateway failure.

### Why pass-through instead of client → OpenRouter directly

| | Gateway pass-through (recommended) | Direct-to-OpenRouter |
| --- | --- | --- |
| Central model pinning per task type | ✅ kept | ❌ lost (client picks models; drifts across installs) |
| Global analytics ingest path | ✅ same endpoint keeps working | ⚠️ needs a separate analytics call to the gateway anyway |
| Token revocation / abuse control | ✅ kept | ❌ none |
| Key privacy | key transits the operator's gateway (TLS, not stored) | ✅ key never leaves the user's machine |
| Client code | +1 header | new provider branch in `src/llm.ts` |

The one real cost of pass-through is that the user must trust the gateway not to
store the key — mitigated by this repo being the gateway's public source. If
that trust trade-off is unacceptable later, a `LLM_BYOK_MODE=direct` variant can
reuse the existing local-provider path with `apiUrl=https://openrouter.ai/api/v1`
and the key as auth; the plumbing already exists in `resolveLocalProvider`.

## Changes required

### Gateway (`gateway/src/server.ts`, `config.ts`)

- In `handleChat`: read + validate `X-OpenRouter-Key`; when present, pass
  `consume: false` to `authenticateCaller` and use the user key upstream.
- Optional `ALLOW_BYOK=false` env kill-switch (default on).
- Tests: BYOK header bypasses daily limit; upstream sees the user key; the
  operator key is used when the header is absent; oversized/garbage header is
  ignored (falls back to normal daily-limited path).

### Client (`src/llm.ts`)

- New env var `OPENROUTER_BYOK_KEY` (name avoids colliding with the gateway's
  own `OPENROUTER_API_KEY` when both run on one machine).
- `resolveGatewayProvider` adds the `X-OpenRouter-Key` header when set.
- `check_local_llm_health` unchanged (health never consumes usage anyway).

### Installation surfaces

- `scripts/manage-gateway-config.js` (`setup` / `update`): add an optional
  prompt — "OpenRouter API key for unlimited usage (Enter to skip)" — written to
  the same client config surfaces as `LLM_GATEWAY_*` (add the key to
  `GATEWAY_ENV_KEYS` so status/update/delete manage it too).
- `packages/installer` (`npx @softawarest/token-optimizer-installer`): same
  optional prompt during install.
- Docs: README env table + gateway README + `skill/skill-example.md` note;
  plugin generator VERSION bumps + `npm run build:plugin`.

### Analytics

- Shared analytics records gain nothing key-related. At most a boolean
  `byok: true` so the public stats can showcase BYOK adoption — never the key.

## Security notes

- The key is a secret: client config files already hold `LLM_GATEWAY_TOKEN`, so
  the storage surface is unchanged in kind.
- Gateway must never echo the key in error bodies (`detail` messages) — add a
  test asserting error paths don't reflect request headers.
- Validate the header shape and cap its length (e.g. 256 chars) before use.
