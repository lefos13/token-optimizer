# Token Optimizer v2 Production Handoff

**Handoff date:** 2026-07-13  
**Repository:** `lefos13/token-optimizer`  
**Integrated branch:** `main`  
**Current package version:** `2.0.0-rc.6`  
**Production status:** release candidate; not yet published or declared production-ready

## Executive status

The complete v2 production-hardening program has been merged into `main`. The
implementation is feature-complete for the planned trust, execution, installer,
packaging, security, and benchmark work. The remaining work is release validation
on real environments and the explicit human-governed transition from RC to stable.

No `v2.0.0` tag has been created, no npm package has been published, and no live
client configuration or credential store was changed as part of the final merge.

## Verified release-candidate evidence

- Full automated suite: **371/371 passing**.
- Security boundary suite: **55/55 passing**.
- `npm run build`: passing.
- Plugin and installer generation: passing and version-aligned.
- `RELEASE_TAG=v2.0.0-rc.6 npm run release:preflight`: passing.
- `npm audit --omit=dev`: zero vulnerabilities at verification time.
- `npm pack ./packages/installer --dry-run`: passing.
- Final independent spec review: approved.
- Final independent code/security review: approved.
- Near-limit aggregate custom-redaction workload: approximately 40 ms in the
  isolated regression fixture, with a one-second hard timeout.

These results describe the merged source tree before the documentation-only
handoff commit. Re-run the preflight from a clean tree before tagging.

## Implemented roadmap

### Trust, privacy, and provider boundaries — complete

- Explicit provider modes: `local`, `gateway-token`, `gateway-byok`, and
  `openrouter-direct`.
- Direct OpenRouter mode bypasses the Softaware gateway.
- Gateway BYOK is explicitly disclosed and legacy configuration preserves its
  previous destination with compatibility warnings.
- Provider destination, model routing, and credential-bearing origin are
  user-authoritative; repository/tool layers cannot redirect credentials.
- Remote inference receives bounded, redacted excerpts.
- Mandatory user redaction rules are preserved; lower-trust rules are additive.
- Custom patterns use a restricted grammar, a 1 MiB input bound, a per-pattern
  expanded-width bound, and a 64-unit aggregate work budget across the effective
  user/project/tool rule set.
- Real outbound-request tests prove accumulated user and project rules redact the
  final remote inference payload.
- Configuration files are capped at 64 KiB and read through one validated file
  descriptor. POSIX user policy files require private ownership and permissions.
- The Windows lack of `O_NOFOLLOW` and the residual same-path race are documented
  rather than hidden.

### Command execution and log reliability — complete

- Streamed `spawn()` execution replaces the original 50 MB `exec()` buffer path.
- Full output streams to managed logs while bounded excerpts remain in memory.
- Timeout and termination states are explicit and process-tree termination is
  platform-aware.
- Execution profiles and command allowlists implement a deny-first policy ceiling.
- User configuration is the maximum privilege level; project and tool layers may
  narrow but not elevate it.
- Log writes are atomic and audit failures are surfaced.
- Retention, quota, `.gitignore`, prune, and purge behavior are implemented.
- Active leases prevent pruning logs that are still in use.
- Raw-local and redacted-local storage semantics are documented.

### Installer and credential lifecycle — complete

- `install --dry-run` and apply share the same planned operations.
- Native credential storage is implemented for macOS, Windows, and Linux, with
  fail-closed behavior rather than silent plaintext fallback.
- Migration, status, doctor, repair, uninstall, and log lifecycle commands exist.
- Installer operations use manifests, ownership metadata, backups, rollback, and
  client-specific lifecycle adapters.
- Fake-home fixtures cover Claude, Codex, Antigravity, OpenCode, and Cursor.
- Repair and uninstall preserve user-modified or unowned files.
- The original protected-folder crash was addressed by scoped discovery: the
  installer does not recursively enumerate unrelated home folders such as Music.

### Packaging, security gates, and release hygiene — complete

- Repository and installer use Apache-2.0 with `LICENSE` and `NOTICE` files.
- The MCP server no longer has a runtime dependency on the installer package.
- CI covers supported operating systems and Node versions.
- Publish workflow is tag-gated and configured for npm provenance.
- Release preflight verifies version alignment, generated assets, package
  inventory, dependency policy, SBOM schema, and working-tree state.
- Security tests cover command, inference, installer, and gateway boundaries.
- A maintained threat model records mitigations and residual risks.
- Benchmark fixtures and recorded RC evidence cover token savings, runtime, and
  bounded-memory behavior. The large-output benchmark uses actual MCP stdio and a
  local mock provider rather than a simulated shortcut.

## Remaining work before `v2.0.0`

### P0 — required stable-release gates

1. Run real-workspace RC validation on npm, Python, Rust, and Go projects. Rust and
   Go were skipped in the existing recorded benchmark environment because those
   toolchains were unavailable.
2. Validate the packaged installer, not only repository source, through this flow:
   dry-run, install, status, strict doctor, one successful tool call, one failed
   tool call with triage, log status/prune, uninstall dry-run, and uninstall.
3. Test migration and rollback from the latest public v1 package using the packed
   RC tarball on representative macOS, Linux, and Windows environments.
4. Run GitHub Actions for the merged `main` commit and confirm every OS/Node matrix
   job, audit, SBOM, package, and generated-drift check passes.
5. Create the missing release evidence documents:
   `docs/releases/v2.0.0-validation.md` and
   `docs/releases/v2.0.0-migration.md`, including commands, environments, outcomes,
   hashes, known limitations, rollback steps, and evidence links.
6. Produce final npm tarball and SBOM hashes from the exact stable candidate commit.
7. Remove prerelease suffixes and align every authoritative version source to
   `2.0.0`; regenerate plugins and installer assets; rerun the complete suite and
   `RELEASE_TAG=v2.0.0 npm run release:preflight` from a clean tree.
8. Obtain explicit human approval before creating the stable tag or publishing.

### P1 — live Mac cleanup and installation verification

The token shown in the earlier terminal transcript must be treated as exposed even
if it was a placeholder. Revoke or rotate any real gateway token used during that
attempt. Do not copy the old value into tests, documentation, commits, or chat.

On the maintainer Mac:

1. Inspect and remove the stale Codex marketplace/plugin registration only after
   confirming ownership, for example the previously observed
   `token-optimizer@Softaware-marketplace` entry.
2. Inspect the macOS Keychain service `token-optimizer` and accounts such as
   `gateway-token` or fixture names. Delete only entries confirmed to belong to
   this installer; an earlier investigation observed an item but did not prove its
   value or ownership, so it was intentionally not deleted.
3. Install the packed RC with Keychain storage and a newly issued credential.
4. Run `status` and `doctor --strict`, then verify all five supported clients.
5. Confirm install/uninstall never requests access to unrelated protected folders
   and leaves no owned LaunchAgent, environment, marketplace, or asset residue.

### P2 — post-release improvements

- Add native Windows reparse-point/no-follow protection if a reliable Node-level
  implementation is adopted; until then retain the documented limitation.
- Collect broader real-world benchmark samples and publish claims only for measured
  workloads.
- Consider signed release artifacts beyond npm provenance.
- Add release telemetry/operational dashboards only if the privacy contract and
  opt-out behavior remain explicit.
- Remove legacy v1 environment compatibility only in a future major version.

## Recommended continuation sequence

1. Start from a clean, updated `main` and read `AGENTS.md`.
2. Read the design, roadmap, four implementation plans, threat model, benchmark
   methodology, and this handoff document.
3. Create a new `codex/v2-stable-validation` branch and a separate worktree.
4. Implement only documentation/fixture changes needed to record real RC
   validation; do not weaken gates to make them pass.
5. Run the packed-installer matrix and real ecosystem validation in parallel where
   safe, recording OS, architecture, Node/toolchain versions, package hashes, and
   exact outcomes.
6. Have independent agents review the validation evidence and stable-version diff.
7. Prepare, but do not publish, the `2.0.0` commit and tag proposal.
8. Stop for explicit maintainer approval before tag creation and npm publishing.

## Authoritative documents for the next session

- Overall design: `docs/superpowers/specs/2026-07-10-production-readiness-v2-design.md`
- Program roadmap: `docs/superpowers/plans/2026-07-10-production-readiness-v2-roadmap.md`
- Trust/provider plan: `docs/superpowers/plans/2026-07-10-v2-trust-provider-plan.md`
- Execution/log plan: `docs/superpowers/plans/2026-07-10-v2-execution-logs-plan.md`
- Installer lifecycle plan: `docs/superpowers/plans/2026-07-10-v2-installer-lifecycle-plan.md`
- Release-readiness plan: `docs/superpowers/plans/2026-07-10-v2-release-readiness-plan.md`
- Threat model: `docs/security/threat-model.md`
- Benchmark methodology: `benchmarks/README.md`
- Recorded benchmark evidence: `benchmarks/results/v2.0.0-rc.1.json` and
  `benchmarks/results/v2.0.0-rc.2.json`
- Product and operational documentation: `README.md` and
  `packages/installer/README.md`
- Agent-facing tool contract: `skill/skill-example.md`

The older dated plans under `docs/superpowers/plans/` and designs under
`docs/superpowers/specs/` remain useful historical context. The documents listed
above plus this handoff are authoritative for completing v2.

## Git state at handoff

- Production-hardening source branch: `codex/v2-production-hardening`.
- Last hardening commit: `c177015` (`fix: bound aggregate redaction work`).
- Merge commit on `main`: `d9e18a0` (`merge: integrate v2 production hardening rc.6`).
- The documentation handoff is intentionally a separate commit after that merge.
- Old worktrees may still exist at sibling paths such as `local-tester-mcp-v2`,
  `local-tester-mcp-v2-correct`, and `local-tester-mcp-production`. Remove them only
  after confirming they are clean and every unique commit is reachable from main.

## Release authority boundary

Merging this release candidate into `main` does not authorize any of the following:

- creating or pushing `v2.0.0` or another release tag;
- publishing either npm package;
- changing live gateway configuration;
- deleting ambiguous credentials or user-owned client configuration;
- describing the product as production-ready before the stable gates above have
  recorded evidence.

Those actions require a fresh explicit maintainer decision.
