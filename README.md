# Token Optimizer

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

1. **Gateway token** — request access in the installer, then use the emailed
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
options such as `--token`, `--byok-key`, and `--local`.

## Use it

Ask your coding agent to use Token Optimizer when it needs to understand a
codebase, validate a change, or diagnose a failure. The main tools are:

- `scout_codebase` — finds likely files before broad exploration.
- `run_changed_files_review` — checks small diffs before expensive validation.
- `run_test_verdict` — runs build, test, lint, or smoke commands and returns a
  compact verdict.
- `run_failure_triage`, `query_log`, and `grep_log` — investigate stored logs
  without pasting them into the conversation.
- `run_command_digest` — summarizes noisy commands such as builds or installs.
- `run_regression_check` — compares auto-detected validation with a local
  baseline when baseline updates are intended.

Tool run logs and private analytics are stored under
`<workspace>/.codex-local-test-runs/`. Run `npm run analytics:ui` from a clone
of this repository if you want a local multi-workspace analytics dashboard.

## Provider notes

Gateway calls use an approved access token and have the gateway's configured
daily allowance. A BYOK OpenRouter key is independent of the shared gateway
quota. A local provider keeps inference on your machine.

The gateway's public token-request portal uses a honeypot and completion-time
check in addition to its existing rate limit. Operators with email delivery
configured receive a best-effort alert at `GMAIL_USER` for each accepted request.

If a local or gateway provider is unavailable, validation command exit codes
remain authoritative and Token Optimizer reports the unavailable summary rather
than claiming an LLM verdict.

## Troubleshooting

- Restart your client after installing or changing provider settings.
- Run `check_local_llm_health` to verify the selected provider.
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
