# Gateway Cleanup & Client Onboarding — Design

Date: 2026-07-08
Status: Approved (brainstorming), pending implementation plan
Follows: 2026-07-08-centralized-llm-gateway-design.md (the gateway is now built and deployed)

## Goal

Now that the centralized gateway is live in production, remove the pre-gateway
legacy surface and define a clean onboarding model so each client (Claude Code,
Codex, Antigravity/Gemini, and generic MCP clients) is configured with a proxy
token to reach the gateway.

Two outcomes:

1. **Legacy removed** — the OpenRouter-direct code path and the old OpenRouter
   key-distribution tooling are gone; the client speaks only to the gateway
   (primary) with a local model as fallback.
2. **Clear onboarding** — one proxy token per person, provisioned into that
   person's clients; the gateway URL is baked in (not secret); models are
   entirely server-side.

## Decisions

| Decision | Choice |
| --- | --- |
| OpenRouter-direct path in `src/llm.ts` | **Remove entirely.** Providers become `gateway` (primary) → `local-openai-compatible` (fallback) only. |
| Client token provisioning | **Repurpose the config CLI** into a gateway token tool that fans one token out to every client surface. |
| Token scope | **One token per person**, reused across that person's clients on their machine; added to the gateway's `PROXY_TOKENS` list. |
| Config tool reach | **Repo script only** (`npm run gateway:config`). Users without the repo set the one token manually per client (documented). |
| Gateway URL | **Baked in** as a non-secret default (`https://llm-proxy.lnf.gr/v1`); overridable. |
| README audience | **End-user install only.** Operator/hosting content lives in `gateway/README.md`. |

## Section 1 — Client cleanup (`src/llm.ts`)

Remove the OpenRouter-direct provider entirely:

- Delete constants `OPENROUTER_PROVIDER_NAME`, `DEFAULT_OPENROUTER_MODEL`, `OPENROUTER_API_URL`, and the `TASK_OPENROUTER_MODEL_ENV` map (all six `OPENROUTER_*_MODEL` per-task vars — obsolete now that the gateway pins models server-side).
- Remove the OpenRouter branch from `resolveProvider` → gateway (if `LLM_GATEWAY_TOKEN` + `LLM_GATEWAY_URL`) else local.
- Remove the OpenRouter branch from `checkLocalLLMHealth` → gateway branch + local branch only.
- `callWithFallback`'s remote-detection collapses to `providerName === GATEWAY_PROVIDER_NAME`.

Result: two providers only — `gateway` and `local-openai-compatible`. No behavior change for gateway or local paths; only the dead middle path is removed. Client tests updated to drop OpenRouter references.

## Section 2 — Config CLI becomes the gateway token tool

Rename `scripts/manage-openrouter-config.js` → `scripts/manage-gateway-config.js`; npm script `openrouter:config` → `gateway:config`.

- Manages exactly two keys: **`LLM_GATEWAY_TOKEN`** (prompted, required) and **`LLM_GATEWAY_URL`** (optional; default `https://llm-proxy.lnf.gr/v1`).
- Reuses the existing fan-out plumbing to the same surfaces: Claude `~/.claude/settings.json` env, Gemini `~/.gemini/config/mcp_config.json` env, the staged Antigravity plugin `mcp_config.json` env, and the macOS launchctl session (so Codex/GUI-launched clients inherit the value).
- Keeps `setup` / `update` / `delete` / `status` commands, the timestamped backups, and the `LOCAL_TESTER_LAUNCHCTL_STATE_PATH` test seam.
- Drops all OpenRouter and per-task-model prompting.

## Section 3 — Generators: swap injected env, bake URL, bump version

Each of `generate-plugin-antigravity.js`, `generate-plugin-claude.js`, `generate-plugin-codex.js`:

- Add a `GATEWAY_URL = "https://llm-proxy.lnf.gr/v1"` constant.
- Replace injected `OPENROUTER_*` env with `LLM_GATEWAY_URL` (defaulted to `GATEWAY_URL`) and `LLM_GATEWAY_TOKEN`; keep `LOCAL_LLM_*` passthrough for the optional local fallback.
  - Claude: `.mcp.json` uses `${LLM_GATEWAY_URL:-https://llm-proxy.lnf.gr/v1}` and `${LLM_GATEWAY_TOKEN:-}` (Claude variable expansion reads from `settings.json`).
  - Codex: `env_vars` passthrough list swaps `OPENROUTER_*` → `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN` (plus existing `LOCAL_LLM_*`).
  - Antigravity: staged config env + docs.
- Rewrite each generator's "OpenRouter (primary)" doc block → "Centralized gateway (primary): run `npm run gateway:config -- setup` and paste your proxy token; the gateway URL defaults to the shared gateway." Keep the "Local LLM (fallback)" block.
- Bump `VERSION` `1.3.0` → `1.4.0` in all three.
- Run `npm run build:plugin`; never hand-edit `plugin/`.

## Section 4 — Docs

- **`README.md`** — rewritten to be **end-user install only** (see Section 5). No operator/hosting content, no OpenRouter-direct references.
- **`skill/skill-example.md`** — update env references to gateway vars; drop OpenRouter.
- **`AGENTS.md`** — update "Local LLM Behavior" to describe gateway-primary → local-fallback; reword the "Do not add remote hosted LLM dependencies" guidance (the approved gateway is a remote hop) to reflect the current architecture; update the repo-shape reference from `manage-openrouter-config.js` to `manage-gateway-config.js`; update the `openrouter:config` mention.
- **`CLAUDE.md`** — update any reference to the renamed script / `openrouter:config`.
- **`gateway/README.md`** — add the operator "issue a token to a person" step (generate `openssl rand -hex 32` → add to `PROXY_TOKENS` in `gateway/deploy/gateway.env` → redeploy via `deploy-pm2.sh`). All other operator content stays.

## Section 5 — README (end-user install guide)

The README is scoped to a person who **already has a proxy token** and wants to use the tool in their client. Structure:

1. **What it is** — one or two sentences: an MCP server that runs your workspace's build/lint/test commands locally and returns compact LLM verdicts/triage via a shared gateway.
2. **Prerequisite** — "You have a gateway access token (ask your gateway operator)." The gateway URL is preconfigured.
3. **Install per client** — the normal plugin install for each:
   - Claude Code (marketplace install)
   - Codex (marketplace install)
   - Antigravity (copy/symlink the generated plugin folder)
4. **Set your token** — the one value the user must provide (URL is baked in):
   - Universal path (no repo needed): set `LLM_GATEWAY_TOKEN` in that client's config —
     Claude: `~/.claude/settings.json` env; Codex: environment/launchctl; Antigravity: its `mcp_config.json` env.
   - Shortcut (repo clone): `npm run gateway:config -- setup`, paste the token once → written to every client surface on the machine.
5. **Verify** — restart the client; the tools (`run_test_verdict`, etc.) are available and `check_local_llm_health` reports the gateway reachable.

Explicitly out of README scope (lives in `gateway/README.md`): hosting the gateway, generating/rotating tokens, `PROXY_TOKENS`, model configuration.

## Testing

- **Client:** `npm test` — existing gateway/local provider + health tests still pass after the OpenRouter removal (update any test text referencing OpenRouter); confirm no dangling references to removed symbols compile-break.
- **Config CLI:** tests using the `LOCAL_TESTER_LAUNCHCTL_STATE_PATH` seam and temp config paths — `setup` writes `LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN` to the managed surfaces; `delete` removes them; URL defaulting works when the user accepts the default.
- **Build/plugin:** `npm run build`, `npm run build:gateway`, `npm run build:plugin`; grep regenerated output for `1.4.0` and for `LLM_GATEWAY_` (and confirm no `OPENROUTER_` remains in generated configs).

## Out of scope / non-goals

- No change to the gateway service itself (already deployed and verified).
- No per-client or per-token access-control logic (one token per person; `PROXY_TOKENS` list already supports revocation additively).
- No bundling of the config tool into the plugin (repo-script-only decision).

## Risks

- Removing the OpenRouter-direct path means the raw server can no longer be exercised against OpenRouter without a gateway; local-model fallback and the deployed gateway cover real use, and tests stub the transport.
- Renaming the config script/npm task is a breaking change for anyone scripting `openrouter:config`; acceptable given it's a maintainer tool and the migration is intentional.
