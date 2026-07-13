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
locations, prompts for how to configure the LLM provider, writes client MCP
config, and turns on default-on usage where the client supports it.
**Restart the affected client after installation.**

Re-running the installer is always safe — it refreshes Token Optimizer to the
current version and reapplies your provider configuration.

## Choosing a provider

**A gateway/proxy token is not required** to use this tool. With no provider
flags, the installer prompts for one of three providers, plus a skip option:

| Mode | Token needed? | Who pays for inference? | Limit |
| --- | --- | --- | --- |
| `gateway` | **Yes** — request + operator approval | The gateway operator | 20 calls/day by default (operator-adjustable) |
| `byok` | **No, none at all** | You, via your own OpenRouter account | Unlimited |
| `local` | **No, none at all** | Nobody — your own hardware | Unlimited |

1. **Gateway access token** — shared infrastructure, requires an approved token.
   Request one at [https://llm-proxy.lnf.gr/](https://llm-proxy.lnf.gr/).
2. **Your own OpenRouter key (`byok`)** — get a key from
   [openrouter.ai](https://openrouter.ai), no request or approval needed.
   Unlimited usage, billed to your own account. The installer prompts for an
   optional model to pin after the key, or accepts `--byok-model <model-id>`.
3. **Local LLM only** — no token at all; point the tools at any
   OpenAI-compatible endpoint you run yourself (e.g. llama.cpp, LM Studio,
   Ollama's OpenAI-compat API). Defaults to `http://localhost:8080/v1`.
4. **Skip for now** — installs the MCP server with no provider configured;
   finish later with `token-optimizer config`.

Remote requests are always redacted before leaving your machine, and results
may carry `redactionSummary`/`providerWarnings` metadata (never secret
values). If your provider is unavailable or returns something invalid, exit
codes remain authoritative and the tool reports a conservative "uncertain"
result rather than inventing a verdict.

If you migrated from an older setup, your OpenRouter key may still route through the gateway (`gateway-byok`) — that routing is preserved as-is; switch to a direct key (`byok`) if you'd rather it never cross the gateway. See the
[main README](../../README.md#security) and
[threat model](../../docs/security/threat-model.md) for the full security
design.

With no `--clients` option, the installer targets detected clients. Use
`--clients all` to force every supported client.

## What gets installed, per client

- **Claude Code:** adds the packaged marketplace plugin (or, if the `claude`
  CLI isn't available, a `~/.claude/skills/token-optimizer/` fallback), writes
  `~/.claude/settings.json` and `~/.claude/CLAUDE.md`.
- **Codex:** registers the bundled server in `~/.codex/config.toml` and copies
  the skill into `~/.codex/skills/token-optimizer/`.
- **Antigravity:** copies the plugin into
  `~/.gemini/config/plugins/token-optimizer` and writes `~/.gemini/GEMINI.md`.
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
npx @softawarest/token-optimizer-installer --byok-key sk-or-...
npx @softawarest/token-optimizer-installer --byok-key sk-or-... --byok-model provider/model
npx @softawarest/token-optimizer-installer --provider skip
npx @softawarest/token-optimizer-installer config --token <token>
npx @softawarest/token-optimizer-installer config --byok-key sk-or-...
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
`status` is read-only and makes no network call. `doctor` additionally
verifies your provider is reachable and exits non-zero on problems (`2` for
warnings with `--strict`). `repair` fixes exactly what `doctor` flagged.
`uninstall` removes only what this installer owns, preserves any files you've
edited yourself, and rolls back cleanly if it can't finish.

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
