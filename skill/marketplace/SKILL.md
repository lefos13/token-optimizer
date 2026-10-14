---
name: token-optimizer
description: Runs build, lint, typecheck, and test commands through the Token Optimizer MCP server and returns compact verdicts, failure triage, and log answers instead of raw output, so long logs never flood the agent's context. Use it when validating a code change, diagnosing a failing build or test, reviewing small diffs before a slow suite, summarizing a noisy command, or locating code in an unfamiliar repository; it also guides installing, configuring, and troubleshooting the server.
---

# Token Optimizer

Token Optimizer is an MCP server. It runs validation commands inside the
workspace, keeps the full logs on disk under `.codex-local-test-runs/`, and
asks a small, cheap model (your own OpenRouter key, or a local
OpenAI-compatible model) for a compact JSON result. Command exit codes are
always authoritative; the model only summarizes.

## Setup and troubleshooting

This skill needs the `token_optimizer` MCP server. Read
`references/setup.md` and follow it when:

- tools such as `run_test_verdict` or `check_local_llm_health` are not
  available, or
- the user asks to install, reconfigure, switch the provider of, upgrade, or
  fix Token Optimizer.

The setup playbook installs nothing without the user's consent and never
asks for an API key in the conversation. If the server stays unavailable, run
the normal commands yourself and summarize the output.

## Tools

- `check_local_llm_health` — confirms the configured provider responds.
- `run_test_verdict` — runs one command (`testCommand`) or several
  (`testCommands`) and returns `pass` / `fail` / `uncertain` with failures and
  suggested fixes.
- `run_changed_files_review` — quick advisory review of small changed files
  before a slow suite.
- `run_failure_triage`, `query_log`, `grep_log` — investigate a stored log by
  `runId` without reading it whole.
- `run_command_digest` — runs a noisy command (install, build, migration) and
  answers a stated `intent`.
- `scout_codebase` — ranked file/line pointers for a goal in an unfamiliar
  codebase.
- `run_regression_check` — compares auto-detected validation with the stored
  baseline, then overwrites that baseline.

## Workflow

1. Use the absolute workspace path as `workspacePath`.
2. After changing code, call `run_test_verdict` with the narrowest relevant
   command and a concrete `taskSummary`; pass `changedFiles` when known and
   `autoTriage: true`.
3. On `fail` or `uncertain`, use the inline `triage`, then `query_log` or
   `grep_log` with the returned `runId`. Read raw logs only as a last resort,
   and only the cited lines.
4. Use `run_command_digest` instead of running noisy commands directly.
5. Use `run_regression_check` only when overwriting
   `.codex-local-test-runs/baseline.json` is acceptable.

```json
{
  "workspacePath": "/absolute/path/to/workspace",
  "taskSummary": "Fixed date parsing in src/dates.ts; validate typecheck and tests.",
  "changedFiles": ["src/dates.ts"],
  "testCommands": ["npm run typecheck", "npm test"],
  "autoTriage": true
}
```

## Guardrails

- A non-zero exit code is a failure, whatever the model says.
- If `llmAvailable` is `false`, treat the summary as unavailable and fall back
  to exit codes, `grep_log`, or a small raw-log slice.
- `validationOutcome: not_run` means the execution policy blocked the command;
  it is not a test failure. Shell chaining, redirection, and Git mutations are
  blocked by default; batch checks with `testCommands` instead of `&&`.
- Changed-file review findings are advisory; verify them before acting.
- Do not paste raw logs into the conversation when the verdict is actionable.
