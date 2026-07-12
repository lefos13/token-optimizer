# Token Optimizer

## Security boundary

Token Optimizer applies a deny-first command policy before spawning commands, canonicalizes workspace paths, redacts recognized secrets at every remote inference hop, validates model output conservatively, and uses secret-free transactional installer plans. The `safe`, `standard`, and `unrestricted` profiles express policy ceilings; none is an operating-system sandbox. Run hostile repositories only inside an OS sandbox or container. See [the threat model](docs/security/threat-model.md) for actors, trust boundaries, exact controls, deterministic security tests, and residual risks. Release candidates must pass `npm run test:security` without a live home directory, external network, provider, or keychain.

Execution metadata uses `signal: null` when no OS signal was observed; a signal value is populated only for signal-terminated processes.

## Execution profiles and log lifecycle

Command tools accept `executionProfile` (`safe`, `standard`, or `unrestricted`) and optional `allowedCommandPrefixes`; lower-trust project/tool settings can only narrow the user's ceiling. Safe requires an allowlist, standard permits explicitly auto-detected validation commands, and unrestricted permits commands not denied by policy. This is deny-first policy enforcement, not an operating-system sandbox.

Responses add `executionStatus` (`completed`, `terminated`, `blocked`, `timed_out`, or `spawn_failed`), `signal`, `policyDecision`, `autoDetected`, `logTruncated`, `providerStatus`, and `warnings`. `terminated` records a non-timeout OS signal; `timed_out` remains reserved for timeout enforcement. Final log persistence is atomic and reports `auditStatus`; an `auditFailure` preserves the command outcome and identifies retained temporary evidence when fsync or rename fails. Logs default to raw-local storage for 7 days with a 500 MB quota; pruning removes expired logs then oldest quota victims within the target workspace's `.codex-local-test-runs/`. Raw-local logs may contain secrets; remote requests are redacted and report `redactionSummary` and provider warnings.

Per-command output streams are finalized before suite assembly. Open, write, disk-full, permission, and finalization failures therefore preserve authoritative exit/signal data while reporting audit failure separately. In-progress `.active.tmp` files carry a PID/run-id lease and are excluded from status, retention, quota pruning, and purge while that owner is alive. Fsync and close failures remove the active file and lease; after successful fsync and close, a final-rename failure atomically marks the file `.retained.audit.tmp` before it can be reported or registered. If marking and deletion both fail, `tempCleanup: failed` reports the contained `orphanPath` without registering it. Recovery requires both one-hour age and a dead or missing lease owner, so legitimate long-running commands remain protected. Retained evidence participates in lifecycle operations exactly like `.log` runs. Registry, lifecycle, and local analytics persistence failures remain non-fatal and appear in `warnings`.

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
paths and hashes without storing credentials or runtime caches/logs; edited user
files are preserved. Repair uses stable doctor paths and operation hints for an
exact idempotent plan. Uninstall rolls back earlier mutations on failure and
fails closed with an explicit follow-up when reversible client/service cleanup
is unavailable.
Rollback snapshots are limited to the selected clients' managed roots, so the
installer never scans unrelated privacy-protected home folders such as Music.
Provider-health probes are independently limited by client IP and key
fingerprint, then concurrency-limited before upstream access; forwarded IPs
require explicit trusted-proxy configuration. Doctor treats ownership manifests as untrusted input: it
only inspects installer-known roots and applies entry-count, per-file, and
total-byte limits before hashing. `--installed-version` remains authoritative
for mismatch diagnostics even when no client registration is discovered.
Credential stores and any fallback are shown in the plan. Use
`logs status|prune|purge --workspace <absolute-path>` for raw-log lifecycle.
`status` performs no network/provider call and launches no client process while
inspecting MCP config and marketplace cache files, installed package versions,
launcher entrypoints, resolvable SDK/zod runtime dependencies,
manifest/service state, and optional `--workspace` logs. `doctor` adds an
authenticated quota-free provider check: local `/models`, OpenRouter `/auth/key`,
or the gateway's BYOK metadata-validation route.
Stable findings include repair operations/paths without secrets; errors exit
`1`, and warning-only `--strict` reports exit `2`.

Upgrade v1 installations with `token-optimizer install --migrate`. Add
`--dry-run --json` for the same secret-free plan without mutation. Migration
detects all five clients, preserves legacy BYOK gateway routing unless direct
OpenRouter is explicitly selected, creates private backups, and removes raw
legacy credentials only after authenticated doctor validation. Failures roll
back client files, credentials, services, registrations, and ownership state.
The JSON preview is the registered executable plan: apply uses those exact
operation IDs and order, resolves the migrated credential for a mode-specific
authenticated probe, then removes legacy credential keys structurally.
The public migration CLI intentionally skips Claude/Codex CLI registration and
real macOS launchctl changes, then reports a normal-install follow-up. Library
callers may supply reversible state-capturing adapters; otherwise those
external mutations fail preflight. Detection reads only known client config
files and never recursively scans histories, conversations, or project data.
Cleanup is scoped inside those files to Token Optimizer’s own MCP server/env
object or TOML section; credentials belonging to other servers are preserved.
Migration errors are sanitized against detected and selected credentials plus
authorization-header patterns before they reach human or JSON CLI output.

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

## Release procedure

Releases are published only from an approved GitHub Release whose tag is exactly
`v<package version>`. Stable versions publish under `latest`; `alpha`, `beta`,
and `rc` versions publish only under their matching npm dist-tag. Before creating the tag, commit generated
assets and run `npm ci`, `npm run release:preflight`, and `npm test`. The
preflight rejects dirty trees, version or tag mismatches, generated drift,
high/critical audit findings, and invalid package/SBOM output. CycloneDX files
are written to the ignored `release-artifacts/` directory. The release workflow
publishes the installer with npm trusted-publishing provenance; it never
publishes from a branch push.

Local and pull-request validation can use
`npm run release:preflight -- --allow-no-tag`; this explicit bypass is reported
as `NO_RELEASE_TAG` and is never used by the publishing workflow.

## Troubleshooting

Execution and log requests are evaluated across user, project, and MCP tool
layers, but provider destination, model routing, and runtime credential use are
user-authoritative. Project and tool provider objects are ignored with a stable
warning, so repository content cannot redirect an inherited credential. Legacy
provider environment variables are consulted only when user provider policy is
absent. User config must be a private, owned regular file on POSIX; config reads
are open-once and limited to 64 KiB. POSIX uses `O_NOFOLLOW`; Node exposes no
equivalent Windows open flag, so Windows relies on canonical containment and
post-open regular-file validation. Lower layers may only tighten command/log
policy. Their redaction rules use a linear-safe grammar—concatenated literals,
classes, safe escapes, edge anchors, and exact repetitions with a total expanded
match width capped at 64 across the complete custom rule set—and are added
to mandatory user and built-in rules at every final remote inference hop.
User rules consume this budget first; an excess project/tool addition fails
configuration deterministically instead of weakening or replacing user rules.

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

Responses add `executionStatus` (`completed`, `terminated`, `blocked`, `timed_out`, or `spawn_failed`), `signal`, `policyDecision`, `autoDetected`, `logTruncated`, `providerStatus`, and `warnings`. Final audit persistence reports `auditStatus`; failures add `auditFailure` without replacing authoritative command exit/signal data, and retained `.audit.tmp` evidence is named explicitly. Logs default to raw-local storage for 7 days with a 500 MB quota; pruning removes expired logs then oldest quota victims, scoped to the target workspace's `.codex-local-test-runs/`. Raw-local logs may contain command secrets; remote requests are redacted and expose only `redactionSummary` and provider warnings.

Command temp-stream open/write/end failures are awaited and reported as audit failures; incomplete `.active.tmp` evidence and its PID lease are removed on cleanup. Lifecycle recovery considers an aged active file only when its lease is missing or its owner PID is dead. Cleanup reports `removed` or `failed` explicitly. After fsync and close, rename failure atomically transitions the file to `.retained.audit.tmp`; only that state is registered and lifecycle-managed. If transition and deletion fail, the response exposes a contained `orphanPath` and does not register it. Registry, lifecycle, and analytics persistence remain best-effort and add warnings to the same response.

Streaming excerpts decode large chunks in bounded slices, preventing a binary or single long line from creating an output-sized string in each collector. Release evidence for this path is produced with `TOKEN_OPTIMIZER_BENCHMARK_MODE=deterministic-local npm run benchmark`; see `benchmarks/README.md` for the exact stdio MCP, mock-provider, byte, exit, and process-tree RSS methodology.
