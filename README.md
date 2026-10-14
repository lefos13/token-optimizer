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

1. **Your own OpenRouter key** — usage is billed to your OpenRouter account.
2. **Local LLM** — point the tools at your OpenAI-compatible local endpoint.

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

Already have the plugin or skill but not a working server? Ask your agent to
run the `token-optimizer-setup` skill: it checks your machine, proposes the
installer commands, and tells you what is left to do.

See the [installer guide](packages/installer/README.md) for non-interactive
flags, managing an existing install (`status`, `doctor`, `repair`,
`uninstall`), and upgrading from an older version.

## Use it

Ask your coding agent to use Token Optimizer when it needs to understand a
codebase, validate a change, or diagnose a failure. The main tools are:

- `scout_codebase` — finds likely files before broad exploration.
- `run_changed_files_review` — checks small diffs before expensive validation.
- `run_test_verdict` — runs build, test, lint, or smoke commands and returns a
  compact verdict while keeping raw command output in the workspace log.
- `run_failure_triage`, `query_log`, and `grep_log` — investigate stored logs
  without pasting them into the conversation.
- `run_command_digest` — summarizes noisy commands such as builds or installs.
- `run_regression_check` — compares auto-detected validation against a local
  baseline.

## Choosing what the agent may run

The installer asks which commands Token Optimizer may run for your agent:

| Profile | What the agent may run |
| --- | --- |
| `standard` (recommended) | Your project's build/test/lint scripts, common test runners and linters (vitest, jest, pytest, cargo, go, tsc, eslint, ruff, ...), and read-only inspection (git status/log/diff, ls, grep, cat). |
| `safe` | Only commands you allow explicitly. |
| `unrestricted` | Any command. Use only for repositories you trust. |

Every profile still blocks command chaining, pipes, redirection, network
tools, secret files such as `.env` or keys, and paths outside the workspace.
Change your choice any time; it applies on the next tool call:

```bash
npx @softawarest/token-optimizer-installer profile standard
npx @softawarest/token-optimizer-installer allow "npm install"
npx @softawarest/token-optimizer-installer allow --list
npx @softawarest/token-optimizer-installer allow --remove "npm install"
```

When a command is blocked, the tool result says why and, if it can be
allowed, includes the exact `allow` command. Your agent should ask you before
running it.

Tool run logs and private analytics are stored under
`<workspace>/.codex-local-test-runs/`. Run `npm run analytics:ui` from a clone
of this repository if you want a local multi-workspace analytics dashboard.

## Choosing a provider

| Provider mode | Inference runs on | Data sent remotely | Credential |
| --- | --- | --- | --- |
| Local LLM | Your own machine/endpoint | Nothing | None |
| Your OpenRouter key | OpenRouter | Redacted, bounded excerpts | Your OpenRouter API key |

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
- **Upgrading from 2.x with a gateway token:** the shared gateway was retired in
  3.0.0. Re-run the installer and choose OpenRouter or a local LLM. An existing
  OpenRouter (BYOK) key is migrated automatically to direct OpenRouter.
- Run `check_local_llm_health` to verify the selected LLM provider (local or OpenRouter).
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
