# Local LLM subagent

Local LLM subagent is an MCP server for running local validation commands and turning long build, lint, test, and smoke-check logs into compact verdicts with help from a local LLM like Qwen2.5-Coder-7B-Instruct (GGUF on Llama.cpp). This tool has been tested with the Q4_K_M variation on a Macbook M4 Pro (24GB RAM).

It is designed for coding agents that need to verify changes without pasting raw logs into the conversation. The server runs commands in the target workspace, writes full logs to disk, sends trimmed context to a local OpenAI-compatible model endpoint, and returns structured JSON that an agent can act on.

## What This Server Offers

- Runs explicit validation commands, such as `npm test`, `npm run build`, `pytest`, `cargo test`, or any command supplied by the agent.
- Auto-detects common project validation commands for Node.js, Rust, Go, and Python projects.
- Stores full command logs under `.codex-local-test-runs/` in the target workspace.
- Trims long logs before sending them to the local model, preserving the beginning, the end, and small windows around failure markers in the middle so the real error is not dropped.
- Uses command exit codes as the source of truth for pass/fail classification.
- Uses task-specific local LLM presets to summarize failures, identify likely affected files, and suggest fixes.
- Reports local model availability, provider/model selection, latency, and fallback reasons on LLM-backed responses.
- Reviews changed files under 500 KB before expensive validation runs.
- Can compare current auto-detected validation behavior with a saved baseline.
- Digests the output of any arbitrary noisy command (installs, builds, migrations, large searches, git history) into a compact, intent-focused summary.
- Keeps every run addressable by a `runId` so stored logs can be queried (`query_log`) or searched (`grep_log`) later without re-reading the whole file.
- Acts as a recon subagent (`scout_codebase`): greps the workspace for seed terms deterministically, then has the local LLM rank the matches into a few ranked pointers so the main model knows where to read before exploring broadly.
- Stores private context-savings analytics under `.codex-local-test-runs/` so users can inspect local LLM token use, returned MCP response size, and estimated main-context savings without sending those analytics back to the main model.

## Exposed MCP Tools

### `check_local_llm_health`

Checks the configured local OpenAI-compatible endpoint with a tiny JSON-only request.

Returns provider/model metadata, redacted API base, availability, latency, and a compact error summary when unavailable. It does not expose prompts, raw responses, or secrets.

### `run_test_verdict`

Runs one explicit command or a set of auto-detected validation commands in a workspace.

Inputs:

- `workspacePath`: absolute path to the target workspace.
- `taskSummary`: short description of the change or validation goal.
- `changedFiles`: optional repo-relative changed files.
- `testCommand`: optional command override. When omitted, command detection is used.
- `maxOutputLines`: optional cap on how many log lines are sent to the local model. When set, the trimmed log keeps roughly one third of the budget from the start and the rest from the end, preserving trailing error traces.
- `timeoutMs`: optional per-command timeout in milliseconds. Defaults to `300000` (5 minutes).
- `parallel`: optional. Run detected commands concurrently instead of sequentially. Logs are still assembled in command order. Use only when the commands are independent.
- `autoTriage`: optional. When true, automatically query the log on fail/uncertain verdict and attach the triage answer.

Returns a JSON verdict with:

- `verdict`: `pass`, `fail`, or `uncertain`.
- `confidence`: local model confidence from `0.0` to `1.0`.
- `commandsRun`: commands executed by the server.
- `summary`: compact result explanation.
- `failures`: structured failure details and suggested fixes.
- `runId`: stable handle for the stored log (the log filename without extension).
- `rawLogPath`: path to the full log, relative to `workspacePath`.
- `needsRawLogs`: whether the local model needs more log context.
- `likelyRelevantToRecentChanges`: local model's estimate of whether a failure is connected to the reported `changedFiles`. Omitted when the model is unavailable.
- `triage`: optional. When `autoTriage` is true and the verdict is `fail` or `uncertain`, contains the query results of the failed/uncertain log query.

LLM-backed results may also include `llmAvailable`, `llmProvider`, `llmModel`, `llmLatencyMs`, `llmTaskType`, and `fallbackReason`. These fields are optional and additive.

### `run_failure_triage`

Reads an existing log file and asks the local model for compact root-cause analysis.

Use this after `run_test_verdict` returns `fail` or `uncertain` and the initial summary is not enough to fix the issue.

### `run_changed_files_review`

Reads changed files under 500 KB and asks the local model for an advisory code review.

This is useful before slow test suites. Treat findings as hints, not proof. The model sees file contents, not full project semantics.

Inputs:

- `workspacePath`: absolute path to the target workspace.
- `changedFiles`: repo-relative changed files.
- `useDiff`: optional. Review the git working-tree diff vs `HEAD` for each file instead of the whole file. Cheaper and more focused; falls back to whole-file content when a file has no diff or the workspace is not a git repository.

Returns:

- `hasIssues`: whether the review found any concerns.
- `issues`: structured findings with `file`, optional `line`, `severity`, `description`, and `suggestedFix`.
- `summary`: short overall summary of the review.
- `skipped`: files that could not be reviewed, each with a `reason` (`not found`, `not a file`, or `exceeds 500KB size limit`), so a partial review is never silent.
- `reviewAvailable`: `false` when the local model was unreachable or returned unparseable output. In that case `hasIssues` is `false` and `issues` is empty (the review did not run, rather than finding nothing), and `note` explains why.

### `run_regression_check`

Runs auto-detected commands, compares the current success state with `.codex-local-test-runs/baseline.json`, writes the current run as the new baseline, and reports whether a regression was detected.

Use this only when baseline mutation is acceptable.

### `run_command_digest`

Runs an arbitrary shell command (or an ordered sequence), stores the full log under `.codex-local-test-runs/`, and returns a compact local-model digest steered by your `intent`. Use it for any noisy command whose raw output would otherwise flood context: dependency installs, container builds, database migrations, large `grep`/`find`, `git log`, or code generation. This generalizes the test-verdict pattern to commands the auto-detection tools do not cover.

Inputs:

- `workspacePath`: absolute path to the target workspace.
- `command`: a single shell command string, or an array of commands run sequentially.
- `intent`: what you are trying to learn from the output. This steers the digest (for example, "did the install pull any deprecated packages?").
- `timeoutMs`: optional per-command timeout in milliseconds. Defaults to `300000` (5 minutes).
- `maxOutputLines`: optional cap on how many log lines are sent to the local model.

Returns:

- `exitCode`: effective exit code, reported verbatim. `0` only when every command exited `0`; otherwise the first non-zero code.
- `exitCodes`: per-command exit codes.
- `summary`: compact, intent-focused summary of the output.
- `keyFindings`: short bullet facts relevant to the intent.
- `digest`: a distilled slice of the relevant output.
- `runId`: stable handle for the stored log (the log filename without extension).
- `rawLogPath`: path to the full log, relative to `workspacePath`.
- `needsRawLogs`: whether the trimmed log lacked detail needed to satisfy the intent.

The digest only describes output. It never decides success or failure; the exit code remains authoritative.

### `query_log`

Asks a targeted natural-language question against a stored run log and returns a compact answer plus only the relevant excerpt. Use this instead of reading a full `rawLogPath` after a `fail` or `uncertain` verdict: the large log stays on disk while the model answers from it.

Inputs:

- `workspacePath`: absolute path to the target workspace (used to resolve `runId` and relative log paths).
- `runId`: stable run handle returned by `run_test_verdict`, `run_command_digest`, or `run_regression_check`. Provide this or `logPath`.
- `logPath`: absolute or workspace-relative path to a stored log. Provide this or `runId`.
- `question`: the specific question to answer from the log.
- `maxLines`: optional cap on how many log lines are sent to the local model. Defaults to `1200`.

Returns `answer`, `relevantExcerpt` (the supporting lines, line-number prefixed), `lineRange`, `rawLogPath`, and `available` (`false` when the local model was unreachable, so you can fall back to `grep_log` or a small raw slice).

### `grep_log`

Deterministic, no-LLM regex search over a stored run log. Returns matching line windows with surrounding context. Use it when you already know the token or symbol you want and need exact lines without spending a model call.

Inputs:

- `workspacePath`: absolute path to the target workspace.
- `runId` or `logPath`: which stored log to search.
- `pattern`: case-insensitive regular expression.
- `context`: lines of context before and after each match. Defaults to `3`.
- `maxMatches`: maximum match windows to return. Defaults to `20`.

Returns `matches` (each with `lineRange` and a line-numbered `excerpt`), `totalMatches`, and `rawLogPath`.

### `scout_codebase`

Recon subagent for the main model. Instead of scanning the whole tree yourself, hand off a navigation goal and let the local model point you at the few relevant code regions.

The server first greps the workspace for the seed terms deterministically (using `ripgrep` when available, falling back to a portable Node walk that skips heavy directories like `node_modules`, `.git`, `dist`), groups hits by file, and builds numbered context windows around the densest matches. The local model then ranks those candidates into pointers; it only orders and explains what the grep already found and is instructed never to invent paths or line numbers. If no pointer meets the confidence gate, `needsDeeperLook` is set.

Inputs:

- `workspacePath`: absolute path to the target workspace.
- `goal`: what you are trying to locate or understand (for example, "where is auth token refresh handled?").
- `seedTerms`: optional literal terms or symbols to grep for. When omitted, coarse terms are derived from the `goal` by dropping short and stop words. Supplying precise symbols greatly improves results.
- `roots`: optional workspace-relative directories to scope the search (for example, `["src"]`). Defaults to the whole workspace.
- `maxCandidates`: optional cap on how many matching files are considered. Defaults to `30`.
- `contextLines`: optional source lines kept around each grep hit. Defaults to `4`.

Returns:

- `searchedWith`: `ripgrep` or `node-walk`, so you know which backend ran.
- `seedTerms`: the terms actually used (useful when they were derived from the goal).
- `filesMatched`: total files with at least one hit, before the `maxCandidates` cap.
- `candidateFiles`: the grep-derived candidate files, in density order. This is deterministic and present even when the local model is offline.
- `pointers`: the model-ranked regions, each with `file`, `lineRange`, `why`, and `confidence`. Treat them as hints to verify, not authority.
- `suggestedNextSearches`: additional grep terms to try if the goal is not yet covered.
- `summary`: a one or two sentence orientation.
- `needsDeeperLook`: whether the candidates look insufficient for the goal (the orientation analogue of `needsRawLogs`).
- `scoutAvailable`: `false` when the local model was unreachable or returned unparseable output. In that case `pointers` is empty but `candidateFiles` still gives you the deterministic leads, and `note` explains why ranking did not run.

## Run Registry

Every run executed by the server is appended to `.codex-local-test-runs/index.json`, recording `runId`, `commands`, `exitCodes`, `timestamp`, `rawLogPath`, and `lineCount`. The `runId` is the log filename without its extension. `query_log` and `grep_log` use this index to resolve a `runId` back to its log, so an agent can interrogate any prior run without re-running it or reading the whole file. The index keeps the most recent 200 runs and is written best-effort: a failed index write never fails the underlying run. It is independent of the `run_regression_check` baseline.

## Context Analytics

Every successful tool path records private analytics under the MCP server project:

```text
<local-tester-mcp>/.codex-local-test-runs/analytics.json
<local-tester-mcp>/.codex-local-test-runs/analytics-summary.json
```

These files are for later user inspection and are not returned in MCP tool responses. Records keep the latest 200 tool calls and include compact metadata only: tool name, timestamp, target workspace path, `runId` or relative log path when available, commands and exit codes when applicable, token counts, estimated main-context tokens saved, savings percentage, local provider/model, latency, availability, confidence, fallback reason, whether raw output was avoided, and whether token usage came from the local LLM API or estimator fallback.

The server uses OpenAI-compatible `usage.prompt_tokens`, `usage.completion_tokens`, and `usage.total_tokens` when the local endpoint provides them. If usage is missing, it falls back to the same rough `~4 chars/token` estimator used for raw-log and MCP-response sizing. Analytics writes are best-effort and never fail the underlying tool call. Raw logs, prompts, file contents, and full model responses are not stored in analytics records.

To view the analytics in a browser, run:

```sh
npm run analytics:ui
```

By default, the dashboard reads analytics from the MCP server project and serves `http://127.0.0.1:8787`. To use a different port:

```sh
npm run analytics:ui -- --port 8787
```

The command runs the compiled server from `dist/analytics-ui.js`. The dashboard separates MCP tool-call count from shell-command count and lists every command in an event with its exit code, so a single `run_test_verdict` or `run_command_digest` call can show multiple underlying commands. For debugging or migration, `--store /absolute/path` can point the UI at another analytics store, but normal MCP tool calls always write analytics to the MCP project.

## Requirements

- Node.js 20 or newer.
- npm.
- An MCP-compatible client that can launch stdio servers.
- A local OpenAI-compatible chat completions endpoint.
- Validation tools required by target workspaces, such as npm scripts, pytest, Cargo, or Go tooling.

The local model endpoint must accept requests like:

```text
POST /v1/chat/completions
```

The response should follow the OpenAI chat completions shape with `choices[0].message.content`.

## Install and Build

Install dependencies:

```sh
npm install
```

Build the TypeScript server:

```sh
npm run build
```

Start the server manually:

```sh
npm start
```

For development, run the TypeScript compiler in watch mode:

```sh
npm run dev
```

## Local LLM Configuration

The server reads these environment variables:

- `LOCAL_LLM_API_URL`: base URL for the local OpenAI-compatible endpoint. Defaults to `http://localhost:8080/v1`.
- `LOCAL_LLM_MODEL`: model name sent in chat completion requests. Defaults to `local-model`.
- `LOCAL_LLM_VERDICT_MODEL`: optional model override for `run_test_verdict`.
- `LOCAL_LLM_TRIAGE_MODEL`: optional model override for `run_failure_triage`.
- `LOCAL_LLM_REVIEW_MODEL`: optional model override for `run_changed_files_review`.
- `LOCAL_LLM_DIGEST_MODEL`: optional model override for `run_command_digest`.
- `LOCAL_LLM_SCOUT_MODEL`: optional model override for `scout_codebase`.
- `LOCAL_LLM_QUERY_MODEL`: optional model override for `query_log` and inline `autoTriage`.

Example:

```sh
LOCAL_LLM_API_URL=http://localhost:8080/v1 \
LOCAL_LLM_MODEL=local-model \
npm start
```

If the local model is unavailable, returns invalid JSON, or cannot classify the result, the server reports an `uncertain` verdict or an advisory review issue instead of inventing confidence.

All routing remains local-only. Task-specific model variables select a local model for that task; they do not enable remote fallback or hosted LLM calls.

## MCP Client Setup

Build the server first, then configure your MCP client to launch `dist/index.js` with Node.

Example stdio configuration:

```json
{
  "mcpServers": {
    "local_tester": {
      "command": "node",
      "args": ["/absolute/path/to/local-tester-mcp/dist/index.js"],
      "env": {
        "LOCAL_LLM_API_URL": "http://localhost:8080/v1",
        "LOCAL_LLM_MODEL": "local-model"
      }
    }
  }
}
```

For Codex-style TOML configuration, the shape is typically:

```toml
[mcp_servers.local_tester]
command = "node"
args = ["/absolute/path/to/local-tester-mcp/dist/index.js"]

[mcp_servers.local_tester.env]
LOCAL_LLM_API_URL = "http://localhost:8080/v1"
LOCAL_LLM_MODEL = "local-model"
```

If your client supports tool allowlists, ensure these tools are enabled:

```text
run_test_verdict
run_failure_triage
run_changed_files_review
run_regression_check
run_command_digest
query_log
grep_log
scout_codebase
```

Restart or reload the MCP client after changing the server path, environment variables, or enabled tool list.

## Plugins

This repository can generate the `local-tester` plugin for **two different clients**, each with its own generator and output directory. Both ship the same skill content (from `skill/skill-example.md`), but package it differently — including a different skill folder/invocation name per client (see the table).

| Client      | npm script                     | Output             | Tracked in git | Packaging                                                                 |
| ----------- | ------------------------------ | ------------------ | -------------- | ------------------------------------------------------------------------ |
| Antigravity | `npm run build:plugin:antigravity` | `plugin/antigravity/` | No (gitignored) | Root `plugin.json` + `skills/`. MCP server configured separately by you. |
| Claude Code | `npm run build:plugin:claude`      | `plugin/claude/`      | Yes            | `.claude-plugin/` manifest, bundled portable MCP server, local marketplace. |

Run both at once with `npm run build:plugin`.

> Do not edit files under `plugin/` by hand; they are generated. The Antigravity output is gitignored, while the Claude Code output is committed so the git-based marketplace install can copy it.

### Antigravity

1. Generate the Antigravity plugin from the repository root:

   ```bash
   npm run build:plugin:antigravity
   ```

   This generates `plugin/antigravity/` (containing `plugin.json` and the `skills` files), which is ignored by git.

2. Locate the `.gemini/config/plugins` directory in your home directory:
   - **macOS/Linux**: `~/.gemini/config/plugins/`
   - **Windows**: `%USERPROFILE%\.gemini\config\plugins\`

3. Copy the generated contents into a folder named `local-tester` under that directory:

   ```bash
   # Create the target directory if it doesn't exist
   mkdir -p ~/.gemini/config/plugins/local-tester

   # Copy the generated plugin metadata and skills
   cp -r plugin/antigravity/* ~/.gemini/config/plugins/local-tester/
   ```

   The final directory structure on your system should look like:

   ```text
   ~/.gemini/config/plugins/local-tester/
   ├── plugin.json
   └── skills/
       └── local-test-verdict/
           └── SKILL.md
   ```

4. Configure the `local_tester` MCP server in your `~/.gemini/antigravity/mcp_config.json` file as described in [MCP Client Setup](#mcp-client-setup).

5. Restart your Antigravity client to load the new plugin and its skills.

### Claude Code

The Claude Code plugin is self-contained and portable: it bundles the compiled MCP server under `plugin/claude/server/` and launches it via `${CLAUDE_PLUGIN_ROOT}/server/start.sh`, so no absolute repo paths are baked in. On first run the launcher installs the single runtime dependency (`@modelcontextprotocol/sdk`) into the persistent `${CLAUDE_PLUGIN_DATA}` directory, then starts the server.

1. Build the server and generate the plugin:

   ```bash
   npm run build
   npm run build:plugin:claude
   ```

2. Install it via the bundled local marketplace:

   ```bash
   claude plugin marketplace add "$(pwd)/plugin/claude"
   claude plugin install local-tester@local-tester-marketplace
   ```

3. Restart Claude Code (or run `/reload-plugins`) so the MCP server and skill load.

The skill is invoked as `/local-tester:local-llm-subagent` and is also model-invoked automatically based on its description. The MCP tools are exposed as `mcp__local_tester__*`.

**Requirements on the target machine:** `node` and `npm` on `PATH`, plus network access the first time (to install the dependency). After that the server runs offline. Override the LLM endpoint with the same environment variables described in [MCP Client Setup](#mcp-client-setup) (`LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`, and the per-task `LOCAL_LLM_*_MODEL` overrides).

For local development you can skip the marketplace entirely and load the plugin directly:

```bash
claude --plugin-dir ./plugin/claude
```

## Typical Agent Workflow

1. Identify the target workspace as an absolute path.
2. Check the target workspace instructions, such as `AGENTS.md` or `agents.md`.
   - When the relevant code is in an unfamiliar area, call `scout_codebase` first to get ranked pointers to where to read, instead of scanning the whole tree.
3. Review changed files with `run_changed_files_review` when the files are small enough and a lightweight review is useful.
4. Run `run_test_verdict` with an explicit `testCommand` when the correct validation command is known.
5. Omit `testCommand` only when auto-detection is appropriate.
6. Use the returned JSON as the primary signal.
7. If the verdict is `fail` or `uncertain`, call `run_failure_triage`, `query_log`, or `grep_log` on the returned `runId`/log path before reading raw logs.
8. Report the command, verdict, summary, and residual risk without pasting raw logs unless necessary.

## Auto-Detected Commands

When `testCommand` is omitted, the server checks the target workspace:

- `package.json`: runs available `build`, `typecheck`, `lint`, and `test` scripts in that order. If no `test` script exists, it still attempts `npm test`.
- `Cargo.toml`: runs `cargo check` and `cargo test`.
- `go.mod`: runs `go build ./...` and `go test ./...`.
- Python test markers such as `pytest.ini`, `conftest.py`, `requirements.txt`, or `Pipfile`: runs `python manage.py test` for Django projects with `manage.py`, otherwise `pytest`.

If no known project type is detected, the server returns `uncertain` without running commands.

## Logs and Baselines

The server writes full command logs under:

```text
<workspacePath>/.codex-local-test-runs/
```

`run_test_verdict` returns `rawLogPath` relative to `workspacePath`. Every run is also indexed in `.codex-local-test-runs/index.json` (see Run Registry) so its log can be reached later by `runId`.

`run_regression_check` also reads and writes:

```text
<workspacePath>/.codex-local-test-runs/baseline.json
```

Because `run_regression_check` overwrites the baseline with the current run, avoid it when you need a read-only check or stable historical baselines.

## Development Notes

- Source files live in `src/`; compiled files are emitted to `dist/`.
- The server communicates over stdio using `@modelcontextprotocol/sdk`.
- Keep MCP tool contracts stable and update user-facing docs when behavior changes.
- `skill/skill-example.md` documents how agents should use these tools. Keep it aligned with this README and the implementation.
- Run `npm run build` after TypeScript changes.

## Troubleshooting

- Tool is missing in the client: confirm the server was rebuilt, the MCP client points at `dist/index.js`, and the tool is enabled if the client uses allowlists.
- Verdict is always `uncertain`: confirm the local model endpoint is running and supports `/v1/chat/completions`.
- Command fails but summary says pass: the implementation should override that to `fail`; inspect exit code handling if this occurs.
- Raw log path cannot be found: resolve relative `rawLogPath` against the same `workspacePath` used in the tool call.
- Regression check changes unexpectedly: remember that `run_regression_check` writes the current run as the new baseline.
