# Token Optimizer v2 Production-Readiness Design

**Status:** Approved design

**Date:** 2026-07-10

**Target release:** v2.0.0

## Purpose

Token Optimizer v2 will make the existing local-first command execution and log-triage MCP suitable for serious public use. The release focuses on the product's current trust boundaries: command execution, log persistence, remote inference, credential handling, installer mutations, and release integrity.

The release will preserve existing MCP tool names and compatible output fields where doing so does not retain an unsafe default. Legacy configuration will remain readable through a documented compatibility layer for the lifetime of v2.x.

## Product Positioning

> Token Optimizer is a local-first command execution and log-triage MCP that prevents noisy development output from flooding a coding agent's context.

Documentation and benchmarks must describe the workload, raw output size, returned response size, runtime overhead, and provider configuration behind every token-savings claim.

## Current Gaps Addressed

The design addresses the following confirmed gaps in v1.12.1:

- OpenRouter BYOK credentials and selected excerpts pass through the Softaware gateway.
- Command execution uses `exec()` with a 50 MB in-memory buffer and does not reliably terminate complete process trees.
- Logs have no built-in secret redaction, retention policy, or disk quota.
- Arbitrary command execution has no explicit security profile or workspace policy boundary.
- Installer mutations cannot be previewed through a general dry-run and are not represented by a durable installation manifest.
- Installer lifecycle commands are incomplete: provider configuration has a limited status/delete flow, but the product lacks unified doctor, repair, and uninstall flows.
- Credentials can persist in plaintext client configuration and GUI-session environment surfaces.
- LLM response normalization is not backed by strict task-specific runtime schemas.
- The installer package is `UNLICENSED`, and the root server depends on an older installer package version.

## Release Strategy

The work will ship as one public v2.0 release, developed through internal milestones and prereleases:

1. Internal trust-boundary milestone.
2. Internal execution-reliability milestone.
3. Internal installer-lifecycle milestone.
4. `v2.0.0-alpha` for contracts and migration fixtures.
5. `v2.0.0-beta` when feature complete.
6. `v2.0.0-rc.1` after security and reliability freeze.
7. `v2.0.0` after all production gates pass.

Legacy variables will emit deprecation warnings but remain supported throughout v2.x. Their removal may only be considered for v3.

## Architecture

The v2 request path is divided into explicit, independently testable components:

1. MCP request validation.
2. Effective configuration resolution.
3. Command policy evaluation.
4. Streamed command execution.
5. Managed log storage.
6. Bounded excerpt generation.
7. Secret redaction.
8. Provider inference.
9. Structured response validation.
10. Stable MCP response shaping.

The installer uses a parallel lifecycle path:

1. Inspect current state.
2. Build an immutable change plan.
3. Present the plan for dry-run or approval.
4. Apply mutations with backups and a manifest.
5. Validate effective installation state.
6. Roll back critical partial failures.

## Configuration Model

Non-security configuration follows this precedence:

1. Explicit MCP tool argument.
2. Project configuration.
3. User configuration.
4. Installer defaults.
5. Legacy compatibility mapping.

Project configuration may control execution policy, log lifecycle, and provider mode, but it must not contain raw credentials. Credentials are referenced through a credential identifier or an environment-variable name.

Execution privileges follow a monotonic security ceiling instead of ordinary last-writer precedence. User configuration establishes the maximum permitted profile. Project configuration and tool arguments may narrow that profile but cannot elevate it. Elevation from `safe` to `standard` or `unrestricted` requires an explicit user-owned configuration change or an installer flow that shows the resulting trust impact. A repository-controlled project file therefore cannot grant itself broader command privileges when opened by an agent.

Example project configuration:

```json
{
  "schemaVersion": 2,
  "execution": {
    "profile": "safe",
    "allowedCommandPrefixes": ["npm run", "npm test", "pytest"]
  },
  "logs": {
    "retentionDays": 7,
    "maxDiskMb": 500,
    "storageMode": "raw-local"
  },
  "provider": {
    "mode": "openrouter-direct"
  }
}
```

## Command Security Profiles

### Safe

`safe` is the default for new installations. It permits:

- Auto-detected build, test, lint, and typecheck commands.
- Commands with an executable or normalized prefix in the effective allowlist.
- Working directories and workspace-relative input/output paths confined to the canonical workspace.
- Deterministic read-only discovery required by existing tools.

It rejects:

- Access to known sensitive locations such as `.ssh`, `.aws`, `.gnupg`, OS credential stores, `.env`, and recognized credential files.
- Path traversal and symlink escape outside the workspace.
- Destructive filesystem patterns.
- Network exfiltration patterns.
- Environment-dump commands.
- Nested shell interpreters intended to bypass policy.
- Shell substitution and redirection not required by the allowlisted command.

Policy evaluation should use parsed executable/argument information and canonical paths wherever possible. Regex matching is an additional deny layer, not the primary security boundary.

### Standard

`standard` permits more explicit commands while retaining workspace confinement and sensitive-path protection. A client may add confirmation UX where supported, but server correctness must not depend on every MCP client implementing confirmation.

### Unrestricted

`unrestricted` retains arbitrary command behavior through explicit opt-in. It does not disable timeouts, audit logs, remote redaction, structured results, or disk quotas.

`run_command_digest` remains available in all profiles, but its effective command permissions follow the selected profile.

## Streamed Execution Engine

`exec()` will be replaced with a streamed `spawn()`-based engine.

- stdout and stderr stream directly to the run log.
- Only bounded head, tail, and failure-marker windows remain in memory.
- A single `finish()` path with an explicit settled guard owns cleanup and result resolution.
- Timeout handling terminates the complete process tree.
- Unix process groups and Windows process-tree termination use separate adapters.
- Spawn failure, timeout, signal termination, policy rejection, and ordinary non-zero exit are distinct outcomes.
- Command exit codes remain authoritative and cannot be overridden by an LLM.

Auto-detected commands should use executable-plus-arguments execution when practical. Shell execution remains available only where an explicit command requires shell syntax and the active policy permits it.

The execution result adds the following information without removing compatible v1 fields:

- `executionStatus`: `completed`, `timed_out`, `terminated`, `spawn_failed`, or `blocked`.
- `exitCode` and `signal`.
- `policyDecision` and stable rejection reason codes.
- `runId` and `rawLogPath`.
- `logTruncated`.
- `redactionSummary`.
- `providerStatus`.
- `warnings`.

## Log Lifecycle and Privacy

The default log directory remains `<workspace>/.codex-local-test-runs/` for compatibility and discoverability.

The v2 log store will provide:

- Automatic addition of `.codex-local-test-runs/` to the workspace `.gitignore` without disturbing existing rules.
- Default retention of seven days.
- A configurable disk quota, defaulting to 500 MB.
- Best-effort pruning around new log creation.
- Restrictive file permissions where supported.
- Atomic registry and baseline writes.
- `logs status`, `logs prune`, and `logs purge` lifecycle commands.

Remote inference always receives a redacted, bounded excerpt. Redaction must cover at least common API keys, bearer tokens, authorization headers, credential-bearing URLs, database connection strings, signed URLs, and configured custom patterns.

Two local storage modes are supported:

- `raw-local` stores the complete local log and redacts only outbound inference content. This is the default because it preserves debugging fidelity.
- `redacted-local` redacts content before writing it to disk.

The installer and README must state clearly that `raw-local` logs may contain secrets printed by commands. Analytics, manifests, CLI output, and MCP responses must never include full credentials.

If command execution succeeds but the log cannot be persisted, the result must report the audit failure explicitly. Registry and analytics failures remain best-effort warnings and do not invalidate an otherwise usable run.

## Provider and Credential Model

Provider modes are explicit:

- `local`
- `gateway-token`
- `gateway-byok`
- `openrouter-direct`

`openrouter-direct` sends the credential and redacted excerpt directly to OpenRouter. It is the default BYOK choice for new installations.

`gateway-byok` remains available for gateway-specific routing but requires a clear disclosure that the user's OpenRouter key and selected redacted excerpts pass through the Softaware gateway.

Existing v1 BYOK environment configuration maps to `gateway-byok` and emits a deprecation warning. Migration must not silently change the destination of existing requests.

Credential storage priority is:

1. macOS Keychain, Windows Credential Manager/DPAPI, or Linux Secret Service.
2. Explicitly selected environment-variable storage.
3. Explicitly selected protected configuration-file fallback.

Failure to use the native store must never silently downgrade to plaintext. Where supported, client configuration stores a credential reference and the launcher retrieves the secret only when starting the MCP process.

## Structured LLM Output

Every LLM-backed task has a strict Zod schema:

- Verdict.
- Triage.
- Changed-files review.
- Command digest.
- Scout ranking.
- Log query.

Malformed, oversized, or semantically contradictory output must not be normalized into an optimistic result. The fallback preserves deterministic command facts and returns `uncertain` when interpretation is required. Validation failures may return bounded `validationErrors` and guidance to use deterministic `grep_log` or the smallest necessary raw-log slice.

## Installer Lifecycle

The unified CLI exposes:

- `install --dry-run`
- `install`
- `status`
- `doctor`
- `repair`
- `uninstall --dry-run`
- `uninstall`
- `logs status|prune|purge`

Dry-run and application use the same immutable change-plan representation. A plan reports files, managed blocks, client registrations, credential operations, backups, and removal actions before mutation.

Successful installation writes a manifest identifying installer-owned assets and managed blocks. Uninstall removes only owned assets and managed content. It must preserve user-owned configuration and restore a backup only when doing so cannot discard later user changes.

Critical mutations use backups and a transaction-like rollback sequence. Installer recovery does not claim full filesystem atomicity, but a failed step must identify what was applied, what was rolled back, and what requires manual remediation.

`doctor` is read-only and validates:

- Detected client registrations.
- Installed and generated versions.
- Launcher dependencies.
- Credential references and accessibility without revealing secrets.
- Provider health.
- Effective security profile.
- Legacy configuration.
- LaunchAgent or equivalent platform integration.
- Log directory size and retention state.

`repair` creates and presents a change plan derived from doctor findings before applying fixes.

## Migration Flow

The supported upgrade flow is:

1. Run `token-optimizer doctor` to inspect current state without mutation.
2. Run `token-optimizer install --dry-run` to review migration actions.
3. Run `token-optimizer install --migrate` to create backups, a manifest, and v2 configuration.
4. Run `token-optimizer doctor` to validate the effective installation.
5. Remove legacy credentials only after the new provider path is confirmed healthy.

Migration fixtures must cover v1.12.1 installations for Claude Code, Codex, Antigravity, OpenCode, and Cursor. Repeated migration must be idempotent.

## Licensing and Packaging

The repository and published packages will use Apache-2.0. A root `LICENSE` and any required `NOTICE` file will be added, and package manifests and generated metadata will declare the same license.

The root server dependency on `@softawarest/token-optimizer-installer` will be removed. The installer may package the server, but the server must not depend on the installer.

All release version sources remain aligned, including the root package, installer package, MCP server metadata, five plugin generator constants, generated plugin outputs, and installer assets.

Release packaging will include npm provenance where supported, an SBOM or equivalent dependency inventory, a dry-run tarball audit, and verification that generated outputs match their source inputs.

## Verification Strategy

### Unit and contract tests

- Provider resolution, destination, and precedence.
- Task-specific Zod schemas with malformed, adversarial, and contradictory output.
- Secret redaction across supported token, header, URL, and multiline forms.
- Command-policy decisions for all profiles.
- Retention, quota, and atomic metadata writes.
- Backward-compatible MCP response fixtures.

### Execution integration tests

- Output larger than 50 MB without proportional memory growth.
- Interleaved stdout and stderr.
- Timeout with child and grandchild processes.
- Unix and Windows process-tree termination.
- Disk-full and write-error simulation.
- Unicode, very long lines, and binary-like output.
- Parallel suites with deterministic result ordering.

### Installer tests

Each client is exercised in an isolated fake home directory for:

- Initial and repeated installation.
- Dry-run parity with real application.
- v1 migration.
- Partial-failure rollback.
- Doctor and repair.
- Uninstall.
- Preservation of user-owned configuration.

Platform-specific CI covers macOS, Linux, and Windows behavior.

### Security tests

- Workspace escape and symlink traversal.
- Sensitive-file access.
- Shell metacharacters and injection payloads.
- Nested shell bypass attempts.
- Malicious or malformed LLM output.
- Secret leakage to remote providers.
- Secret leakage through CLI output, analytics, manifests, and logs.

## Production Release Gates

Stable v2.0 requires all of the following:

1. **Security:** threat model, direct provider, mandatory outbound redaction, safe defaults, and security suite.
2. **Reliability:** streamed execution, process-tree termination, bounded memory, and log-lifecycle verification.
3. **Installer:** dry-run parity, idempotent install, doctor, repair, uninstall, and rollback coverage.
4. **Compatibility:** v1.12.1 migration fixtures for all supported clients and documented migration behavior.
5. **Packaging:** Apache-2.0 metadata, removal of the server-to-installer dependency, aligned versions, package audit, provenance, and generated-output checks.
6. **Evidence:** published benchmarks for raw and returned tokens, reduction percentage, peak memory, runtime overhead, provider latency, and redaction counts.
7. **Release candidate:** successful real-project validation on npm, Python, Rust, and Go projects before stable release.

## Documentation Requirements

The README will begin with a before-and-after execution flow and include a privacy table covering every provider mode. It will document:

- Where inference runs.
- Where code and log excerpts are sent.
- Where credentials are sent and stored.
- Execution profiles and their limitations.
- Log retention and purge behavior.
- Installer mutations and rollback behavior.
- v1-to-v2 migration.
- Benchmark methodology.

`skill/skill-example.md`, installer documentation, generated plugin documentation, MCP tool schemas, and server behavior must remain consistent in the same release change.

## Out of Scope

The following are excluded from v2.0:

- General conversation-history optimization.
- Semantic repository indexing.
- A complete container or virtual-machine sandbox.
- OpenTelemetry backend integration.
- A hosted analytics dashboard.
- New MCP tools unrelated to security, reliability, log lifecycle, or installation lifecycle.

The existing analytics dashboard may receive only the changes required for privacy compliance and production benchmarks.

## Success Criteria

The v2 release is successful when a new user can preview and install it without hidden mutations, use direct or local inference without ambiguous credential routing, run large commands with bounded memory, understand and control command privileges and log retention, diagnose installation health, uninstall cleanly, and verify every pass/fail claim through authoritative process results and locally stored audit artifacts.
