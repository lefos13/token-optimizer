# Token Optimizer

Token Optimizer is an MCP server for running local validation commands and turning long build, lint, test, and smoke-check logs into compact verdicts. This tool has been tested with the Q4_K_M variation on a Macbook M4 Pro (24GB RAM).

It is designed for coding agents that need to verify changes without pasting raw logs into the conversation. The server runs commands in the target workspace, writes full logs to disk, sends trimmed context to a local OpenAI-compatible model endpoint, and returns structured JSON that an agent can act on.

## Setup (end users)

This plugin runs your workspace's build/lint/test commands locally and returns
compact LLM verdicts, triage, and reviews via a shared gateway — so raw logs
stay out of your agent's context.

**Prerequisite:** a gateway access token (ask your gateway operator). The gateway
URL is already preconfigured in the plugin.

### 1. Install the plugin

- **Claude Code:** install from the marketplace (`token-optimizer`).
- **Codex:** install from the marketplace (`token-optimizer`).
- **Antigravity:** copy or symlink the generated `plugin/antigravity/` folder into
  Antigravity's plugin directory.
- **opencode:** copy the generated server and skill bundle into
  `~/.config/opencode/`.
- **Cursor:** copy the generated server bundle into `~/.cursor/` and copy the
  generated rule into each project that should use it.

### 2. Provide your token

The gateway URL is baked in; the only value you supply is your token.

- **Shortcut (repo clone):** `npm run gateway:config -- setup`, paste your token
  once — it is written to every client on your machine.
- **Manual (no repo):** set `LLM_GATEWAY_TOKEN` in your client's config:
  - Claude Code → `~/.claude/settings.json` under `env`
  - Codex → your shell/launch environment (it is passed through)
  - Antigravity → its `mcp_config.json` under the `token_optimizer` `env`
  - opencode → `~/.config/opencode/opencode.jsonc` under `mcp.token_optimizer.environment`
  - Cursor → `~/.cursor/mcp.json` under `mcpServers.token_optimizer.env`

To make the tools default-on (used automatically unless you say otherwise) in clients with writable global instruction files, also run:

```bash
npm run gateway:config -- enable-defaults
```

This writes a standing directive into each managed global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `~/.config/opencode/AGENTS.md`). Cursor rules remain project-scoped unless you add an equivalent global rule through Cursor Settings. Run `npm run gateway:config -- disable-defaults` to remove the managed directives, or `npm run gateway:config -- status` to check whether they're set.

### 3. Verify

Restart the client. The tools (`run_test_verdict`, `run_failure_triage`,
`run_changed_files_review`, `run_regression_check`, `run_command_digest`,
`query_log`, `grep_log`, `scout_codebase`) are available, and
`check_local_llm_health` reports the gateway reachable.

> Hosting the gateway, issuing/rotating tokens, and choosing models are operator
> tasks — see [`gateway/README.md`](gateway/README.md).

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

Every successful tool path records private analytics inside the target workspace:

```text
<workspacePath>/.codex-local-test-runs/analytics.json
<workspacePath>/.codex-local-test-runs/analytics-summary.json
```

Records keep the latest 200 tool calls per workspace and include compact metadata: tool name, timestamp, commands and exit codes, token counts, savings percentage, provider/model/latency, confidence, and fallback reason. Raw logs, prompts, file contents, and full model responses are never stored. Analytics writes are best-effort and never fail the underlying tool call.

### Multi-Workspace Analytics Dashboard

To view analytics in a browser, run (from the MCP server project):

```sh
npm run analytics:ui
```

By default, the dashboard serves `http://127.0.0.1:8787`. To use a different port:

```sh
npm run analytics:ui -- --port 8787
```

The dashboard is workspace-aware: add workspaces by pasting absolute project paths, switch between an aggregated "All workspaces" view or a single workspace, paginate the event feed, and remove workspaces from the list. Registered workspaces persist at `~/.token-optimizer-analytics/workspaces.json`, and existing `~/.local-tester-analytics/workspaces.json` data is still read once for migration. You can also seed workspaces on the command line with `--workspace /absolute/path`.

## Requirements

- Node.js 20 or newer.
- npm.
- An MCP-compatible client that can launch stdio servers.
- A gateway access token (`LLM_GATEWAY_TOKEN`), **or** a local OpenAI-compatible chat completions endpoint — at least one must be configured.
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

### Centralized gateway (recommended)

Point the server at a shared gateway so users never hold a raw provider key
and the model is chosen centrally. Set two variables:

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_URL` | Gateway base URL, e.g. `https://llm-proxy.lnf.gr/v1`. |
| `LLM_GATEWAY_TOKEN` | Shared proxy token issued by the gateway operator (revocable). |

When both are set, the gateway is the primary LLM provider. Each call sends an
`X-Task-Type` header so the gateway pins the model; the client's model choice is
ignored and the actually-used model is reported back in analytics. If the gateway
is unreachable, the server falls back to a local model when `LOCAL_LLM_*` is
configured, otherwise it returns a conservative `uncertain` result.

Precedence: `LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN` (both must be set together to
engage the gateway) → local model. To host the gateway, see
[`gateway/README.md`](gateway/README.md).

### Recommended setup command

Use the repo-shipped config manager instead of editing plugin cache files:

```sh
npm run gateway:config -- setup
```

It prompts for the gateway URL and token once, then updates the stable user-owned
config surfaces for the supported clients:

- Claude Code: `~/.claude/settings.json`
- Gemini CLI: `~/.gemini/config/mcp_config.json`
- Antigravity staged plugin: `~/.gemini/config/plugins/token-optimizer/mcp_config.json` when present
- OpenCode: `~/.config/opencode/opencode.jsonc`
- Cursor: `~/.cursor/mcp.json`
- Codex and other macOS GUI app launches: the current user `launchctl` environment

Other commands:

```sh
npm run gateway:config -- update
npm run gateway:config -- delete
npm run gateway:config -- status
```

### Setting the token in a stable config

Generated plugins intentionally omit `LLM_GATEWAY_*` placeholders from their
bundled config. Blank plugin-scoped values override inherited host settings,
which forces users to re-edit versioned cache directories after every update.

Preferred order:
- Use the client's stable user config when it can supply environment variables to plugin MCP processes.
- Otherwise set `LLM_GATEWAY_*` in the parent shell or app launch environment.
- Only set `LLM_GATEWAY_*` inside an installed plugin config when you explicitly want a plugin-scoped override.

#### Claude Code

The config manager writes `LLM_GATEWAY_*` into `~/.claude/settings.json` under
the top-level `env` object. The generated plugin uses Claude's `${VAR}`
expansion so new plugin versions inherit those values automatically. If you
intentionally want a plugin-scoped override, the plugin is cached at a
versioned path under `~/.claude/plugins/cache/`. Find the exact file with:

```sh
find ~/.claude/plugins/cache/token-optimizer-marketplace -name ".mcp.json"
```

This prints something like:

```
~/.claude/plugins/cache/token-optimizer-marketplace/token-optimizer/1.2.2/.mcp.json
```

Open that file and add the `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` values inside the `env` block:

```json
"env": {
  "LLM_GATEWAY_URL": "https://llm-proxy.lnf.gr/v1",
  "LLM_GATEWAY_TOKEN": "your-token"
}
```

Plugin-scoped edits are not carried across plugin updates, which is why the stable host config or launch environment is the recommended setup.

#### Codex

The config manager writes `LLM_GATEWAY_*` into the current macOS GUI session
with `launchctl setenv`. The generated plugin uses `env_vars` to forward those
names into the bundled MCP server without storing the secret in the cached
`.mcp.json`. If you intentionally want a plugin-scoped override, find the
installed plugin config and edit its `.mcp.json` under
`mcpServers.token_optimizer.env`.

```bash
find ~/.codex/plugins -path '*token-optimizer*' -name '.mcp.json'
```

Add your gateway values there:

```json
"env": {
  "LOCAL_LLM_API_URL": "http://localhost:8080/v1",
  "LOCAL_LLM_MODEL": "local-model",
  "LLM_GATEWAY_URL": "https://llm-proxy.lnf.gr/v1",
  "LLM_GATEWAY_TOKEN": "your-token"
}
```

After editing the installed plugin config, restart Codex or start a new thread so the MCP server is reloaded with the new environment.

#### Antigravity

The config manager writes `LLM_GATEWAY_*` into
`~/.gemini/config/mcp_config.json` and, when the staged plugin exists, into
`~/.gemini/config/plugins/token-optimizer/mcp_config.json` too. If you
intentionally want a plugin-scoped override, edit that staged plugin config
directly under `mcpServers.token_optimizer.env`.

### `check_local_llm_health` when the gateway is configured

When `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are both set, `check_local_llm_health` verifies gateway reachability the same way it verifies a local-endpoint configuration, reporting availability and latency without exposing the token.

## Token Optimizer Configuration

When the gateway is not configured, the server uses a local OpenAI-compatible endpoint. These environment variables configure that fallback path:

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

## MCP Client Setup

Build the server first, then configure your MCP client to launch `dist/index.js` with Node.

Example stdio configuration:

```json
{
  "mcpServers": {
    "token_optimizer": {
      "command": "node",
      "args": ["/absolute/path/to/token-optimizer-mcp/dist/index.js"],
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
[mcp_servers.token_optimizer]
command = "node"
args = ["/absolute/path/to/token-optimizer-mcp/dist/index.js"]

[mcp_servers.token_optimizer.env]
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

This repository can generate the `token-optimizer` plugin or bundle for **five different clients**, each with its own generator and output directory. All variants ship the same skill content (from `skill/skill-example.md`) where the target client supports skills, but package it differently for each client.

| Client      | npm script                     | Output             | Tracked in git | Packaging                                                                 |
| ----------- | ------------------------------ | ------------------ | -------------- | ------------------------------------------------------------------------ |
| Antigravity | `npm run build:plugin:antigravity` | `plugin/antigravity/` | No (gitignored) | Self-contained: `plugin.json`, `mcp_config.json` (registers the bundled server), portable `server/`, `skills/`. |
| Claude Code | `npm run build:plugin:claude`      | `plugin/claude/`      | Yes            | `.claude-plugin/` manifest, bundled portable MCP server, local marketplace. |
| Codex       | `npm run build:plugin:codex`       | `plugin/codex/`       | Yes            | `.codex-plugin/` manifest, `.mcp.json` with top-level `mcp_servers`, bundled portable MCP server, repo marketplace. |
| opencode    | `npm run build:plugin:opencode`    | `plugin/opencode/`    | No (gitignored) | Copyable server, global skill, and MCP config snippet. |
| Cursor      | `npm run build:plugin:cursor`      | `plugin/cursor/`      | No (gitignored) | Copyable server, project rule, and MCP config snippet. |

Run all generators at once with `npm run build:plugin`.

> Do not edit files under `plugin/` by hand; they are generated. The Antigravity output is gitignored, while the Claude Code and Codex outputs are committed so marketplace installs can copy them.

### Antigravity

The plugin bundles the compiled MCP server and registers it via `mcp_config.json`. The launcher (`server/start.sh`) self-locates and installs its single runtime dependency into `.data/` on first run — no absolute paths are baked in.

1. Build the server and generate the plugin:

   ```bash
   npm run build
   npm run build:plugin:antigravity
   ```

2. Copy (or symlink) the generated plugin into Antigravity's plugins directory:

   ```bash
   mkdir -p ~/.gemini/config/plugins
   cp -R plugin/antigravity ~/.gemini/config/plugins/token-optimizer
   ```

   Plugin directories vary by client version: `~/.gemini/config/plugins/` (global), `~/.gemini/antigravity-cli/plugins/`, or `<workspace>/.agents/plugins/`.

3. Restart Antigravity (or reload plugins) so it registers the `token_optimizer` server and loads the `token-optimizer` skill.

**Requirements:** `node`, `npm`, and `bash` on `PATH`; network access on first run only. Override the LLM endpoint via `LOCAL_LLM_API_URL` / `LOCAL_LLM_MODEL` in the copied `mcp_config.json`.

To pick up changes, re-run `npm run build:plugin:antigravity` and re-copy (or re-symlink once) the folder, then reload Antigravity.

### Claude Code

The plugin bundles the compiled MCP server and launches it via `${CLAUDE_PLUGIN_ROOT}/server/start.sh`. The runtime dependency installs into `${CLAUDE_PLUGIN_DATA}` on first run. The repository is the marketplace: the catalog at `.claude-plugin/marketplace.json` and the plugin under `plugin/claude/` are both committed.

1. Build the server and generate the plugin (also regenerates the repo-root marketplace catalog):

   ```bash
   npm run build
   npm run build:plugin:claude
   ```

2. Add the repository as a marketplace and install the plugin:

   ```bash
   # From a local clone (must be a git repo — relative plugin sources need git):
   claude plugin marketplace add "$(pwd)"
   # Or from a git host once pushed:
   # claude plugin marketplace add <github-owner>/<repo>

   claude plugin install token-optimizer@token-optimizer-marketplace
   ```

3. Restart Claude Code (or run `/reload-plugins`) so the MCP server and skill load.

The skill is invoked as `/token-optimizer:token-optimizer` and is also model-invoked automatically based on its description. The MCP tools are exposed as `mcp__token_optimizer__*`.

**Requirements on the target machine:** `node` and `npm` on `PATH`, plus network access the first time (to install the dependency). After that the server runs offline. Override the LLM endpoint with the same environment variables described in [MCP Client Setup](#mcp-client-setup) (`LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`, and the per-task `LOCAL_LLM_*_MODEL` overrides).

For local development you can skip the marketplace entirely and load the plugin directly:

```bash
claude --plugin-dir ./plugin/claude
```

### Codex

The plugin bundles the compiled MCP server and launches `./server/start.sh` from the plugin root. The runtime dependency installs into `${PLUGIN_DATA}` or `.data/` fallback on first run. The repository marketplace is at `.agents/plugins/marketplace.json`; both the catalog and `plugin/codex/` are committed.

1. Build the server and generate the plugin:

   ```bash
   npm run build
   npm run build:plugin:codex
   ```

2. Add the repository as a Codex marketplace:

   ```bash
   codex plugin marketplace add "$(pwd)"
   ```

3. Install or enable the `token-optimizer` plugin in Codex, then restart or reload Codex so the MCP server and skill load.

The skill is available as `token-optimizer` and is also model-invoked automatically based on its description. The bundled MCP server is named `token_optimizer`.

**Requirements on the target machine:** `node` and `npm` on `PATH`, plus network access the first time (to install the dependency). After that the server runs offline. Override the LLM endpoint with the same environment variables described in [MCP Client Setup](#mcp-client-setup) (`LOCAL_LLM_API_URL`, `LOCAL_LLM_MODEL`, and the per-task `LOCAL_LLM_*_MODEL` overrides).

### opencode

opencode has no plugin/marketplace mechanism for MCP servers or skills, so install is a copy plus config step:

1. `npm run build && npm run build:plugin:opencode`
2. Copy `plugin/opencode/server/` to `~/.config/opencode/token-optimizer-server/` and `plugin/opencode/skills/token-optimizer/` to `~/.config/opencode/skills/token-optimizer/`.
3. Provide your token with `npm run gateway:config -- setup`; it writes the `token_optimizer` MCP block and gateway environment into `~/.config/opencode/opencode.jsonc`.
4. Run `npm run gateway:config -- enable-defaults` if you want the default-on directive in `~/.config/opencode/AGENTS.md`, then restart opencode.

Full instructions: [`plugin/opencode/README.md`](plugin/opencode/README.md) (generated).

### Cursor

Cursor also has no plugin/marketplace mechanism:

1. `npm run build && npm run build:plugin:cursor`
2. Copy `plugin/cursor/server/` to `~/.cursor/token-optimizer-server/`.
3. Provide your token with `npm run gateway:config -- setup`; it writes the `token_optimizer` MCP block and gateway environment into `~/.cursor/mcp.json`.
4. Copy `plugin/cursor/rules/token-optimizer.mdc` into each project's `.cursor/rules/` — Cursor has no filesystem-writable global rule, so this only applies per-project unless you also add an equivalent rule via Cursor Settings.
5. Restart Cursor.

Full instructions: [`plugin/cursor/README.md`](plugin/cursor/README.md) (generated).

### One-command npm installer feasibility

Packaging the end-user install flow as an npm package is feasible, with client-specific limits:

- The npm package can ship the compiled server, generated skill/rule files, and an installer CLI such as `npx token-optimizer-setup`.
- The CLI can copy the server bundle, create or update MCP config files, prompt once for the gateway token, write the managed gateway env values, and apply default-on instruction files where the target client exposes a writable file.
- Claude Code and Codex marketplace registration can be automated when their CLIs are installed, but the installer should still detect missing CLIs and print the exact fallback command.
- Antigravity, opencode, and Cursor can be installed by direct file copy and config mutation because their generated bundles are file-based.
- Cursor remains the main partial exception: the CLI can write global MCP config, but project rules still need either per-project `.cursor/rules/token-optimizer.mdc` writes or a manual global User Rule in Cursor Settings.
- The package should be a separate installer package from the MCP server package so it can own OS-specific setup, backups, idempotency, and uninstall/update commands without changing the server runtime.

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
