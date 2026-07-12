# Token Optimizer threat model

## Scope, assets, and actors

Protected assets are workspace files, command output and logs, credentials, installer-owned files, provider requests, and privacy-preserving analytics. Actors include the user, an honest or compromised MCP client, malicious repository content and prompt injection, the gateway operator, BYOK upstream operators, package publishers, and a local attacker able to create files or symlinks in writable roots.

Trust boundaries exist between MCP input and command execution; repository bytes and inference prompts; the final local-to-remote provider hop; gateway and OpenRouter; installer plans and filesystem/native credential stores; package registry and installed launcher; and raw local logs versus shared analytics.

## Threats, controls, and evidence

| Threat | Control | Deterministic evidence |
| --- | --- | --- |
| Compromised MCP client, prompt injection, malicious repository, arbitrary command profiles | Shell-state scanning in `src/command-policy.ts` follows POSIX quote/backslash rules and fails closed on unmatched quotes; all profiles deny unquoted composition, substitution, and redirection. Literal percent encoding is not decoded because the shell transport does not decode it. `src/runner.ts` evaluates before spawn and `src/process-tree.ts` kills descendants. | `test/security/command-boundary.test.ts`, `test/client/command-policy.test.ts`, `test/client/process-tree.test.ts` |
| Workspace escape, symlink and path attacks | Canonical ancestor resolution in `src/command-policy.ts`, `src/log-store.ts`, `src/registry.ts`, and `src/analytics.ts`; symlinks leaving the workspace are rejected before read/write/spawn. | `test/security/command-boundary.test.ts`, `test/client/log-store.test.ts`, `test/client/analytics-share.test.ts` |
| Command output contains secrets | `src/redaction.ts` redacts recognized credentials at the final remote hop. Raw-local logs are mode `0600`; redacted-local storage is available. | `test/security/inference-boundary.test.ts`, `test/client/inference-privacy.test.ts`, `test/client/redaction.test.ts` |
| Malicious, malformed, oversized, or contradictory LLM output | `src/llm-schemas.ts` bounds and validates structured output; `src/llm.ts` falls back conservatively; command exit codes in `src/index.ts` remain authoritative. | `test/security/inference-boundary.test.ts`, `test/client/llm-schemas.test.ts`, `test/client/llm-usage.test.ts` |
| Gateway operator or BYOK trust | Remote modes intentionally disclose redacted excerpts and routing metadata to the configured gateway; gateway-BYOK also discloses the BYOK key to that operator and OpenRouter. Direct mode discloses both only to OpenRouter. | `test/client/provider.test.ts`, `test/gateway/byok.test.ts`, `test/gateway/auth.test.ts` |
| Native credential-store failure | `packages/installer/lib/credential-store*.js` fails closed; it never silently writes plaintext. | `test/installer/credential-store.test.ts`, `test/security/installer-boundary.test.ts` |
| Installer migration, ownership, repair, uninstall, and custom marketplace data | Declarative secret-free plans, transactional rollback, manifests and hashes limit mutation/removal to installer-owned content; managed edits preserve unrelated user data. | `test/security/installer-boundary.test.ts`, `test/installer/migration.test.ts`, `test/installer/repair.test.ts`, `test/installer/uninstall.test.ts`, `test/installer/install-core.test.ts` |
| Package supply chain | Lockfile, generated-asset inventory checks, and aligned release versions are deterministic gates; launchers install only the declared runtime dependency. Pack inspection and registry audit are separate release-preflight commands described below. | `test/scripts/package-hygiene.test.ts`, `test/scripts/plugin-generators.test.ts`, `test/scripts/release-versions.test.ts` |
| Analytics privacy | `src/analytics.ts` stores compact metadata locally and shares an explicit aggregate allowlist without commands, paths, prompts, logs, responses, or fallback text. | `test/security/inference-boundary.test.ts`, `test/client/analytics-share.test.ts` |
| Provider-health abuse | `gateway/src/server.ts` rate-limits by client address and credential fingerprint, bounds concurrency, and times out upstream probes. | `test/gateway/server.test.ts`, `test/gateway/rate-limit.test.ts` |
| Release tests accidentally use developer state | `scripts/run-tests.js` clears provider credentials; security fixtures inject HTTP/native adapters, bind gateway servers to an ephemeral loopback port, and give spawned installers a disposable `HOME`. | `test/security/inference-boundary.test.ts`, `test/security/gateway-boundary.test.ts`, `test/security/installer-boundary.test.ts` |

## Residual risks

Safe mode is a policy boundary, not an OS sandbox. An allowed compiler, test runner, package script, or binary can itself execute arbitrary code with the server user's privileges. Repository dependencies may be malicious, shell/platform parsing can have undiscovered variants, raw-local logs can retain novel secret formats, remote operators can observe permitted metadata, and a compromised package registry or developer machine remains outside these controls. Use an OS sandbox/container and least-privilege credentials for hostile repositories; inspect detected scripts before allowing them; prefer local inference and redacted-local logs for sensitive work; and treat unrestricted mode as explicit high trust.

`npm run test:security` is deterministic and offline. Supply-chain release preflight is separate: run `npm pack ./packages/installer --dry-run` to inspect the package inventory and `npm audit --audit-level=high` to query the current registry advisory database; the latter is network- and time-dependent.
