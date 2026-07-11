# Token Optimizer Installer

Execution `signal` is `null` when no OS signal was observed and is populated only for signal-terminated processes.

Execution profiles (`safe`, `standard`, `unrestricted`) are deny-first policy controls, not an operating-system sandbox; lower-trust settings cannot elevate the user's ceiling. Logs default to 7-day retention and a 500 MB per-workspace quota, with expired/oldest logs pruned under `.codex-local-test-runs/`. Responses expose completed/blocked/timed_out/spawn_failed statuses, policy and auto-detection metadata, truncation, provider status, warnings, and redaction summaries.

Optional one-command installer for Token Optimizer.

Run it from outside a Token Optimizer source checkout so `npx` cannot prefer a
stale local development dependency:

```powershell
cd $HOME
npx --yes @softawarest/token-optimizer-installer
```

```bash
npx @softawarest/token-optimizer-installer
```

On every run the installer first checks npm for a newer installer release. If
one exists and the session is interactive, it prints the available version and
offers to re-run `npx --yes @softawarest/token-optimizer-installer@latest` with
your original arguments so you always install the latest build (npx can
otherwise serve a cached version). The check is best-effort: network or
registry errors, a non-interactive session, `--skip-update-check`, or
`TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK=1` skip it and let the current version run.

The installer copies packaged MCP server/plugin assets into stable user-owned
locations, prompts for how to configure the LLM provider, writes supported
client MCP config, and applies default-on global instructions where the client
exposes a writable file.

Re-running the installer is safe and refreshes Token Optimizer. It replaces
installer-managed local files for Antigravity, OpenCode, and Cursor; updates
the Claude marketplace plugin when the Claude CLI is available; and removes
then re-adds the Codex marketplace plugin to replace Codex's versioned cache.
If a client CLI is unavailable, the installer keeps the CLI-free local
fallback. Restart the affected client after installation.

**A gateway/proxy token is not required** to use this tool. With no provider
flags, the installer prompts for one of three providers, plus a skip option:

| Mode | Token needed? | Who pays for inference? | Limit |
| --- | --- | --- | --- |
| `gateway` | **Yes** — request + operator approval | The gateway operator | 20 calls/day by default (operator-adjustable) |
| `byok` | **No, none at all** | You, via your own OpenRouter account | Unlimited |
| `local` | **No, none at all** | Nobody — your own hardware | Unlimited |

Provider privacy at inference time is explicit:

| Provider mode | Inference destination | Remote payload | Credential boundary |
| --- | --- | --- | --- |
| `local` | Your local OpenAI-compatible endpoint | Nothing beyond that endpoint | No Token Optimizer credential |
| `openrouter-direct` | OpenRouter | Redacted, bounded excerpts | OpenRouter key goes directly to OpenRouter |
| `gateway-token` | Softaware gateway | Redacted, bounded excerpts | Gateway token; gateway-managed model |
| `gateway-byok` | Softaware gateway → OpenRouter | Redacted, bounded excerpts plus BYOK key | BYOK key is visible to the Softaware gateway |

Legacy v1 gateway + BYOK environment variables remain mapped to `gateway-byok`
and produce a compatibility warning; migration does not silently change the
destination. Remote results may include `redactionSummary` and
`providerWarnings` metadata (never secret values). `raw-local` diagnostics can
still contain secrets printed by commands. If inference is unavailable or model
output fails schema validation, command exit codes remain authoritative and the
installer-connected tools report a conservative `uncertain` result.

In `gateway-byok` mode the OpenRouter key crosses the Softaware gateway before
reaching OpenRouter; choose `openrouter-direct` when
the key must go directly to OpenRouter.

1. **Gateway access token** — shared infrastructure, requires an approved token.
   Request one at [https://llm-proxy.lnf.gr/](https://llm-proxy.lnf.gr/).
2. **Your own OpenRouter key (`byok`)** — get a key from
   [openrouter.ai](https://openrouter.ai), no request or approval needed. The
   gateway does not authenticate a BYOK-only caller at all: since you aren't
   using the operator's OpenRouter setup, there's nothing for a proxy token to
   gate. Unlimited usage, billed to your own account.
3. **Local LLM only** — no token at all; point the tools at any OpenAI-compatible
   endpoint you run yourself (e.g. llama.cpp, LM Studio, Ollama's OpenAI-compat
   API). Defaults to `http://localhost:8080/v1`.
4. **Skip for now** — installs the MCP server with no provider configured;
   finish later with `token-optimizer config`.

With no `--clients` option, the installer targets detected clients. Use
`--clients all` to force every supported client.

Default `install` behavior:

- prompts for the provider mode (unless `--provider`, `--token`, `--byok-key`, or `--local` is passed)
- installs marketplace/plugin assets for Claude Code and Codex
- copies bundled plugin/server/skill assets for Antigravity, OpenCode, and Cursor
- writes the resulting provider env vars into supported client config:
  - `gateway` → `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`
  - `byok` → `LLM_GATEWAY_URL`, `OPENROUTER_BYOK_KEY`, optional `OPENROUTER_BYOK_MODEL` (no `LLM_GATEWAY_TOKEN` is written)
  - `local` → `LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`
- writes default-on instruction files for Claude Code, Codex, Antigravity, and OpenCode
- on macOS, mirrors the provider env into the GUI-session environment so
  Dock/Finder/Spotlight-launched clients inherit it. This is done two ways: an
  immediate `launchctl setenv` for the current login, plus a `RunAtLoad`
  LaunchAgent at `~/Library/LaunchAgents/com.softawarest.token-optimizer.env.plist`
  (chmod 600) that re-applies the values at every future login — a bare
  `launchctl setenv` does not survive a reboot or logout. Switching to a
  provider with no managed values (or an uninstall) removes the LaunchAgent.

Credential-bearing modes use `--credential-store native` by default. The
installer writes only `TOKEN_OPTIMIZER_CREDENTIAL_REF` to all client config
shapes and the LaunchAgent; the launcher resolves the native secret and exposes
it only to the MCP child. Native-store failure aborts without fallback.
`--credential-store env` references an existing `LLM_GATEWAY_TOKEN`,
`OPENROUTER_BYOK_KEY`, or `OPENROUTER_API_KEY` in the parent/client environment;
it never stores a supplied secret and fails when the variable is absent.
`--credential-store config` explicitly opts into protected-file plaintext.
Local and skip need no store. Credential writes participate in install/config
rollback, and uninstall removes only credentials recorded as installer-owned.
  Pass `--skip-launchctl` to skip all GUI-session env writes.

Client-specific behavior:

- Claude Code:
  adds the packaged marketplace, updates `token-optimizer@token-optimizer-marketplace` (falling back to install when it is not yet present), writes `~/.claude/settings.json`, writes `~/.claude/CLAUDE.md`.
  If the `claude` CLI is unavailable (desktop-app installs, common on Windows), the plugin is instead copied into `~/.claude/skills/token-optimizer/`, which Claude Code loads as a skills-directory plugin (`token-optimizer@skills-dir`) on the next session.
- Codex:
  adds the packaged marketplace, removes any installed `token-optimizer` cache entry, and adds it from `Softaware-marketplace` for skill discovery. It always registers the bundled Node server as `[mcp_servers.token_optimizer]` in `~/.codex/config.toml`, carrying the selected provider environment into the MCP process, and copies the skill into `~/.codex/skills/token-optimizer/`.
- Antigravity:
  copies the plugin into `~/.gemini/config/plugins/token-optimizer`, writes Gemini/plugin MCP config, writes `~/.gemini/GEMINI.md`.
- OpenCode:
  copies the server and skill into `~/.config/opencode/`, writes `~/.config/opencode/opencode.jsonc`, writes `~/.config/opencode/AGENTS.md`.
- Cursor:
  copies the server into `~/.cursor/token-optimizer-server`, writes `~/.cursor/mcp.json`.
  Global defaults are not supported by file path; use `--cursor-project /path/to/project` to copy the project rule, or add a User Rule in Cursor Settings.

Examples:

```bash
npx @softawarest/token-optimizer-installer --clients opencode,cursor
npx @softawarest/token-optimizer-installer --clients all --cursor-project /path/to/project
npx @softawarest/token-optimizer-installer --local
npx @softawarest/token-optimizer-installer --local --local-url http://localhost:11434/v1 --local-model llama3
npx @softawarest/token-optimizer-installer --byok-key sk-or-...
npx @softawarest/token-optimizer-installer --byok-key sk-or-... --byok-model provider/model
npx @softawarest/token-optimizer-installer --provider skip
npx @softawarest/token-optimizer-installer config --token <token>
npx @softawarest/token-optimizer-installer config --byok-key sk-or-...
npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode
```

## Inspect, repair, and remove safely

Preview every mutation with `--dry-run` (or `--json` for automation), including
managed paths, client commands, credential-store operations, and GUI-session
environment changes. The ownership manifest at `~/.token-optimizer/manifest.json`
stores paths, hashes, and references only—never raw API keys. Repair and
uninstall operate only on matching managed hashes, preserving user edits.
Rollback snapshots are scoped to selected client roots (and requested Cursor
projects), avoiding unrelated macOS privacy-protected home directories.

```bash
npx @softawarest/token-optimizer-installer install --local --dry-run
npx @softawarest/token-optimizer-installer status
npx @softawarest/token-optimizer-installer doctor --strict
npx @softawarest/token-optimizer-installer repair --dry-run
npx @softawarest/token-optimizer-installer uninstall --dry-run
```

`status` is read-only; `doctor` performs a provider health check and exits `1`
for errors, `2` for warnings with `--strict`, and `0` when healthy. Credential
stores prefer macOS Keychain, Windows DPAPI/Credential Manager, and Linux
Secret Service/libsecret; any fallback is visible in the dry-run plan. Legacy
provider migration removes only superseded managed keys. Raw logs are scoped to
an absolute workspace and managed with `logs status|prune|purge`; purge keeps
baseline and analytics metadata unless explicit include flags are supplied.

For a v1 upgrade, run `token-optimizer install --migrate --dry-run --json`,
then remove the preview flags to apply. The migration preserves legacy BYOK
gateway routing by default, uses the transactional credential store, creates a
private backup and manifest, and delays plaintext cleanup until doctor passes.
The exact preview operation IDs execute in order; the doctor resolves the new
credential reference and sends mode-appropriate authentication before
structured cleanup. Repeated runs are no-ops and any failure restores
pre-migration file, service, registration, credential, and manifest state.
Migration refuses real Claude/Codex CLI or macOS launchctl mutation unless a
reversible adapter captures the pre-state first. Use `--skip-client-commands`
or `--skip-launchctl` explicitly when running without those adapters.
All migration failures are credential-redacted before CLI or JSON reporting.

Flow-specific commands:

- `npx @softawarest/token-optimizer-installer`:
  full install, prompts for a provider, and writes defaults where supported.
- `npx @softawarest/token-optimizer-installer --local`:
  full install with a local LLM only; no token, no gateway config written.
- `npx @softawarest/token-optimizer-installer --byok-key sk-or-...`:
  full install with your own OpenRouter key; no proxy token is asked for or written.
  The installer prompts for an optional model after the key, or accepts
  `--byok-model <model-id>`. This setting is used only with BYOK; when omitted
  or blank, the gateway keeps its task-specific/default model selection.
  Shared gateway-token callers cannot override the gateway model.
- `npx @softawarest/token-optimizer-installer --no-defaults`:
  full install and provider config, but skip default-on instructions.
- `npx @softawarest/token-optimizer-installer config --token <token>`:
  write only gateway config.
- `npx @softawarest/token-optimizer-installer config --byok-key sk-or-...`:
  write only BYOK config; no `--token` needed.
- `npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode`:
  write only default-on instructions.

Publish verification:

```bash
npm view @softawarest/token-optimizer-installer name version dist-tags --json
npx @softawarest/token-optimizer-installer --help
```

Wait to share the package until both commands succeed.

Cursor global MCP config can be written automatically. Cursor default-on rules
are project-scoped unless you add an equivalent global User Rule in Cursor
Settings.

## Windows support

The installer is fully supported on Windows. All MCP servers are launched with
`node server/start.js` (a cross-platform launcher) — `bash` is never required.
For Codex, this direct registration is also the credential-bearing runtime
path, while the marketplace plugin supplies skill discovery.

The launcher verifies that the MCP SDK and `zod/v3` resolve before startup. An
incomplete launcher-owned dependency cache is removed and reinstalled once,
then verified again; healthy caches remain on the no-install fast path.
Client CLI detection uses `where` on Windows, and `.cmd`-shim CLIs are invoked
through `cmd.exe`. When the `claude` or `codex` CLI is not on `PATH` (typical
for desktop-app installs), the CLI-free fallbacks above are used instead.
Requirements: `node` and `npm` on `PATH`.
