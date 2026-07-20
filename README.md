# Token Optimizer

Token Optimizer is an MCP server that runs your project's build, lint, and
test commands and turns large, noisy logs into compact, actionable results.
Raw logs stay on your machine; your coding agent only sees a verdict, a
triage summary, or a targeted excerpt — not the full log.

## Quickstart (recommended)

Install it with the npm installer from a normal working directory (not from a
Token Optimizer source checkout):

```powershell
cd $HOME
npx --yes @softawarest/token-optimizer-installer
```

On a fresh installation, choose one provider when prompted. Environment
variables left by an older installation do not suppress this menu:

1. **Gateway token** — request an access token at
   [https://llm-proxy.lnf.gr/](https://llm-proxy.lnf.gr/), then use the emailed
   token after approval.
2. **Your own OpenRouter key** — unlimited usage billed to your account; no
   gateway token is needed.
3. **Local LLM** — point the tools at your OpenAI-compatible local endpoint.

The installer detects your coding client(s) (Claude Code, Codex, Antigravity,
OpenCode, Cursor), installs the right plugin/server assets, writes provider
configuration, and enables default-on usage where the client supports it.
**Restart your client after installation.**

Re-running the installer performs a clean, transactional update. It preserves
a usable provider configuration and files you have edited, switches each client
to its supported current registration, and removes older installer-owned copies.
A missing or inaccessible saved credential is not treated as usable, so the
provider menu is shown again.
Restart affected clients after a successful update so they discard cached MCP
state.

See the [installer guide](packages/installer/README.md) for non-interactive
flags, managing an existing install (`status`, `doctor`, `repair`,
`uninstall`), and upgrading from an older version.

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
- `run_regression_check` — compares auto-detected validation against a local
  baseline. It is deterministic and is excluded from the gateway's public
  context-savings statistics.

The installer creates a private user policy with the `standard` execution
profile. That profile permits workspace-detected build, typecheck, lint, and
test commands whether they are auto-detected or supplied explicitly. Shell
chaining and other dangerous shell syntax remain blocked, so submit lint and
test as separate commands. A blocked verdict has `validationOutcome: not_run`;
it means validation never started, not that the project failed.

Tool run logs and private analytics are stored under
`<workspace>/.codex-local-test-runs/`. Run `npm run analytics:ui` from a clone
of this repository if you want a local multi-workspace analytics dashboard.

## Choosing a provider

| Provider mode | Inference runs on | Data sent remotely | Token needed? |
| --- | --- | --- | --- |
| Local LLM | Your own machine/endpoint | Nothing | No |
| Your OpenRouter key (BYOK) | OpenRouter | Redacted, bounded excerpts | No — your own key, unlimited usage |
| Gateway token | Softaware's gateway | Redacted, bounded excerpts | Yes — request one, operator-approved |

Remote requests are always redacted before they leave your machine — secret
values are stripped, never transmitted. Raw local logs under
`.codex-local-test-runs/` are not redacted, since they never leave your
machine; treat that folder like any other diagnostic output that may contain
build secrets.

If your chosen provider is unreachable or returns something malformed, Token
Optimizer never invents a result — command exit codes stay authoritative and
the tool reports an honest "uncertain" verdict instead.

## Troubleshooting

- Restart your client after installing or changing provider settings.
- Run `check_local_llm_health` to verify the selected LLM provider (local, gateway, or direct OpenRouter).
- If tools are missing after an interrupted dependency install, just restart
  the client — the launcher detects and repairs an incomplete runtime cache
  automatically before registering its MCP tools.
- Run the installer from outside this repository so `npx` does not select an
  older local development dependency.
- Use `npx @softawarest/token-optimizer-installer config` to update provider
  settings without reinstalling client assets.
- `uninstall` removes installer-owned runtime caches, stale marketplace state,
  and managed GUI-session provider values as well as the installed assets. It
  leaves unrelated client settings and user-modified files in place.

## Security

Token Optimizer applies a deny-first command policy, redacts recognized
secrets before any remote request, and uses secret-free, reversible installer
plans. None of this is an operating-system sandbox — run untrusted
repositories inside a container or VM. See
[the threat model](docs/security/threat-model.md) for the full list of
actors, controls, and residual risks.

## Documentation

- [Installer guide](packages/installer/README.md) — client installation,
  provider choices, and managing an existing install.
- [Gateway operator guide](gateway/README.md) — deployment, token approvals,
  email delivery, analytics, and portal administration.
- [Skill instructions](skill/skill-example.md) — agent-facing tool workflow.
- [Threat model](docs/security/threat-model.md) — security design, controls,
  and residual risk.

## Development

```bash
npm run build
npm test
npm run build:plugin
npm run build:installer
```

See [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) for contributor
guidelines, the plugin-generator/release process, and repository structure.
