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

If a local or gateway provider is unavailable, validation command exit codes
remain authoritative and Token Optimizer reports the unavailable summary rather
than claiming an LLM verdict.

## Troubleshooting

- Restart your client after installing or changing provider settings.
- Run `check_local_llm_health` to verify the selected provider.
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
