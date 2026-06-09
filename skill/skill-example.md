---
name: local-llm-subagent
description: Use this MCP server and its local LLM flow to scout codebases, validate code changes, review changed files, triage failures, check regressions, classify command output, and keep raw logs out of context. Trigger when starting scouting a codebase, implementing code changes, fixing bugs, touching tests/build/lint behavior, preparing final verification, triaging failures, reviewing changed files, checking regressions, or when the user asks to use the local llm subagent, local llm test triage, or avoid reading raw logs or using an llm subagent to unload high context tasks from the main model.
---

# Local LLM Subagent

## Overview

Use the `mcp__local_tester` tools as the first validation path after code changes. Let the MCP server run validation commands, persist full logs under the target workspace, and ask the local LLM for compact verdicts, changed-file review, failure triage, or regression checks before deciding whether raw logs are needed.

Currently implemented server tools:

- `check_local_llm_health`: verifies the configured LLM provider. When `OPENROUTER_API_KEY` is set, returns `skipped: true` immediately (no network call — the key is assumed valid). Otherwise pings the local OpenAI-compatible endpoint and returns availability metadata.
- `run_test_verdict`: runs build/lint/test/smoke commands in a workspace and returns a compact local-LLM verdict.
- `run_failure_triage`: analyzes an existing log file and returns compact root-cause/fix guidance.
- `run_changed_files_review`: reads changed files under 500 KB and asks the local LLM for likely issues before expensive validation.
- `run_regression_check`: runs auto-detected commands, compares success state with `.codex-local-test-runs/baseline.json`, writes the current run as the new baseline, and returns whether a regression was detected.
- `run_command_digest`: runs any arbitrary command (or sequence) and returns a compact, intent-steered local-LLM digest, for noisy non-test commands whose raw output would otherwise flood context.
- `query_log`: asks a targeted question against a stored log (by `runId` or path) and returns a compact answer plus the relevant excerpt, so you do not read the whole log.
- `grep_log`: deterministic, no-LLM regex search over a stored log (by `runId` or path), returning matching line windows.
- `scout_codebase`: recon subagent — greps the workspace for seed terms, then the local LLM ranks the matches into pointers (file + lineRange + why + confidence) so you know where to read before exploring an unfamiliar area broadly.

## Workflow

1. Check local project instructions before validation, including `AGENTS.md` or `agents.md`.
2. Identify the workspace path as an absolute path.
3. If local model availability is unclear, call `check_local_llm_health` before spending time on LLM-backed verdicts or scouting.
4. If files changed and the tool is exposed, call `run_changed_files_review` before slow test suites when a lightweight local-LLM review can catch obvious issues.
5. Prefer an explicit `testCommand` for `run_test_verdict` when the correct validation command is known from the repo, package scripts, or user request.
6. Omit `testCommand` only when automatic command detection is preferable.
7. Pass a short `taskSummary` that describes the concrete code change or validation goal, not a broad audit request.
8. Pass `changedFiles` when available, using repo-relative paths for tools that resolve files under `workspacePath`.
9. Treat returned JSON as the primary signal and avoid raw logs while the summary is actionable.
10. When `verdict` is `fail` or `uncertain`, look at the `triage` field in the response (if `autoTriage: true` was passed) or call `run_failure_triage`, `query_log`, or `grep_log` on the returned `runId`/log before reading raw logs, unless the returned summary already contains enough detail to fix the issue.
11. Use `run_regression_check` only when auto-detected commands are appropriate and updating `.codex-local-test-runs/baseline.json` is acceptable for the workspace.

## Tool Call Shapes

Call `check_local_llm_health` when you need to confirm the local provider/model before LLM-backed workflows:

```json
{}
```

Call `run_changed_files_review` (set `useDiff` to review only changed hunks vs `HEAD`):

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "changedFiles": ["src/example.ts"],
  "useDiff": true
}
```

Call `run_test_verdict`:

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "taskSummary": "Implemented X; validate build/lint/tests for that change.",
  "changedFiles": ["src/example.ts"],
  "testCommand": "npm test",
  "maxOutputLines": 300,
  "timeoutMs": 300000,
  "parallel": false,
  "autoTriage": true
}
```

Call `run_failure_triage` only for an existing log path, usually after `run_test_verdict` returns a `rawLogPath`:

```json
{
  "logPath": "/absolute/path/to/workspace/.codex-local-test-runs/example.log"
}
```

If `rawLogPath` is relative, resolve it against `workspacePath` before calling `run_failure_triage`.

Call `run_regression_check` only when the project has a meaningful auto-detected test/build command and baseline mutation is intended:

```json
{
  "workspacePath": "/absolute/path/to/workspace"
}
```

Call `run_command_digest` for any noisy command whose raw output you do not want in context (installs, builds, migrations, large `grep`/`find`, `git log`, codegen). State what you want to learn in `intent`:

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "command": "npm install",
  "intent": "Did the install report any errors, peer-dependency warnings, or deprecated packages?",
  "timeoutMs": 600000
}
```

Call `query_log` to interrogate a stored log instead of reading the whole file. Use the `runId` returned by a prior run (or a `logPath`):

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "runId": "2026-06-05T17-20-45-148Z",
  "question": "Which test failed and on what assertion?"
}
```

Call `grep_log` when you already know the token to find and want exact lines with no model call:

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "runId": "2026-06-05T17-20-45-148Z",
  "pattern": "Error|FAIL|Traceback",
  "context": 3
}
```

Call `scout_codebase` before exploring an unfamiliar area, to get ranked pointers to where the relevant code lives instead of scanning the whole tree. Supply precise `seedTerms` when you know the symbols:

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "goal": "where is auth token refresh handled?",
  "seedTerms": ["refreshToken", "expires_in"],
  "roots": ["src"]
}
```

Use commands that exercise the changed surface:

- Narrow change: run the most specific relevant test, lint target, typecheck, or build.
- Shared behavior or uncertain scope: run the broader suite after the narrow check.
- No test suite: run the best deterministic command available, such as typecheck, build, or a small executable probe.

## Interpreting Results

- `run_changed_files_review`: Treat `hasIssues: true` as advisory. Verify serious findings with tests, typecheck, or direct code inspection before changing code. If `reviewAvailable` is `false`, the local model did not run; do not read `hasIssues: false` as a clean review. Check `skipped` to see whether any changed files were not reviewed (missing, not a file, or over the 500 KB limit).
- LLM-backed results can include `llmAvailable`, `llmProvider`, `llmModel`, `llmLatencyMs`, `llmTaskType`, and `fallbackReason`. If `llmAvailable` is `false`, treat the local model output as unavailable and fall back to deterministic command results, `grep_log`, or the smallest useful raw-log slice.
- `run_test_verdict`: When present, `likelyRelevantToRecentChanges` is the local model's guess about whether a failure stems from the reported `changedFiles`; use it to prioritize, not as proof. Set `maxOutputLines` to bound how much log the model sees on very noisy commands, `timeoutMs` for long suites, and `parallel: true` only when the detected commands are independent. Low local-model confidence keeps the verdict uncertain and sets `needsRawLogs`.
- Context-savings analytics are intentionally not returned in tool JSON. Inspect `.codex-local-test-runs/analytics.json` and `.codex-local-test-runs/analytics-summary.json` inside the **target workspace** (next to its raw run logs and baseline), or run `npm run analytics:ui` from the MCP server project to view a multi-workspace dashboard with pagination, when you need local LLM token use, returned MCP response size, estimated tokens saved, and savings percentages.
- `run_changed_files_review`: Prefer `useDiff: true` in a git repo to review only changed hunks (cheaper, sharper); it falls back to whole-file content for files with no diff or outside git.
- `run_test_verdict` `pass`: Report the commands run, the verdict, and any residual risk. Do not read or paste raw logs.
- `run_test_verdict` `fail`: Use the LLM summary, `failures`, and inline `triage` field first. If the fix is not clear, call `run_failure_triage` with the log path before opening raw logs.
- `run_test_verdict` `uncertain`: Use the inline `triage` field first. If missing, vague, contradictory, or not enough for the next debugging step, call `run_failure_triage` with the referenced log path or inspect the raw log file.

- `run_regression_check`: Treat `isRegression: true` as a signal that the current run failed after a previously successful baseline. Remember the tool overwrites the baseline with the current run.
- `run_command_digest`: Use `summary` and `keyFindings` as the answer to your `intent`; do not paste the raw output. `exitCode`/`exitCodes` are authoritative, the digest only describes. If `needsRawLogs` is `true` (or the digest is empty because the model was offline), interrogate the log with `query_log`/`grep_log` using the returned `runId` instead of reading it whole.
- `query_log`: Prefer this over reading `rawLogPath` after a `fail`/`uncertain` verdict. Use `answer` and `relevantExcerpt`; cite `lineRange` if you need to open the exact spot. If `available` is `false`, fall back to `grep_log` or read only the cited slice of the raw log.
- `grep_log`: Use for exact, cheap lookups (stack-trace markers, a symbol, a filename). Returns line-numbered windows; widen `context` or raise `maxMatches` only if the first pass is insufficient.
- `scout_codebase`: Use `pointers` (verify each `file`/`lineRange` by opening it — they are hints, not authority) and `summary` to decide where to read. When `scoutAvailable` is `false`, the local model did not rank; fall back to the deterministic `candidateFiles`. If `needsDeeperLook` is `true` or pointers miss the goal, refine `seedTerms` (see `suggestedNextSearches`) or widen `roots`.

The server writes `rawLogPath` relative to `workspacePath`, usually inside `.codex-local-test-runs/`.

## Additional LLM Use Cases

Use `run_test_verdict` for any validation command where a compact local-LLM summary is more useful than raw output:

- Build, lint, typecheck, unit test, integration test, browser test, and smoke-check verdicts.
- One-off executable probes, such as a small Node/Python command that confirms a fixed behavior.
- Dependency or environment checks where the model can classify whether a failure is code-related, setup-related, or inconclusive.
- Final verification summaries before responding to the user, especially after multi-file changes.

Use `run_changed_files_review` for quick local-LLM review when changed files are small enough to fit the tool limit:

- Catch obvious syntax, type, logic, or regression risks before running slow suites.
- Review generated or repetitive edits where simple mistakes are easy to miss.
- Surface suspicious files that deserve focused tests or manual inspection.

Use `run_failure_triage` for follow-up analysis of existing logs:

- A failed or uncertain verdict needs stack-trace classification.
- The summary identifies symptoms but not the likely root cause.
- A long build, lint, or browser-test log needs compact failure grouping.
- The same command was retried and you need to distinguish deterministic failure from environment noise.

Use `run_regression_check` for baseline-aware checks only when baseline churn is acceptable:

- Establish the first baseline for a workspace after a known-good run.
- Detect whether a newly failing auto-detected suite regressed from a previously successful baseline.
- Avoid it when you need a read-only check, a custom command, or stable historical baselines.

If a tool exists in the server but is not exposed in the current Codex session, check plugin-provided MCP policy in `~/.codex/config.toml`, such as `[plugins."local-tester@local-tester-marketplace".mcp_servers.local_tester]` and its `enabled_tools` / `disabled_tools` settings, then start a new thread or restart Codex so the tool surface refreshes.

## Guardrails

**LLM provider:** Set `OPENROUTER_API_KEY` in the MCP server's `env` block to use OpenRouter as the primary provider. When absent, the server falls back to a local OpenAI-compatible endpoint (`LOCAL_LLM_API_URL`). If an OpenRouter call fails, the server automatically retries with the local endpoint and surfaces `fallbackReason` in the response. The chosen OpenRouter model must support `response_format: { type: "json_object" }` (JSON mode); models that do not support it will error and trigger the local fallback. Compatible models include `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-3-5-sonnet`, `anthropic/claude-3-haiku`, and `google/gemini-flash-1.5`.

**OpenRouter env vars:**
- `OPENROUTER_API_KEY` — enables OpenRouter mode
- `OPENROUTER_MODEL` — default model for all tasks (falls back to `openai/gpt-4o-mini`)
- Per-task: `OPENROUTER_VERDICT_MODEL`, `OPENROUTER_TRIAGE_MODEL`, `OPENROUTER_REVIEW_MODEL`, `OPENROUTER_DIGEST_MODEL`, `OPENROUTER_SCOUT_MODEL`, `OPENROUTER_QUERY_MODEL`

- Do not paste raw logs into the conversation when the verdict or triage is actionable.
- Do not let the LLM override command truth: non-zero exits are failures unless the tool explicitly reports uncertainty.
- Treat changed-file review findings as advisory because the local LLM sees file contents, not full project semantics.
- Keep `taskSummary` concrete so the local model judges the actual validation target.
- Resolve relative log paths against `workspacePath` before follow-up triage.
- Avoid `run_regression_check` when writing or replacing `.codex-local-test-runs/baseline.json` would be undesirable.
- If an MCP tool returns placeholder text, no analysis, or anything clearly non-authoritative, fall back to reading the smallest useful raw-log slice or running normal local commands.
- If the MCP tool is unavailable, fall back to local commands and summarize output manually, then tell the user the MCP validation path was unavailable.
