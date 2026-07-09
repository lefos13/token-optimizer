# Codex Installer Gateway Configuration Design

## Goal

Ensure a full installer run with a gateway token makes that token available to
the Token Optimizer MCP server that Codex actually starts.

## Approach

The Codex install flow will always register the bundled Token Optimizer server
directly in `~/.codex/config.toml`, using the cross-platform `node
server/start.js` launcher. The generated `.env` subtable will contain only the
selected provider's managed values. Plugin and marketplace assets remain
installed so Codex can discover the Token Optimizer skill.

## Behavior

- A gateway install writes `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` to the
  direct MCP server environment.
- A BYOK install writes `LLM_GATEWAY_URL` and `OPENROUTER_BYOK_KEY`.
- Local and skipped modes remove gateway credentials from that environment.
- Re-running the installer replaces legacy Bash launcher settings with the
  Node launcher and refreshes the managed environment values.
- Existing unrelated `config.toml` content remains untouched.

## Validation

Installer tests will assert that a Codex install writes the Node launcher and
the expected provider fields even when plugin CLI registration reports success.
The package build will regenerate installer assets, then the packed tarball
will be inspected for the updated installer code and Codex launcher.
