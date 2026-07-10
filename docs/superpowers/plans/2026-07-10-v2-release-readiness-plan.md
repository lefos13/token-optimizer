# Token Optimizer v2 Release Evidence and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the feature-complete beta into an auditable release candidate and a stable v2.0.0 package backed by security, compatibility, performance, and packaging evidence.

**Architecture:** Release checks become deterministic scripts and CI gates rather than prose-only promises. The published installer is built from aligned sources, audited as a tarball, accompanied by provenance and an SBOM, and validated against representative ecosystem workspaces.

**Tech Stack:** Node.js, GitHub Actions, npm provenance, CycloneDX npm SBOM output, Node test runner, benchmark fixtures for npm/Python/Rust/Go.

## Global Constraints

- This plan depends on `2.0.0-beta.1`, produces `2.0.0-rc.1`, and stops for explicit human approval before publishing `2.0.0`.
- Repository and published packages use `Apache-2.0` consistently.
- The MCP server must not depend on the installer package.
- Release CI runs on Linux, macOS, and Windows with supported Node versions.
- No production-readiness or token-savings claim may exceed recorded evidence.
- Benchmarks report raw tokens, returned tokens, savings percentage, peak RSS, runtime overhead, provider latency, and redaction counts.
- Reachable critical/high dependency vulnerabilities block stable release.
- Generated outputs, installer assets, and source version metadata must be aligned before package creation.

---

### Task 1: Apply Apache-2.0 and remove the server-to-installer dependency

**Files:**
- Create: `LICENSE`
- Create: `NOTICE`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/installer/package.json`
- Test: `test/scripts/package-hygiene.test.ts`

**Interfaces:**
- Produces: consistent package license metadata and an acyclic runtime dependency graph.

- [ ] **Step 1: Write failing package-hygiene tests**

```typescript
test('published packages use Apache-2.0 and server does not depend on installer', () => {
  assert.equal(rootPackage.license, 'Apache-2.0');
  assert.equal(installerPackage.license, 'Apache-2.0');
  assert.ok(!rootPackage.dependencies?.['@softawarest/token-optimizer-installer']);
  assert.match(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'), /Apache License/);
});
```

- [ ] **Step 2: Confirm current manifests fail hygiene tests**

Run: `npm test -- --test-name-pattern="Apache-2.0|server does not depend"`

Expected: root license is absent, installer is `UNLICENSED`, and the old installer dependency exists.

- [ ] **Step 3: Add license files and clean package metadata**

Set both manifests to `"license": "Apache-2.0"`, remove `@softawarest/token-optimizer-installer` from root dependencies, and update the lockfile through the repository-approved dependency workflow. `NOTICE` identifies the project and copyright holder without adding restrictions beyond Apache-2.0.

- [ ] **Step 4: Verify dependency and package hygiene**

Run: `npm test -- --test-name-pattern="package hygiene|release version"`

Expected: license and dependency assertions pass.

Run: `npm ls --all`

Expected: dependency graph resolves without missing or invalid packages.

- [ ] **Step 5: Commit licensing and dependency cleanup**

```bash
git add LICENSE NOTICE package.json package-lock.json packages/installer/package.json test/scripts/package-hygiene.test.ts
git commit -m "chore: license v2 and remove installer dependency"
```

### Task 2: Add the threat model and security regression gate

**Files:**
- Create: `docs/security/threat-model.md`
- Create: `test/security/command-boundary.test.ts`
- Create: `test/security/inference-boundary.test.ts`
- Create: `test/security/installer-boundary.test.ts`
- Modify: `README.md`

**Interfaces:**
- Documents: assets, actors, trust boundaries, abuse cases, mitigations, residual risk, and non-sandbox limitations.
- Produces: a test group runnable with the Node test-name pattern `security boundary`.

- [ ] **Step 1: Add failing end-to-end security fixtures**

```typescript
test('security boundary blocks workspace escape before spawn', async () => {
  const result = await invokeDigest({ workspacePath: fixtureRoot, command: 'cat ../secret' });
  assert.equal(result.executionStatus, 'blocked');
  assert.equal(spawnAdapter.calls.length, 0);
});

test('security boundary redacts provider and installer output', async () => {
  const evidence = await captureBoundaryEvidence('sk-or-fixture-secret');
  assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret/);
});
```

- [ ] **Step 2: Run the security group and record any integration gaps**

Run: `npm test -- --test-name-pattern="security boundary"`

Expected: any missing integration between policy, redaction, provider, and installer fails as a reproducible fixture rather than an informal audit finding.

- [ ] **Step 3: Complete the threat model and close fixture gaps**

The threat model must cover compromised MCP clients, prompt injection, malicious repositories, command output containing secrets, gateway operator trust, credential-store failure, symlink attacks, package supply chain, analytics leakage, and user-selected unrestricted mode. Each mitigation links to a concrete module and test name; residual risks state that safe mode is policy enforcement, not OS isolation.

- [ ] **Step 4: Run security and full regression tests**

Run: `npm test -- --test-name-pattern="security boundary|redact|policy|credential|migration"`

Expected: all boundary tests pass.

Run: `npm test`

Expected: complete suite passes.

- [ ] **Step 5: Commit threat model and security gate**

```bash
git add docs/security README.md test/security
git commit -m "test: add v2 security boundary gate"
```

### Task 3: Add cross-platform CI, audit, SBOM, and provenance checks

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/publish-npm.yml`
- Create: `scripts/verify-generated-assets.js`
- Create: `scripts/release-preflight.js`
- Modify: `package.json`
- Test: `test/scripts/release-preflight.test.ts`

**Interfaces:**
- Produces: `npm run release:preflight`, deterministic generated-asset verification, and a tag-gated provenance publish workflow.

- [ ] **Step 1: Write failing preflight tests**

```typescript
test('preflight rejects version or generated-asset drift', () => {
  const result = runPreflight(fixtureWithStalePlugin());
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(failure => failure.code === 'GENERATED_ASSET_DRIFT'));
});

test('publish workflow requires a v2 tag and provenance', () => {
  assert.match(workflow, /tags:\s*\n\s*- ['"]v\*['"]/);
  assert.match(workflow, /npm publish --provenance --access public/);
});
```

- [ ] **Step 2: Confirm current main-branch workflow fails release policy**

Run: `npm test -- --test-name-pattern="preflight|publish workflow"`

Expected: current workflow publishes from `main` and no preflight script exists.

- [ ] **Step 3: Implement deterministic release checks**

```javascript
function runPreflight(root) {
  return combineChecks([
    checkCleanWorkingTree(root),
    checkAlignedVersions(root),
    checkGeneratedAssets(root),
    checkPackageInventory(root),
    checkSbom(root),
    checkAuditPolicy(root),
  ]);
}
```

CI uses a Linux/macOS/Windows matrix, runs `npm ci`, build, full tests, plugin/installer generation, and tarball audit. Dependency audit fails for reachable critical/high findings; any documented exception includes package, reachability assessment, owner, and review date. Publish runs only from an approved version tag with GitHub OIDC `id-token: write` and npm provenance.

- [ ] **Step 4: Verify workflows and preflight locally**

Run: `npm test -- --test-name-pattern="preflight|workflow|generated asset"`

Expected: script and workflow contract tests pass.

Run: `npm run release:preflight`

Expected: succeeds on a clean, fully generated tree and writes the SBOM to the configured release-artifacts directory.

- [ ] **Step 5: Commit release automation**

```bash
git add .github/workflows scripts/verify-generated-assets.js scripts/release-preflight.js package.json test/scripts/release-preflight.test.ts
git commit -m "ci: gate v2 packages with provenance checks"
```

### Task 4: Build the benchmark suite and prepare v2.0.0-rc.1

**Files:**
- Create: `benchmarks/README.md`
- Create: `benchmarks/fixtures/npm/package.json`
- Create: `benchmarks/fixtures/python/run.py`
- Create: `benchmarks/fixtures/rust/Cargo.toml`
- Create: `benchmarks/fixtures/rust/src/main.rs`
- Create: `benchmarks/fixtures/go/go.mod`
- Create: `benchmarks/fixtures/go/main.go`
- Create: `scripts/run-benchmarks.js`
- Create: `test/scripts/benchmarks.test.ts`
- Modify: `package.json`
- Modify: `packages/installer/package.json`
- Modify: `src/index.ts`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Regenerate: `plugin/claude/`
- Regenerate: `plugin/codex/`
- Regenerate: `.claude-plugin/marketplace.json`
- Regenerate: `.agents/plugins/marketplace.json`
- Regenerate: `packages/installer/assets/`

**Interfaces:**
- Produces: benchmark JSON records with workload, command, raw/returned tokens, savings, peak RSS, duration, overhead, provider latency, and redaction count.
- Produces: aligned `2.0.0-rc.1` package assets.

- [ ] **Step 1: Write failing benchmark-schema and bounded-memory tests**

```typescript
test('benchmark record contains required evidence', () => {
  assert.deepEqual(Object.keys(validateBenchmarkRecord(record).data).sort(), REQUIRED_BENCHMARK_FIELDS.sort());
});

test('large npm workload stays below the memory ceiling', async () => {
  const result = await runBenchmark('npm-large-output');
  assert.ok(result.peakRssDeltaMb < 100);
  assert.ok(result.savingsPercentage > 0);
});
```

- [ ] **Step 2: Confirm benchmark tooling is absent**

Run: `npm test -- --test-name-pattern="benchmark record|memory ceiling"`

Expected: benchmark runner and schema are missing.

- [ ] **Step 3: Implement reproducible fixtures and measurements**

```javascript
const record = {
  schemaVersion: 1,
  workload: fixture.name,
  command: fixture.command,
  rawTokens: estimateTokens(run.rawSourceBytes),
  returnedTokens: estimateTokens(run.responseText.length),
  savingsPercentage: percentageSaved(run),
  peakRssDeltaMb: memory.peakDeltaMb,
  durationMs: run.durationMs,
  overheadMs: run.durationMs - baseline.durationMs,
  providerLatencyMs: run.providerLatencyMs,
  redactionCount: run.redactionCount,
};
```

Fixtures generate deterministic noisy success and failure output without network access. `benchmarks/README.md` records hardware, Node version, provider mode, model, repetitions, warm-up, aggregation, and known limitations.

- [ ] **Step 4: Bump to rc.1, generate assets, and record evidence**

Set every release source to `2.0.0-rc.1`.

Run: `npm run build`

Expected: succeeds.

Run: `npm test`

Expected: complete suite passes.

Run: `npm run build:plugin`

Expected: generated clients carry rc.1.

Run: `npm run build:installer`

Expected: installer assets carry rc.1.

Run: `node scripts/run-benchmarks.js --output benchmarks/results/v2.0.0-rc.1.json`

Expected: every available ecosystem fixture produces a schema-valid record; unavailable toolchains are reported as skipped, not passed.

Run: `npm run release:preflight`

Expected: package, audit, SBOM, version, and generated-asset gates pass.

- [ ] **Step 5: Review and commit the release candidate**

```bash
git add benchmarks scripts test package.json package-lock.json packages src README.md skill plugin .agents .claude-plugin
git commit -m "chore: prepare v2.0.0-rc.1 release candidate"
```

### Task 5: Validate the RC and prepare stable v2.0.0

**Files:**
- Create: `docs/releases/v2.0.0-validation.md`
- Create: `docs/releases/v2.0.0-migration.md`
- Modify: `README.md`
- Modify: `packages/installer/README.md`
- Modify: `skill/skill-example.md`
- Modify: `package.json`
- Modify: `packages/installer/package.json`
- Modify: `src/index.ts`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Regenerate: `plugin/claude/`
- Regenerate: `plugin/codex/`
- Regenerate: `.claude-plugin/marketplace.json`
- Regenerate: `.agents/plugins/marketplace.json`
- Regenerate: `packages/installer/assets/`
- Test: `test/scripts/release-versions.test.ts`

**Interfaces:**
- Produces: signed-off gate evidence, migration/rollback instructions, and a publish-ready but not yet published `2.0.0` tarball.

- [ ] **Step 1: Validate the packed RC against representative workspaces**

For one npm, Python, Rust, and Go workspace, record exact project revision, platform, commands, peak memory, install dry-run, install, doctor, representative tool call, logs prune, uninstall dry-run, and uninstall. Each ecosystem must demonstrate both a successful command and a failing command whose exit code remains authoritative.

- [ ] **Step 2: Run the final cross-platform and security gates**

Run: `npm test`

Expected: complete suite passes.

Run: `npm run release:preflight`

Expected: build, tests, audit policy, SBOM, package inventory, version alignment, and generated assets pass.

Run: `npm pack ./packages/installer --dry-run`

Expected: package inventory matches the reviewed RC inventory.

- [ ] **Step 3: Write validation and migration evidence**

`docs/releases/v2.0.0-validation.md` records every gate with command, date, platform, artifact hash, and result. `docs/releases/v2.0.0-migration.md` documents doctor, dry-run, migrate, post-migration doctor, credential cleanup, rollback, and compatibility warnings using tested CLI output.

- [ ] **Step 4: Align stable version and regenerate once**

Set every release source to `2.0.0`, regenerate plugins and installer assets, rerun full tests and preflight, and produce the final tarball. Do not publish, tag, push, or create a GitHub release without explicit user authorization after reviewing the final evidence.

- [ ] **Step 5: Commit the stable release candidate state**

```bash
git add docs README.md skill package.json package-lock.json packages src scripts test plugin .agents .claude-plugin
git commit -m "chore: prepare Token Optimizer v2.0.0"
```

- [ ] **Step 6: Stop for release approval**

Present the final commit, tarball filename and SHA-256, SBOM path, audit result, benchmark summary, platform matrix, migration results, and remaining risks. Publishing and tagging require a separate explicit approval.
