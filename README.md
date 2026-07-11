# Token Optimizer

Execution metadata uses `signal: null` when no OS signal was observed; a signal value is populated only for signal-terminated processes.

## Execution profiles and log lifecycle

Command tools accept `executionProfile` (`safe`, `standard`, or `unrestricted`) and optional `allowedCommandPrefixes`; lower-trust project/tool settings can only narrow the user's ceiling. Safe requires an allowlist, standard permits explicitly auto-detected validation commands, and unrestricted permits commands not denied by policy. This is deny-first policy enforcement, not an operating-system sandbox.

Responses add `executionStatus` (`completed`, `blocked`, `timed_out`, or `spawn_failed`), `policyDecision`, `autoDetected`, `logTruncated`, `providerStatus`, and `warnings`. Logs default to raw-local storage for 7 days with a 500 MB quota; pruning removes expired logs then oldest quota victims within the target workspace's `.codex-local-test-runs/`. Raw-local logs may contain secrets; remote requests are redacted and report `redactionSummary` and provider warnings.

Token Optimizer is an MCP server that runs local validation commands and turns
large build, lint, test, and smoke-check logs into compact, actionable results.
Raw logs stay in your workspace while your coding agent receives a verdict,
triage, or targeted excerpt.

## Quickstart (recommended)

Install it with the npm installer from a normal working directory (not from a
Token Optimizer source checkout):

```powershell
cd $HOME
npx --yes @softawarest/token-optimizer-installer
```

Choose one provider when prompted:

1. **Gateway token** — request an access token at
   [https://llm-proxy.lnf.gr/](https://llm-proxy.lnf.gr/), then use the emailed
   token after approval.
2. **Your own OpenRouter key** — unlimited usage billed to your account; no
   gateway token is needed.
3. **Local LLM** — point the tools at your OpenAI-compatible local endpoint.

The installer detects supported clients, installs the right plugin/server
assets, writes provider configuration, and enables default-on usage where the
client supports it. Restart your client after installation.

Re-running the installer is safe and refreshes Token Optimizer. It replaces the
installer-managed local assets for Antigravity, OpenCode, and Cursor; refreshes
the Claude marketplace plugin when the Claude CLI is available; and removes
then re-adds the Codex marketplace plugin so Codex replaces its versioned
cache. When a client CLI is unavailable, the installer retains its local
fallback instead. All local MCP registrations start `node` with `start.js`, so
the same installation path works on Windows without Bash.

Generated launchers verify that the MCP SDK and its Zod compatibility entry
point are actually resolvable before starting. If an interrupted npm install
left an incomplete launcher-owned dependency cache, the launcher removes only
that cached `node_modules`, reinstalls it, verifies it again, and then starts
the server. Codex marketplace launches also forward `OPENROUTER_BYOK_KEY`, so
BYOK mode does not require a gateway access token.

Run `npx @softawarest/token-optimizer-installer --help` to see non-interactive
options such as `--token`, `--byok-key`, `--byok-model`, and `--local`.

Credential-bearing provider installs default to `--credential-store native`.
Only a `TOKEN_OPTIMIZER_CREDENTIAL_REF` is written to client configuration;
the bundled launcher resolves the OS credential store and injects the secret
only into the MCP child process. Native-store failures stop installation.
`--credential-store env` references an already-exported provider variable
(`LLM_GATEWAY_TOKEN`, `OPENROUTER_BYOK_KEY`, or `OPENROUTER_API_KEY`) and never
stores a supplied flag value; it fails if that parent/client variable is absent.
`--credential-store config` is an explicit protected-file plaintext opt-in.
Local and skipped providers do not use a credential store.

The installer is lifecycle-safe: preview writes with `install --dry-run`, then
use `status`, `doctor`, `repair --dry-run`, or `uninstall --dry-run` before any
mutation. A manifest under `~/.token-optimizer/manifest.json` records owned
paths and hashes without storing credentials; edited user files are preserved.
Rollback snapshots are limited to the selected clients' managed roots, so the
installer never scans unrelated privacy-protected home folders such as Music.
Credential stores and any fallback are shown in the plan. Use
`logs status|prune|purge --workspace <absolute-path>` for raw-log lifecycle.

Upgrade v1 installations with `token-optimizer install --migrate`. Add
`--dry-run --json` for the same secret-free plan without mutation. Migration
detects all five clients, preserves legacy BYOK gateway routing unless direct
OpenRouter is explicitly selected, creates private backups, and removes raw
legacy credentials only after authenticated doctor validation. Failures roll
back client files, credentials, services, and ownership state.

## Use it

Ask your coding agent to use Token Optimizer when it needs to understand a
codebase, validate a change, or diagnose a failure. The main tools are:

- `scout_codebase` — finds likely files before broad exploration.
- `run_changed_files_review` — checks small diffs before expensive validation.
- `run_test_verdict` — runs build, test, lint, or smoke commands and returns a
  compact verdict.
- `run_failure_triage`, `query_log`, and `grep_log` — investigate stored logs
  without pasting them into the conversation.

`run_failure_triage` requires `workspacePath` and only reads regular log files
under that workspace's `.codex-local-test-runs` managed directory.
- `run_command_digest` — summarizes noisy commands such as builds or installs.
- `run_regression_check` — compares auto-detected validation with a local
  baseline when baseline updates are intended.

Tool run logs and private analytics are stored under
`<workspace>/.codex-local-test-runs/`. Run `npm run analytics:ui` from a clone
of this repository if you want a local multi-workspace analytics dashboard.

## Provider notes

### Provider privacy matrix

| Provider mode | Inference destination | Data sent remotely | Credential boundary |
| --- | --- | --- | --- |
| `local` | Your configured local OpenAI-compatible endpoint | None outside the endpoint you run | No Token Optimizer credential required |
| `openrouter-direct` | OpenRouter directly | Redacted, bounded excerpts | Your OpenRouter key goes directly to OpenRouter |
| `gateway-token` | Softaware gateway | Redacted, bounded excerpts | Gateway access token; the gateway selects the model |
| `gateway-byok` | Softaware gateway, which proxies OpenRouter | Redacted, bounded excerpts and the BYOK key | Your OpenRouter key crosses the Softaware gateway |

Remote inference always receives redacted excerpts. `redactionSummary` reports the
count and categories removed from a remote request; it never contains the secret
values. `providerWarnings` reports trust or compatibility warnings returned by
provider resolution. Raw-local logs can still contain secrets printed by a
command, so protect `.codex-local-test-runs/` like any other diagnostic data.

The v1 configuration using `LLM_GATEWAY_URL` with `OPENROUTER_BYOK_KEY` remains
supported as `gateway-byok` and emits a legacy compatibility warning. This keeps
the old gateway destination instead of silently moving requests to OpenRouter
direct. New installations should choose `openrouter-direct` when direct BYOK
privacy is preferred. If structured model output is malformed, or a provider is
unavailable, validation command exit codes remain authoritative and the result is
`uncertain` with validation/provider metadata rather than an invented pass.

Gateway calls use an approved access token and have the gateway's configured
daily allowance. A BYOK OpenRouter key is independent of the shared gateway
quota. A local provider keeps inference on your machine.

`OPENROUTER_BYOK_MODEL` is optional and works only with
`OPENROUTER_BYOK_KEY`. When set, it selects one OpenRouter model for verdict,
triage, review, digest, scout, and query requests. When omitted or blank, the
gateway keeps its task-specific/default model selection. Shared gateway-token
callers cannot override the gateway's model. The installer prompts for this
optional value after the BYOK key, or accepts `--byok-model <model-id>`.

The gateway's public token-request portal is at
[https://llm-proxy.lnf.gr/](https://llm-proxy.lnf.gr/) and uses a honeypot and
completion-time check in addition to its existing rate limit. Operators with email delivery
configured receive a best-effort alert at `GMAIL_USER` for each accepted request.

If a local or gateway provider is unavailable, validation command exit codes
remain authoritative and Token Optimizer reports the unavailable summary rather
than claiming an LLM verdict.

## Troubleshooting

- Restart your client after installing or changing provider settings.
- Run `check_local_llm_health` to verify the selected LLM provider (local, gateway, or direct OpenRouter).
- If tools are absent after a prior interrupted dependency install, restart the
  client. The launcher now detects and repairs incomplete runtime caches before
  registering its MCP tools.
- Run the installer from outside this repository so `npx` does not select an
  older local development dependency.
- Use `npx @softawarest/token-optimizer-installer config` to update provider
  settings without reinstalling client assets.

## Documentation

- [Installer guide](packages/installer/README.md) — client installation and
  provider choices.
- [Gateway operator guide](gateway/README.md) — deployment, token approvals,
  email delivery, analytics, and portal administration.
- [Skill instructions](skill/skill-example.md) — agent-facing tool workflow.

## Development

```bash
npm run build
npm test
npm run build:plugin
npm run build:installer
```

Do not publish an installer package until `npm pack ./packages/installer
--dry-run` and the full test suite succeed.

Any change that affects the installed server, a plugin, skill instructions, or
the installer must receive a new aligned release version. Keep the root package,
installer package, MCP server metadata, and all plugin generators on that same
version, then run `npm run build:installer` before publishing.
### Execution profiles and log lifecycle

Command tools accept `executionProfile` (`safe`, `standard`, or `unrestricted`) and optional `allowedCommandPrefixes`; lower-trust project/tool settings can only narrow the user's ceiling. Safe requires an allowlist, standard additionally permits explicitly auto-detected validation commands, and unrestricted permits commands not denied by policy. This is deny-first policy enforcement, not an operating-system sandbox: commands run with the host user's permissions.

Responses add `executionStatus` (`completed`, `blocked`, `timed_out`, or `spawn_failed`), `policyDecision`, `autoDetected`, `logTruncated`, `providerStatus`, and `warnings`. Logs default to raw-local storage for 7 days with a 500 MB quota; pruning removes expired logs then oldest quota victims, scoped to the target workspace's `.codex-local-test-runs/`. Raw-local logs may contain command secrets; remote requests are redacted and expose only `redactionSummary` and provider warnings.
