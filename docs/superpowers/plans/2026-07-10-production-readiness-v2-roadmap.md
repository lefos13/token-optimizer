# Token Optimizer v2 Production-Readiness Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Token Optimizer v2.0.0 with explicit trust boundaries, bounded-memory execution, a reversible installer lifecycle, and evidence-backed release gates.

**Architecture:** The program is split into four sequential sub-projects so each milestone produces working, testable, installable software. Public MCP names remain stable; new result fields are additive, while legacy configuration is interpreted by a compatibility layer with explicit warnings.

**Tech Stack:** TypeScript 5.3, Node.js 20/24, MCP SDK, Zod 4 with `zod/v3` compatibility, Node test runner, cross-platform JavaScript installer, GitHub Actions, npm provenance.

## Global Constraints

- New installations default to execution profile `safe`, log retention `7` days, disk quota `500` MB, and local storage mode `raw-local`.
- Provider modes are exactly `local`, `gateway-token`, `gateway-byok`, and `openrouter-direct`.
- User-owned configuration is the privilege ceiling; project configuration and MCP arguments may narrow but never elevate execution privileges.
- Non-zero exit codes remain authoritative and no LLM result may convert them to success.
- Every outbound remote inference excerpt is redacted before transmission.
- Existing MCP tool names and compatible v1 result fields remain available throughout v2.x.
- Root package, installer package, MCP metadata, five generator versions, generated plugins, and installer assets remain version-aligned at every milestone merge.
- TypeScript changes require `npm run build`, `npm test`, and `npm run build:plugin`; installer assets require `npm run build:installer` and `npm pack ./packages/installer --dry-run` at milestone checkpoints.
- Do not manually edit generated files under `plugin/` or `packages/installer/assets/`.
- Large added or modified code sections begin with concise block comments using `/* ... */`.
- Raw test logs and baseline files under `.codex-local-test-runs/` are never committed.

---

## Dependency Graph

```text
Plan 1: Trust and provider foundation (v2.0.0-alpha.1)
  └── Plan 2: Execution and log reliability (v2.0.0-alpha.2)
        └── Plan 3: Installer lifecycle and credentials (v2.0.0-beta.1)
              └── Plan 4: Release evidence and packaging (v2.0.0-rc.1 → v2.0.0)
```

## Planned File Ownership

| Responsibility | Primary files |
|---|---|
| Layered configuration and privilege ceiling | `src/config.ts`, `src/types.ts` |
| Provider selection and transport metadata | `src/providers.ts`, `src/llm.ts` |
| Secret detection and replacement | `src/redaction.ts` |
| LLM response boundary validation | `src/llm-schemas.ts` |
| Command authorization | `src/command-policy.ts` |
| Bounded stream excerpts | `src/log-excerpt.ts` |
| Process-tree termination | `src/process-tree.ts` |
| Execution orchestration | `src/runner.ts` |
| Log retention, quota, and registry | `src/log-store.ts`, `src/registry.ts` |
| MCP schema and response compatibility | `src/index.ts`, `src/types.ts` |
| Installer planning and rollback | `packages/installer/lib/change-plan.js`, `packages/installer/lib/apply-plan.js` |
| Installer ownership state | `packages/installer/lib/manifest.js` |
| Native and fallback credential stores | `packages/installer/lib/credential-store*.js` |
| Installer health and remediation | `packages/installer/lib/doctor.js`, `packages/installer/lib/uninstall.js` |
| Standalone installer log commands | `packages/installer/lib/logs.js` |
| Release policy and evidence | `scripts/release-preflight.js`, `scripts/run-benchmarks.js`, `.github/workflows/` |

## Specification Coverage

| Design requirement | Implemented by |
|---|---|
| Explicit providers and direct OpenRouter | Trust plan Tasks 1 and 3 |
| Gateway BYOK disclosure and legacy destination preservation | Trust plan Tasks 3 and 6; installer plan Task 4 |
| Mandatory outbound redaction | Trust plan Tasks 2 and 5 |
| Task-specific Zod validation | Trust plan Task 4 |
| Security-aware configuration ceiling | Trust plan Task 1; execution plan Task 1 |
| Safe, standard, and unrestricted profiles | Execution plan Task 1 |
| Streamed spawn and bounded memory | Execution plan Tasks 2 and 4 |
| Process-tree timeout handling | Execution plan Task 3 |
| Retention, quota, atomic metadata, and both storage modes | Execution plan Task 5 |
| Additive MCP execution results | Execution plan Task 6 |
| Dry-run parity, manifests, rollback, and ownership | Installer plan Tasks 1 and 2 |
| Native credentials without silent plaintext fallback | Installer plan Task 3 |
| Migration, status, doctor, repair, uninstall, and logs CLI | Installer plan Tasks 4 through 6 |
| Apache-2.0 and dependency cleanup | Release plan Task 1 |
| Threat model and adversarial coverage | Release plan Task 2 |
| Cross-platform CI, audit, SBOM, and provenance | Release plan Task 3 |
| Benchmarks and evidence-backed claims | Release plan Task 4 |
| RC validation, migration guide, and stable approval gate | Release plan Task 5 |

## Sub-Project Plans

1. [Trust and provider foundation](./2026-07-10-v2-trust-provider-plan.md)
2. [Execution and log reliability](./2026-07-10-v2-execution-logs-plan.md)
3. [Installer lifecycle and credentials](./2026-07-10-v2-installer-lifecycle-plan.md)
4. [Release evidence and packaging](./2026-07-10-v2-release-readiness-plan.md)

## Program Checkpoints

### Checkpoint A: v2.0.0-alpha.1

- [ ] Direct OpenRouter calls bypass the Softaware gateway.
- [ ] Legacy BYOK configuration still selects `gateway-byok` and emits a bounded warning.
- [ ] Remote inference cannot receive recognized unredacted secrets.
- [ ] Every LLM-backed response is validated by a task-specific schema.
- [ ] Provider behavior, README privacy matrix, skill instructions, and generated plugins agree.

### Checkpoint B: v2.0.0-alpha.2

- [ ] Command output streams to disk with bounded in-memory excerpts.
- [ ] Timeouts terminate child and grandchild processes on supported platforms.
- [ ] The security profile blocks workspace escape and sensitive paths.
- [ ] Retention, quota, purge, and `.gitignore` behavior are deterministic.
- [ ] Existing MCP consumers still receive their compatible v1 fields.

### Checkpoint C: v2.0.0-beta.1

- [ ] Dry-run and apply use the same immutable change plan.
- [ ] Install, migration, status, doctor, repair, and uninstall are idempotent.
- [ ] Native credential-store failure never silently falls back to plaintext.
- [ ] Fake-home fixtures cover Claude, Codex, Antigravity, OpenCode, and Cursor.
- [ ] Partial failures produce rollback and remediation evidence.

### Checkpoint D: v2.0.0-rc.1

- [ ] Apache-2.0 applies consistently to repository and packages.
- [ ] The server no longer depends on the installer package.
- [ ] Linux, macOS, and Windows CI pass build, tests, package audit, and installer fixtures.
- [ ] Benchmarks demonstrate bounded memory and report token savings with methodology.
- [ ] npm tarball, provenance, SBOM, and generated-asset verification pass.

### Stable Release Gate: v2.0.0

- [ ] RC validation succeeds on representative npm, Python, Rust, and Go workspaces.
- [ ] No unresolved critical/high reachable dependency vulnerability remains.
- [ ] Migration and rollback instructions are tested from the published tarball.
- [ ] Public documentation contains no production-readiness claim unsupported by a recorded gate result.

## Review and Execution Policy

Each task follows red-green-refactor discipline, ends with a focused commit, and receives a changed-files review before the next task. Each sub-project runs the complete suite and packaging checks before its milestone merge. `run_regression_check` is used only when intentionally updating the repository baseline; ordinary validation uses `run_test_verdict` with explicit commands.
