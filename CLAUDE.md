# Project Instructions

This repository contains the `token-optimizer-mcp` server used by the `token-optimizer` skill. It runs validation commands in a target workspace, stores full logs locally, and asks a local OpenAI-compatible LLM endpoint for compact verdicts, failure triage, changed-file review, and regression checks.

## Required Checks

- Always check this file before making changes. If a nested `AGENTS.md` or `agents.md` exists, follow the most local applicable file as well.
- Keep changes focused on the MCP server, its tool contracts, or the skill documentation that describes those contracts.
- Run `npm run build` after TypeScript changes.
- Do not run `npm install` in the sandbox. Any dependency installation must be requested with network privileges.
- If you change server behavior, tool names, input schemas, output shapes, environment variables, validation logic, command detection, log paths, setup requirements, or guardrails, update `README.md` and `skill/skill-example.md` in the same change.
- If you change server functionality or skill instructions, bump the versions for every generated plugin package before regenerating assets. Update the version sources used by the Antigravity, Claude, and Codex generators, then run `npm run build:plugin` so the committed plugin outputs carry the new versions.
- Run `npm run build:plugin` after TypeScript or skill documentation changes to regenerate the plugin assets. Do not modify files under `plugin/` manually as they are generated.
- Do not modify generated test-run logs or baseline files unless the task explicitly requires it.

## Plugin Generators

Five generators package the same `token-optimizer` skill for different clients. `npm run build:plugin` runs all of them; each also has a dedicated script.

- `scripts/generate-plugin-antigravity.js` (`npm run build:plugin:antigravity`) → `plugin/antigravity/`. Gitignored — Antigravity loads plugins from a local folder; copy/symlink the generated folder into Antigravity's plugin directory.
- `scripts/generate-plugin-claude.js` (`npm run build:plugin:claude`) → `plugin/claude/` plus repo-root `.claude-plugin/marketplace.json`. Both committed for git-based marketplace installs.
- `scripts/generate-plugin-codex.js` (`npm run build:plugin:codex`) → `plugin/codex/` plus repo-root `.agents/plugins/marketplace.json`. Both committed for marketplace installs.
- `scripts/generate-plugin-opencode.js` (`npm run build:plugin:opencode`) → `plugin/opencode/`. Gitignored — opencode has no plugin/marketplace mechanism; copy the server + skill and merge the MCP snippet by hand (see the generated README).
- `scripts/generate-plugin-cursor.js` (`npm run build:plugin:cursor`) → `plugin/cursor/`. Gitignored — Cursor has no plugin/marketplace mechanism; copy the server, merge the MCP snippet, and copy the `.mdc` rule per project by hand (see the generated README).

**All generators:**

- Run `npm run build` first — each generator copies `dist/` into its `plugin/<client>/server/`.
- Launchers self-locate at runtime: `server/start.js` (cross-platform Node launcher, referenced from all MCP configs) and `server/start.sh` (POSIX). Do not hardcode absolute paths in config files.
- `node_modules` is not committed. The bundled `server/` carries only compiled JS plus a minimal `package.json`; the launcher installs the single runtime dependency on first run.
- **Bump `VERSION` in the generator script for every change that touches that plugin's output — including wording-only edits to `skill/skill-example.md`.** Run `npm run build:plugin` and commit the regenerated output (Claude and Codex only; Antigravity, opencode, and Cursor are gitignored).

**Per-generator differences:**

- **Antigravity**: Launcher self-locates with `$(dirname "${BASH_SOURCE[0]}")` and persists deps in `.data/`. Output is gitignored — regenerate and re-copy/re-symlink to pick up changes.
- **Claude Code**: Launched via `node ${CLAUDE_PLUGIN_ROOT}/server/start.js`; deps persist in `${CLAUDE_PLUGIN_DATA}`. When the `claude` CLI is unavailable (desktop-app installs, common on Windows), the npm installer falls back to copying the plugin into `~/.claude/skills/token-optimizer/`, which Claude Code loads as a skills-directory plugin. Output is committed. Claude Code pins to the git SHA from first install, so a static `VERSION` makes "Update" a silent no-op.
- **Codex**: Launched via `node server/start.js` anchored at the plugin root (`cwd: "."`); deps persist in `${PLUGIN_DATA}` or `.data/` fallback. When the `codex` CLI is unavailable, the npm installer falls back to writing `[mcp_servers.token_optimizer]` into `~/.codex/config.toml` and copying the skill into `~/.codex/skills/`. Output is committed. Avoid argv-level environment variable expansion in `.mcp.json`.

## Repository Shape

- `src/index.ts`: MCP server setup, tool registration, request handlers, and output shaping.
- `src/runner.ts`: command execution, timeout handling, raw log persistence, and log trimming.
- `src/detector.ts`: automatic validation command detection for supported project types.
- `src/llm.ts`: local LLM prompts, OpenAI-compatible API calls, JSON extraction, and fallback behavior.
- `src/registry.ts`: run registry persistence and log-path resolution backing `query_log` and `grep_log`.
- `src/analytics.ts`: builds and persists compact, privacy-preserving per-tool-call context-savings analytics into each target workspace.
- `src/analytics-ui.ts`: standalone multi-workspace analytics dashboard server (`npm run analytics:ui`).
- `src/types.ts`: shared TypeScript contracts for tool arguments and verdict payloads.
- `README.md`: user-facing setup, tool descriptions, configuration, and troubleshooting instructions.
- `skill/skill-example.md`: skill-facing usage instructions.
- `scripts/manage-gateway-config.js`: CLI to configure the LLM gateway token; `enable-defaults` / `disable-defaults` write or remove a standing default-on usage directive in Claude/Codex/Antigravity's global instructions files.

## MCP Tool Contract

Preserve the current tools unless the user explicitly asks for a contract change:

- `run_test_verdict`: runs explicit or auto-detected commands and returns a JSON verdict.
- `run_failure_triage`: analyzes an existing log file.
- `run_changed_files_review`: reviews small changed files before expensive validation.
- `run_regression_check`: compares current auto-detected command results with `.codex-local-test-runs/baseline.json` and then writes the current run as the new baseline.

When changing a tool:

- Update the `ListToolsRequestSchema` entry and the handler together.
- Keep returned JSON stable and easy for agents to parse.
- Treat non-zero command exit codes as authoritative failures. The local LLM may summarize or classify, but it must not override command truth.
- Prefer adding optional fields over changing or removing existing fields.
- Resolve user-provided workspace-relative paths under `workspacePath` and avoid reading outside the intended workspace.
- Keep raw logs out of conversational output when a compact verdict or triage summary is actionable.

## Token Optimizer Behavior

- The server prefers the centralized gateway (`LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN`) and falls back to a local OpenAI-compatible model (`LOCAL_LLM_API_URL` / `LOCAL_LLM_MODEL`, defaulting to `http://localhost:8080/v1` and `local-model`) when the gateway is unset or unreachable. Models are pinned server-side on the gateway per task type; clients do not select a model.
- Keep prompts strict about JSON-only responses.
- Keep fallback behavior conservative. If neither provider is reachable, returns invalid JSON, or cannot classify the result, return `uncertain` or an advisory review issue instead of pretending confidence.
- The gateway is a remote hop the maintainer controls and is the approved primary LLM path; do not add ad-hoc third-party LLM dependencies or other external network calls unless the user explicitly requests that architecture change.

## Command Execution and Logs

- Commands run with `child_process.exec` in the target workspace.
- Full logs are written under `.codex-local-test-runs/` in the target workspace.
- Log trimming should preserve enough beginning and ending context for LLM triage.
- Timeouts, buffer limits, and shell execution behavior are part of the server safety model. Change them deliberately and document the impact.
- Be careful with command detection. Auto-detected commands should be deterministic validation commands such as build, typecheck, lint, and tests.

## Analytics

- Every successful tool path records compact, privacy-preserving analytics via `src/analytics.ts` into `<workspacePath>/.codex-local-test-runs/analytics.json` and `analytics-summary.json`, **inside the target workspace** (never relative to the MCP server's own directory — keeps them portable across plugin install locations). Records include: tool name, timestamp, commands and exit codes, token counts, savings percentage, provider/model/latency, confidence, and fallback reason. Raw logs, prompts, file contents, and full model responses are never stored.
- `src/analytics-ui.ts` (`npm run analytics:ui`) is a standalone multi-workspace dashboard that reads these files; it never calls back into the MCP server. Registered workspaces persist at `~/.token-optimizer-analytics/workspaces.json`.
- Analytics writes are best-effort: a failed write must never fail the underlying tool call.
- If you change the analytics record shape, storage location, or dashboard behavior, update `README.md` and `skill/skill-example.md` in the same change, then run `npm run build:plugin`.

## Code Style

- Use TypeScript and the project's existing module style.
- Keep code small and explicit. This project is a tool server, so predictable contracts are more important than clever abstractions.
- Add multi-line block comments (`/* ... */`) at the top of large added or modified code sections when the logic is not immediately obvious. Keep those comments short and factual.
- Do not replace a needed block comment with several `//` comments.
- Prefer structured parsing and typed objects over ad hoc string handling when practical.
- Avoid broad refactors unless they directly reduce risk or are necessary for the requested change.

## Verification

For TypeScript or behavior changes:

1. Run `npm run build`.
2. If a tool behavior changed, exercise the relevant path with the narrowest practical local command or fixture.
3. Run `npm run build:plugin` and confirm `README.md`, `skill/skill-example.md`, and the generated plugin files under `plugin/` describe the new behavior.

For documentation-only changes:

1. Run `npm run build:plugin` if skill documentation was edited, and check that the instructions do not contradict `README.md`, `skill/skill-example.md`, or the generated plugin files.
2. No server build is required unless source TS code changed.

## Reporting Back

Summaries should include:

- What changed.
- Why the change was necessary.
- What verification was run, or why verification was not needed.
- Any remaining risk, especially around local LLM availability, command detection, or baseline mutation.
