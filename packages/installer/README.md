# Token Optimizer Installer

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

On every run the installer checks npm for a newer release and, in an
interactive session, offers to re-run itself on the latest version with your
original arguments. Skip this with `--skip-update-check` or
`TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK=1`.

The installer copies the MCP server/plugin assets into stable user-owned
locations, prompts for how to configure the LLM provider on a fresh install,
writes client MCP
config, and turns on default-on usage where the client supports it.
**Restart the affected client after installation.**

Re-running the installer performs a transactional update to the current
version. It preserves usable provider settings and user-edited files, converges each
client to one supported registration, and removes older installer-owned
copies. If a required step fails, the previous working installation is
restored. A stale environment variable or inaccessible saved credential does
not count as a usable installation and cannot suppress the provider menu.
Restart affected clients after a successful update.

Installation also creates `~/.config/token-optimizer/config.json` with your
execution profile. Interactive fresh installs ask which profile to use;
reinstalls keep the existing choice, and `--profile <safe|standard|unrestricted>`
sets it explicitly. Choosing `unrestricted` interactively requires typing
`unrestricted` to confirm.

- **standard** (default): detected build, typecheck, format-check, lint, and
  test commands; common runners invoked directly (tsc, vitest, jest, pytest,
  cargo, go, eslint, ruff, ...); and read-only inspection (git status/log/diff,
  ls, grep, cat). No package installs, in-place fixers, or arbitrary scripts.
- **safe**: only the prefixes you add with `allow`.
- **unrestricted**: any command.

Every profile still rejects command chaining, pipes, redirection, network
tools, destructive commands, secret files, and paths outside the workspace.

```bash
npx @softawarest/token-optimizer-installer profile               # show and change interactively
npx @softawarest/token-optimizer-installer profile unrestricted
npx @softawarest/token-optimizer-installer allow "npm install"   # allow a command prefix
npx @softawarest/token-optimizer-installer allow --list
npx @softawarest/token-optimizer-installer allow --remove "npm install"
```

Changes apply on the next tool call without restarting the client.

## Choosing a provider

On a fresh install with no provider flags, the installer prompts for one of
two providers, plus a skip option. A normal update preserves a usable installed
choice; run `config` or pass a provider flag to change it:

| Mode | Credential | Who pays for inference? |
| --- | --- | --- |
| `openrouter` | Your OpenRouter API key | You, via your own OpenRouter account |
| `local` | None | Nobody — your own hardware |

1. **Your own OpenRouter key (`openrouter`)** — get a key from
   [openrouter.ai](https://openrouter.ai). The installer prompts for an
   optional model to pin after the key, or accepts
   `--openrouter-model <model-id>`.
2. **Local LLM only** — no credential at all; point the tools at any
   OpenAI-compatible endpoint you run yourself (e.g. llama.cpp, LM Studio,
   Ollama's OpenAI-compat API). Defaults to `http://localhost:8080/v1`.
3. **Skip for now** — installs the MCP server with no provider configured;
   finish later with `token-optimizer config`.

Remote requests are always redacted before leaving your machine, and results
may carry `redactionSummary`/`providerWarnings` metadata (never secret
values). If your provider is unavailable or returns something invalid, exit
codes remain authoritative and the tool reports a conservative "uncertain"
result rather than inventing a verdict.

The shared gateway was retired in 3.0.0. Re-running the installer migrates an
older gateway BYOK key to direct OpenRouter automatically; a gateway token alone
cannot be migrated, so the installer warns and asks you to choose OpenRouter or
a local LLM with `token-optimizer config`. See the
[main README](../../README.md#security) and
[threat model](../../docs/security/threat-model.md) for the full security
design.

With no `--clients` option, the installer targets detected clients. Use
`--clients all` to force every supported client.

## What gets installed, per client

- **Claude Code:** keeps one current marketplace plugin (or, if the `claude`
  CLI isn't available, a `~/.claude/skills/token-optimizer/` fallback), writes
  `~/.claude/settings.json` and `~/.claude/CLAUDE.md`.
- **Codex:** uses a direct bundled-server registration in
  `~/.codex/config.toml` and copies
  the skill into `~/.codex/skills/token-optimizer/`.
- **Antigravity:** uses one global direct MCP registration, copies the current
  server assets, and writes `~/.gemini/GEMINI.md`.
- **OpenCode:** copies the server and skill into `~/.config/opencode/` and
  writes `~/.config/opencode/opencode.jsonc` / `AGENTS.md`.
- **Cursor:** copies the server into `~/.cursor/token-optimizer-server` and
  writes `~/.cursor/mcp.json`. Cursor has no global default-on rule by file
  path — use `--cursor-project /path/to/project` to copy the project rule, or
  add a User Rule in Cursor Settings.

On macOS, provider settings are also mirrored into your GUI-session
environment (so Dock/Finder/Spotlight-launched clients see them too) and
persisted across reboots via a LaunchAgent. Pass `--skip-launchctl` to skip
this.

`--skip-client-commands` suppresses external Claude/Codex client CLI calls but
does not skip the installer-owned launcher bootstrap and dependency validation.

Credential-bearing providers default to your OS's native credential store
(Keychain / Windows Credential Manager / Secret Service). Use
`--credential-store env` to reference an already-exported environment
variable instead, or `--credential-store config` to opt into plaintext
storage in the config file. `local` and `skip` need no credential store.

Examples:

```bash
npx @softawarest/token-optimizer-installer --clients opencode,cursor
npx @softawarest/token-optimizer-installer --clients all --cursor-project /path/to/project
npx @softawarest/token-optimizer-installer --local
npx @softawarest/token-optimizer-installer --local --local-url http://localhost:11434/v1 --local-model llama3
npx @softawarest/token-optimizer-installer --openrouter-key sk-or-...
npx @softawarest/token-optimizer-installer --openrouter-key sk-or-... --openrouter-model provider/model
npx @softawarest/token-optimizer-installer --provider skip
npx @softawarest/token-optimizer-installer config --openrouter-key sk-or-...
npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode
```

## Inspect, repair, and remove safely

```bash
npx @softawarest/token-optimizer-installer install --local --dry-run
npx @softawarest/token-optimizer-installer status
npx @softawarest/token-optimizer-installer doctor --strict
npx @softawarest/token-optimizer-installer repair --dry-run
npx @softawarest/token-optimizer-installer uninstall --dry-run
```

Every mutating command supports `--dry-run` to preview exactly what would
change before anything happens; add `--json` for machine-readable output.
Interactive terminals show phase progress by default. Use `--verbose` for
every operation or `--quiet` for warnings and the final result. JSON mode
writes one final document to stdout; `--verbose --json` sends sanitized NDJSON
progress to stderr.
`status` is read-only and makes no network call. `doctor` additionally
verifies your provider is reachable and exits non-zero on problems (`2` for
warnings with `--strict`). `repair` fixes exactly what `doctor` flagged.
`uninstall` removes only what this installer owns, including generated runtime
caches, recognized stale marketplace data, and managed macOS GUI-session
provider values. It preserves unrelated client settings and files you've
edited yourself, and rolls back cleanly if it can't finish. Install and repair
use the same ownership rules: unrecognized or modified conflicts are retained
and reported instead of being overwritten or deleted.

Raw command logs are managed separately with
`token-optimizer logs status|prune|purge --workspace <absolute-path>`.

## Upgrading from v1

```bash
npx @softawarest/token-optimizer-installer install --migrate --dry-run --json
npx @softawarest/token-optimizer-installer install --migrate
```

Preview first, then re-run without the preview flags to apply. Migration
detects your existing v1 setup, preserves your current provider routing,
backs up your old configuration, and only removes legacy plaintext
credentials after confirming the new setup actually works. A failed migration
rolls back everything automatically.

## Windows support

The installer is fully supported on Windows — all MCP servers launch via
`node server/start.js` (`bash` is never required). Requirements: `node` and
`npm` on `PATH`.

## Verifying a publish

```bash
npm view @softawarest/token-optimizer-installer name version dist-tags --json
npx @softawarest/token-optimizer-installer --help
```
