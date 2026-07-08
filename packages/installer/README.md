# Token Optimizer Installer

Optional one-command installer for Token Optimizer.

```bash
npx @softawarest/token-optimizer-installer
```

The installer copies packaged MCP server/plugin assets into stable user-owned
locations, prompts for the gateway access token, writes supported client MCP
config, and applies default-on global instructions where the client exposes a
writable file.

With no `--clients` option, the installer targets detected clients. Use
`--clients all` to force every supported client.

Default `install` behavior:

- prompts for the gateway access token
- installs marketplace/plugin assets for Claude Code and Codex
- copies bundled plugin/server/skill assets for Antigravity, OpenCode, and Cursor
- writes `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` into supported client config
- writes default-on instruction files for Claude Code, Codex, Antigravity, and OpenCode

Client-specific behavior:

- Claude Code:
  adds the packaged marketplace, installs `token-optimizer@token-optimizer-marketplace`, writes `~/.claude/settings.json`, writes `~/.claude/CLAUDE.md`.
- Codex:
  adds the packaged marketplace, installs `token-optimizer` from `Softaware-marketplace`, writes the macOS GUI launch environment, writes `~/.codex/AGENTS.md`.
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
npx @softawarest/token-optimizer-installer config --token <token>
npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode
```

Flow-specific commands:

- `npx @softawarest/token-optimizer-installer`:
  full install, gateway config, and defaults where supported.
- `npx @softawarest/token-optimizer-installer --no-defaults`:
  full install and gateway config, but skip default-on instructions.
- `npx @softawarest/token-optimizer-installer config --token <token>`:
  write only gateway config.
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
