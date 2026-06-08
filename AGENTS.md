# Project Instructions

This repository contains the `local-tester-mcp` server used by the `local-test-verdict` skill. It runs validation commands in a target workspace, stores full logs locally, and asks a local OpenAI-compatible LLM endpoint for compact verdicts, failure triage, changed-file review, and regression checks.

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

Three generators package the same `local-test-verdict` skill for different clients. `npm run build:plugin` runs all of them; each also has a dedicated script.

- `scripts/generate-plugin-antigravity.js` (`npm run build:plugin:antigravity`) → `plugin/antigravity/`. Antigravity layout: root `plugin.json`, `mcp_config.json` (registers the `local_tester` server, mirroring the global `~/.gemini/config/mcp_config.json` `mcpServers` shape), a bundled compiled server under `plugin/antigravity/server/` launched via a self-locating `start.sh`, and the skill under `plugin/antigravity/skills/local-llm-subagent/`. This output is gitignored — Antigravity loads plugins from a local folder rather than a git-based marketplace, so users copy/symlink the generated folder into `~/.gemini/config/plugins/<name>/` (or a workspace's `.agents/plugins/<name>/`) per `plugin/antigravity/README.md`.
- `scripts/generate-plugin-claude.js` (`npm run build:plugin:claude`) → `plugin/claude/` plus a repo-root `.claude-plugin/marketplace.json`. Claude Code layout: `plugin/claude/.claude-plugin/plugin.json`, `plugin/claude/.mcp.json`, a bundled compiled server under `plugin/claude/server/`, and the skill under `plugin/claude/skills/local-llm-subagent/`. The marketplace catalog is written at the **repo root** (not inside the plugin) so `claude plugin marketplace add <repo>` finds it; it lists the plugin via the relative source `./plugin/claude`. Both the repo-root catalog and `plugin/claude/` are committed (un-ignored in `.gitignore`) so the git-based marketplace install can copy them.
- `scripts/generate-plugin-codex.js` (`npm run build:plugin:codex`) → `plugin/codex/` plus a repo-root `.agents/plugins/marketplace.json`. Codex layout: `plugin/codex/.codex-plugin/plugin.json`, `plugin/codex/.mcp.json`, a bundled compiled server under `plugin/codex/server/`, and the skill under `plugin/codex/skills/local-llm-subagent/`. The marketplace catalog is written at the **repo root** so Codex can discover it as a repo marketplace; it lists the plugin via the relative source `./plugin/codex`. Both the repo-root catalog and `plugin/codex/` are committed so marketplace installs can copy them.

Notes for the Claude Code generator:

- It copies the compiled server from `dist/` into `plugin/claude/server/`, so run `npm run build` before `npm run build:plugin:claude`.
- The server is launched via `${CLAUDE_PLUGIN_ROOT}/server/start.sh`; the launcher installs the runtime dependency into `${CLAUDE_PLUGIN_DATA}` on first run. Do not hardcode absolute repo paths in `.mcp.json`.
- `node_modules` is not committed. The committed `plugin/claude/server/` carries only the compiled JS plus a minimal `package.json`.
- Because `plugin/claude/` is committed, regenerate and commit it whenever server behavior or the skill changes.
- **Bump `VERSION` in `scripts/generate-plugin-claude.js` for every change that touches `plugin/claude/` output — including changes that only edit `skill/skill-example.md`.** Claude Code only pulls plugin updates when the manifest `version` changes (otherwise it relies on the git commit SHA the plugin was first installed from); a static version silently pins installed copies to stale content and the user's "Update" action becomes a no-op. Treat even a wording-only change to the skill as "meaningful" for this purpose, since it changes what gets shipped in `plugin/claude/skills/local-llm-subagent/SKILL.md`. After bumping, run `npm run build:plugin:claude` (or `npm run build:plugin`) and commit the regenerated `plugin/claude/` output together with the source change.

Notes for the Codex generator:

- It copies the compiled server from `dist/` into `plugin/codex/server/`, so run `npm run build` before `npm run build:plugin:codex`.
- The server is launched via `./server/start.sh` from the plugin root; the launcher self-locates and installs the runtime dependency into `${PLUGIN_DATA}` when Codex provides it, or into the plugin-local `.data/` fallback. Do not rely on argv-level environment variable expansion in `.mcp.json`.
- `node_modules` is not committed. The committed `plugin/codex/server/` carries only the compiled JS plus a minimal `package.json`.
- Because `plugin/codex/` is committed, regenerate and commit it whenever server behavior or the skill changes.
- **Bump `VERSION` in `scripts/generate-plugin-codex.js` for every change that touches `plugin/codex/` output — including changes that only edit `skill/skill-example.md`.** Codex installs plugins from cached marketplace copies and shows the manifest version, so a static version makes updates hard to verify and can leave users on stale cached content. After bumping, run `npm run build:plugin:codex` (or `npm run build:plugin`) and commit the regenerated `plugin/codex/` output together with the source change.

Notes for the Antigravity generator:

- It copies the compiled server from `dist/` into `plugin/antigravity/server/`, so run `npm run build` before `npm run build:plugin:antigravity`.
- The server is launched via `./server/start.sh` (resolved relative to the staged plugin directory). Antigravity does not document a `${CLAUDE_PLUGIN_ROOT}`/`${PLUGIN_ROOT}`-style "plugin root" variable for `mcp_config.json`, so the launcher self-locates with `$(dirname "${BASH_SOURCE[0]}")` and persists installed runtime deps in a `.data/` directory beside itself. Do not hardcode absolute repo or home-directory paths in `mcp_config.json` or `start.sh`.
- `node_modules` is not generated into the plugin. The generated `plugin/antigravity/server/` carries only the compiled JS plus a minimal `package.json`; `start.sh` installs the single runtime dependency on first run.
- Because `plugin/antigravity/` is gitignored (Antigravity installs from a local folder, not a git marketplace), nothing needs to be committed for this flow — just regenerate it locally with `npm run build:plugin:antigravity` (or `npm run build:plugin`) and re-copy/re-symlink the folder into Antigravity's plugin directory to pick up changes.
- **Bump `VERSION` in `scripts/generate-plugin-antigravity.js` whenever server functionality or skill instructions change — including skill-only wording edits**, since `skill/skill-example.md` is copied verbatim into `plugin/antigravity/skills/local-llm-subagent/SKILL.md`. Antigravity's update-pinning behavior is not documented the way Claude Code's is, but keeping the manifest version accurate still matters for anyone diffing or re-staging the generated folder. After bumping, run `npm run build:plugin:antigravity` (or `npm run build:plugin`).

## Repository Shape

- `src/index.ts`: MCP server setup, tool registration, request handlers, and output shaping.
- `src/runner.ts`: command execution, timeout handling, raw log persistence, and log trimming.
- `src/detector.ts`: automatic validation command detection for supported project types.
- `src/llm.ts`: local LLM prompts, OpenAI-compatible API calls, JSON extraction, and fallback behavior.
- `src/registry.ts`: run registry persistence and log-path resolution backing `query_log` and `grep_log`.
- `src/analytics.ts`: builds and persists compact, privacy-preserving per-tool-call context-savings analytics into each target workspace.
- `src/analytics-ui.ts`: standalone multi-workspace analytics dashboard server (`npm run analytics:ui`); reads analytics files directly and never calls back into the MCP server.
- `src/types.ts`: shared TypeScript contracts for tool arguments and verdict payloads.
- `README.md`: user-facing setup, tool descriptions, configuration, and troubleshooting instructions. This must stay aligned with server behavior.
- `skill/skill-example.md`: skill-facing usage instructions. This must stay aligned with server behavior.

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

## Local LLM Behavior

- The server uses `LOCAL_LLM_API_URL` and `LOCAL_LLM_MODEL`, defaulting to `http://localhost:8080/v1` and `local-model`.
- Keep prompts strict about JSON-only responses.
- Keep fallback behavior conservative. If the model is offline, returns invalid JSON, or cannot classify the result, return `uncertain` or an advisory review issue instead of pretending confidence.
- Do not add remote hosted LLM dependencies or external network calls unless the user explicitly requests that architecture change.

## Command Execution and Logs

- Commands run with `child_process.exec` in the target workspace.
- Full logs are written under `.codex-local-test-runs/` in the target workspace.
- Log trimming should preserve enough beginning and ending context for LLM triage.
- Timeouts, buffer limits, and shell execution behavior are part of the server safety model. Change them deliberately and document the impact.
- Be careful with command detection. Auto-detected commands should be deterministic validation commands such as build, typecheck, lint, and tests.

## Analytics

- Every successful tool path records compact, privacy-preserving context-savings analytics via `src/analytics.ts` (token counts, savings percentage, provider/model/latency metadata, commands and exit codes — never raw logs, prompts, file contents, or full model responses).
- Analytics are written to `<workspacePath>/.codex-local-test-runs/analytics.json` and `analytics-summary.json`, **inside the target workspace**, alongside its raw run logs, registry, and baseline. Do not write analytics relative to the MCP server's own project directory: that breaks portability (especially when the server runs from inside a bundled, ephemeral plugin install dir) and scatters a user's analytics away from the project they describe.
- `src/analytics-ui.ts` (`npm run analytics:ui`) is a standalone dashboard, independent of the MCP server process, that can register multiple workspaces (persisted at `~/.local-tester-analytics/workspaces.json`), show an aggregated cross-workspace view, and paginate the event feed. It only reads the analytics files written by `recordAnalytics`.
- Analytics writes are best-effort: a failed write must never fail the underlying tool call.
- If you change the analytics record shape, the storage location, or the dashboard's behavior, update `README.md` (`Context Analytics` / `Multi-Workspace Analytics Dashboard` sections) and `skill/skill-example.md` in the same change, then run `npm run build:plugin`.

## Code Style

- Use TypeScript and the project’s existing module style.
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
