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

The installer copies packaged MCP server/plugin assets into stable user-owned
locations, prompts for how to configure the LLM provider, writes supported
client MCP config, and applies default-on global instructions where the client
exposes a writable file.

**A gateway/proxy token is not required** to use this tool. With no provider
flags, the installer prompts for one of three providers, plus a skip option:

| Mode | Token needed? | Who pays for inference? | Limit |
| --- | --- | --- | --- |
| `gateway` | **Yes** — request + operator approval | The gateway operator | 20 calls/day by default (operator-adjustable) |
| `byok` | **No, none at all** | You, via your own OpenRouter account | Unlimited |
| `local` | **No, none at all** | Nobody — your own hardware | Unlimited |

1. **Gateway access token** — shared infrastructure, requires an approved token.
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
  - `byok` → `LLM_GATEWAY_URL`, `OPENROUTER_BYOK_KEY` (no `LLM_GATEWAY_TOKEN` is written)
  - `local` → `LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`
- writes default-on instruction files for Claude Code, Codex, Antigravity, and OpenCode

Client-specific behavior:

- Claude Code:
  adds the packaged marketplace, installs `token-optimizer@token-optimizer-marketplace`, writes `~/.claude/settings.json`, writes `~/.claude/CLAUDE.md`.
  If the `claude` CLI is unavailable (desktop-app installs, common on Windows), the plugin is instead copied into `~/.claude/skills/token-optimizer/`, which Claude Code loads as a skills-directory plugin (`token-optimizer@skills-dir`) on the next session.
- Codex:
  adds the packaged marketplace and installs `token-optimizer` from `Softaware-marketplace` for skill discovery. It always registers the bundled Node server as `[mcp_servers.token_optimizer]` in `~/.codex/config.toml`, carrying the selected provider environment into the MCP process, and copies the skill into `~/.codex/skills/token-optimizer/`.
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
npx @softawarest/token-optimizer-installer --provider skip
npx @softawarest/token-optimizer-installer config --token <token>
npx @softawarest/token-optimizer-installer config --byok-key sk-or-...
npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode
```

Flow-specific commands:

- `npx @softawarest/token-optimizer-installer`:
  full install, prompts for a provider, and writes defaults where supported.
- `npx @softawarest/token-optimizer-installer --local`:
  full install with a local LLM only; no token, no gateway config written.
- `npx @softawarest/token-optimizer-installer --byok-key sk-or-...`:
  full install with your own OpenRouter key; no proxy token is asked for or written.
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
