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

Examples:

```bash
npx @softawarest/token-optimizer-installer --clients opencode,cursor
npx @softawarest/token-optimizer-installer --clients all --cursor-project /path/to/project
npx @softawarest/token-optimizer-installer config --token <token>
npx @softawarest/token-optimizer-installer defaults --clients claude,codex,opencode
```

Cursor global MCP config can be written automatically. Cursor default-on rules
are project-scoped unless you add an equivalent global User Rule in Cursor
Settings.
