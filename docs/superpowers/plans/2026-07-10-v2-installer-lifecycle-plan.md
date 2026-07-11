# Token Optimizer v2 Installer Lifecycle and Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every installer mutation previewable, attributable, repairable, and removable while moving credentials to explicit native or user-approved storage.

**Architecture:** The installer builds an immutable operation plan, applies it through typed operation handlers, and records installer-owned state in a manifest. Doctor reads effective state, repair derives a new plan from findings, and uninstall removes only manifest-owned assets and managed blocks.

**Tech Stack:** Cross-platform Node.js CommonJS, filesystem APIs, `spawnSync` with argument arrays, macOS `security`, Linux `secret-tool`, Windows PowerShell DPAPI, Node test runner.

## Global Constraints

- This plan depends on `2.0.0-alpha.2` and produces `2.0.0-beta.1`.
- Dry-run and apply consume the same `ChangePlan`; dry-run performs no filesystem, process, environment, or credential mutation.
- Native credential-store failure never silently falls back to environment or plaintext configuration.
- Manifests and CLI output contain credential references and redacted fingerprints, never secret values.
- Uninstall removes only installer-owned files and managed blocks and preserves later user changes.
- `doctor` and `status` are read-only; `repair` shows a plan before applying it.
- All client fixtures cover Claude, Codex, Antigravity, OpenCode, and Cursor.
- Update installer README, root README, skill instructions, versions, generated plugins, and installer assets at the milestone checkpoint.

---

### Task 1: Define immutable installer operations and manifests

**Files:**
- Create: `packages/installer/lib/change-plan.js`
- Create: `packages/installer/lib/manifest.js`
- Test: `test/installer/change-plan.test.ts`
- Test: `test/installer/manifest.test.ts`

**Interfaces:**
- Produces: `createChangePlan(metadata, operations)`, `formatChangePlan(plan)`, `writeManifest(home, manifest)`, and `readManifest(home)`.
- Produces operation kinds: `create-directory`, `write-file`, `copy-tree`, `managed-block`, `client-command`, `credential`, and `platform-service`.

- [ ] **Step 1: Write failing immutability and secret-exclusion tests**

```typescript
test('change plans are immutable and contain no credential value', () => {
  const plan = createChangePlan({ version: '2.0.0-beta.1' }, [
    credentialOperation('openrouter', { reference: 'token-optimizer/openrouter', fingerprint: 'sha256:abcd' }),
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.doesNotMatch(JSON.stringify(plan), /sk-or-/);
});

test('manifest round trip preserves ownership hashes', () => {
  writeManifest(home, manifestFixture());
  assert.deepEqual(readManifest(home).files[0], { path: '/managed/file', sha256: 'abc', ownership: 'installer' });
});
```

- [ ] **Step 2: Confirm tests fail without plan and manifest modules**

Run: `npm test -- --test-name-pattern="change plans|manifest round trip"`

Expected: module resolution fails.

- [ ] **Step 3: Implement frozen operations and atomic manifest storage**

```javascript
function createChangePlan(metadata, operations) {
  const frozenOperations = operations.map((operation) => Object.freeze({ ...operation }));
  return Object.freeze({ schemaVersion: 2, ...metadata, operations: Object.freeze(frozenOperations) });
}

function writeManifest(home, manifest) {
  const filePath = manifestPath(home);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tempPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}
```

Validate loaded manifests by schema version and reject paths outside known installer/client roots.

- [ ] **Step 4: Verify formatting, corruption recovery, and permissions**

Run: `npm test -- --test-name-pattern="change plan|manifest|ownership|corrupt"`

Expected: deterministic human/JSON output, atomic replacement, invalid schema rejection, and mode assertions pass where supported.

- [ ] **Step 5: Commit installer state contracts**

```bash
git add packages/installer/lib/change-plan.js packages/installer/lib/manifest.js test/installer/change-plan.test.ts test/installer/manifest.test.ts
git commit -m "feat: define installer plans and ownership manifests"
```

### Task 2: Refactor installation into plan then apply

**Files:**
- Modify: `packages/installer/lib/install-core.js`
- Create: `packages/installer/lib/apply-plan.js`
- Modify: `packages/installer/bin/token-optimizer.js`
- Test: `test/installer/install-core.test.ts`
- Test: `test/installer/cli.test.ts`

**Interfaces:**
- Produces: `planInstallation(options): ChangePlan` and `applyChangePlan(plan, adapters): ApplyResult`.
- Preserves: `installSelectedClients(options)` as a compatibility wrapper around plan plus apply.

- [ ] **Step 1: Write a failing dry-run parity test**

```typescript
test('dry-run performs no mutation and matches applied operations', () => {
  const plan = installer.planInstallation(fixtureOptions({ home }));
  const before = snapshotTree(home);
  const preview = installer.formatChangePlan(plan);
  assert.deepEqual(snapshotTree(home), before);
  const result = installer.applyChangePlan(plan, fakeAdapters());
  assert.deepEqual(result.applied.map(op => op.id), plan.operations.map(op => op.id));
  assert.match(preview, /Will modify:/);
});
```

- [ ] **Step 2: Confirm current installation mutates while planning**

Run: `npm test -- --test-name-pattern="dry-run performs no mutation"`

Expected: test fails because current install functions copy and write immediately.

- [ ] **Step 3: Make client installers emit operations**

```javascript
function planInstallation(options) {
  const paths = installerPaths(options);
  const clients = normalizeClients(options.clients, paths.home);
  const operations = clients.flatMap((client) => planClientInstall(client, { ...options, ...paths }));
  return createChangePlan({ action: 'install', version: options.version, clients }, operations);
}

function installSelectedClients(options) {
  const plan = planInstallation(options);
  return applyChangePlan(plan, defaultAdapters(options)).installedClients;
}
```

Operation application records a before-state and inverse action. On critical failure, apply inverse actions in reverse order and return applied, rolled-back, and manual-remediation arrays.

- [ ] **Step 4: Add CLI dry-run output and verify parity**

```javascript
if (args['dry-run'] === true) {
  console.log(args.json ? JSON.stringify(plan, null, 2) : formatChangePlan(plan));
  return;
}
const result = applyChangePlan(plan, defaultAdapters(options));
```

Run: `npm test -- --test-name-pattern="dry-run|apply plan|rollback|install"`

Expected: every fake-home mutation is represented in the preview and repeated install is idempotent.

- [ ] **Step 5: Commit plan-driven installation**

```bash
git add packages/installer/lib/install-core.js packages/installer/lib/apply-plan.js packages/installer/bin/token-optimizer.js test/installer/install-core.test.ts test/installer/cli.test.ts
git commit -m "refactor: apply installer changes from dry-run plans"
```

### Task 3: Add explicit cross-platform credential stores

**Files:**
- Create: `packages/installer/lib/credential-store.js`
- Create: `packages/installer/lib/credential-store-macos.js`
- Create: `packages/installer/lib/credential-store-linux.js`
- Create: `packages/installer/lib/credential-store-windows.js`
- Test: `test/installer/credential-store.test.ts`

**Interfaces:**
- Produces: `createCredentialStore(kind, options)` with `isAvailable`, `set`, `get`, and `delete`.
- Produces: credential references shaped as `{ store, service, account, fingerprint }`.

- [ ] **Step 1: Write failing native-store and no-silent-fallback tests**

```typescript
test('native-store failure does not write plaintext fallback', () => {
  const store = createCredentialStore('native', unavailableNativeAdapters());
  assert.throws(() => store.set(openRouterCredential()), /choose env or config explicitly/i);
  assert.equal(fs.existsSync(plaintextConfigPath), false);
});

test('status exposes only a fingerprint', () => {
  const reference = fakeStore().set(openRouterCredential('sk-or-secret-value'));
  assert.doesNotMatch(JSON.stringify(reference), /secret-value/);
  assert.match(reference.fingerprint, /^sha256:/);
});
```

- [ ] **Step 2: Confirm credential tests fail without adapters**

Run: `npm test -- --test-name-pattern="native-store failure|fingerprint"`

Expected: module resolution fails.

- [ ] **Step 3: Implement adapters without shell interpolation**

```javascript
function createCredentialStore(kind, options = {}) {
  if (kind === 'env') return environmentReferenceStore(options);
  if (kind === 'config') return protectedConfigStore(options);
  const native = nativeStoreForPlatform(options.platform || process.platform, options);
  if (!native.isAvailable()) {
    throw new Error('Native credential store unavailable; choose env or config explicitly.');
  }
  return native;
}
```

macOS calls `/usr/bin/security` with argument arrays. Linux calls `secret-tool` with argument arrays. Windows uses PowerShell DPAPI `ProtectedData` and stores only the encrypted blob under the installer's mode-`0600` data directory. Tests inject process adapters and never access a real user credential store.

- [ ] **Step 4: Verify store lifecycle and redaction**

Run: `npm test -- --test-name-pattern="credential store|native|DPAPI|Keychain|Secret Service|plaintext"`

Expected: set/get/delete, unavailable-store, command-argument, fingerprint, and output-redaction fixtures pass.

- [ ] **Step 5: Commit credential adapters**

```bash
git add packages/installer/lib/credential-store*.js test/installer/credential-store.test.ts
git commit -m "feat: store provider credentials explicitly"
```

### Task 4: Migrate provider configuration without changing destinations

**Files:**
- Modify: `packages/installer/lib/install-core.js`
- Modify: `packages/installer/bin/token-optimizer.js`
- Modify: `scripts/manage-gateway-config.js`
- Modify: `scripts/launcher-template.js`
- Test: `test/installer/migration.test.ts`
- Test: `test/installer/cli.test.ts`
- Test: `test/scripts/gateway-config.test.ts`
- Test: `test/scripts/launcher-template.test.ts`

**Interfaces:**
- Produces: installer provider choices `local`, `gateway-token`, `gateway-byok`, `openrouter-direct`, and `skip`.
- Produces: `planMigration(v1State, choices): ChangePlan`.

- [ ] **Step 1: Write failing v1 destination-preservation tests**

```typescript
test('v1 BYOK migrates to gateway-byok and keeps gateway URL', () => {
  const plan = planMigration(v1ByokFixture(), migrationChoices());
  assert.equal(plan.effectiveProvider.mode, 'gateway-byok');
  assert.equal(plan.effectiveProvider.apiUrl, 'https://llm-proxy.lnf.gr/v1');
  assert.match(plan.warnings.join('\n'), /key.*gateway/i);
});

test('new BYOK defaults to OpenRouter direct', async () => {
  const options = await cli.resolveProviderOptions({ provider: 'openrouter-direct', byokKey: 'secret' }, readlineWith());
  assert.equal(options.provider, 'openrouter-direct');
});
```

- [ ] **Step 2: Confirm current `byok` shape fails explicit-mode tests**

Run: `npm test -- --test-name-pattern="v1 BYOK migrates|new BYOK defaults"`

Expected: provider values are still represented as ambiguous `byok`.

- [ ] **Step 3: Implement explicit choices and launcher credential lookup**

```javascript
function normalizeProviderChoice(value) {
  const aliases = { gateway: 'gateway-token', byok: 'gateway-byok', direct: 'openrouter-direct' };
  return aliases[value] || value;
}

function buildProviderValues(options) {
  return {
    TOKEN_OPTIMIZER_PROVIDER_MODE: options.provider,
    TOKEN_OPTIMIZER_CREDENTIAL_REF: options.credentialRef || '',
    LLM_GATEWAY_URL: gatewayUrlFor(options),
    OPENROUTER_BYOK_MODEL: options.byokModel || '',
  };
}
```

The launcher resolves `TOKEN_OPTIMIZER_CREDENTIAL_REF` at startup and injects the secret into only the MCP child environment. Preserve legacy environment variables until doctor confirms the new provider path, then emit an explicit cleanup operation.

- [ ] **Step 4: Verify every client migration fixture**

Run: `npm test -- --test-name-pattern="migration|provider choice|launcher|gateway config"`

Expected: all five clients preserve destinations, expose warnings, avoid raw credentials in configs when using native stores, and migrate idempotently.

- [ ] **Step 5: Commit provider migration**

```bash
git add packages/installer/lib/install-core.js packages/installer/bin/token-optimizer.js scripts/manage-gateway-config.js scripts/launcher-template.js test/installer test/scripts
git commit -m "feat: migrate provider configuration explicitly"
```

### Task 5: Implement read-only status and doctor

**Files:**
- Create: `packages/installer/lib/doctor.js`
- Modify: `packages/installer/bin/token-optimizer.js`
- Test: `test/installer/doctor.test.ts`
- Test: `test/installer/cli.test.ts`

**Interfaces:**
- Produces: `inspectInstallation(options): DoctorReport`.
- Produces findings shaped as `{ code, severity, client?, message, remediation }`.

- [ ] **Step 1: Write failing read-only and finding-code tests**

```typescript
test('doctor is read-only and reports stale launcher version', async () => {
  const before = snapshotTree(home);
  const report = await inspectInstallation(doctorOptions({ home, installedVersion: '1.12.1' }));
  assert.deepEqual(snapshotTree(home), before);
  assert.ok(report.findings.some(finding => finding.code === 'VERSION_MISMATCH'));
});
```

- [ ] **Step 2: Confirm doctor command is unsupported**

Run: `npm test -- --test-name-pattern="doctor is read-only"`

Expected: `inspectInstallation` is missing and CLI rejects `doctor`.

- [ ] **Step 3: Implement inspection and stable exit codes**

```javascript
async function inspectInstallation(options) {
  return {
    schemaVersion: 2,
    healthy: findings.every((finding) => finding.severity !== 'error'),
    effectiveProfile: inspectExecutionProfile(options),
    provider: await inspectProviderReference(options),
    clients: inspectClients(options),
    logs: inspectLogState(options),
    findings,
  };
}
```

`status` prints installed version, provider mode, credential store kind, clients, profile, and log usage. `doctor` adds health probes and findings. `--json` emits the same schema. Exit `0` for healthy, `1` for errors, and `2` for warnings-only when `--strict` is supplied.

- [ ] **Step 4: Verify no-mutation and output redaction**

Run: `npm test -- --test-name-pattern="doctor|status|read-only|VERSION_MISMATCH|redact"`

Expected: snapshots remain unchanged and output contains no fixture secret.

- [ ] **Step 5: Commit status and doctor**

```bash
git add packages/installer/lib/doctor.js packages/installer/bin/token-optimizer.js test/installer/doctor.test.ts test/installer/cli.test.ts
git commit -m "feat: add installer status and doctor"
```

### Task 6: Implement repair, uninstall, and log lifecycle commands

**Files:**
- Create: `packages/installer/lib/uninstall.js`
- Create: `packages/installer/lib/logs.js`
- Modify: `packages/installer/lib/doctor.js`
- Modify: `packages/installer/bin/token-optimizer.js`
- Test: `test/installer/repair.test.ts`
- Test: `test/installer/uninstall.test.ts`
- Test: `test/installer/cli.test.ts`

**Interfaces:**
- Produces: `planRepair(report, manifest)`, `planUninstall(manifest, currentState)`, and CLI `logs status|prune|purge`.
- Consumes: change-plan/apply APIs and manifest ownership hashes.

- [ ] **Step 1: Write failing ownership-preservation and repair tests**

```typescript
test('uninstall preserves a user-modified managed file', () => {
  const plan = planUninstall(manifestFixture(), currentStateWithChangedHash());
  assert.ok(plan.operations.every(operation => operation.path !== userModifiedPath));
  assert.ok(plan.warnings.some(warning => warning.code === 'USER_MODIFIED_FILE'));
});

test('repair derives only operations required by doctor findings', () => {
  const plan = planRepair(reportWithMissingLauncher(), manifestFixture());
  assert.deepEqual(plan.operations.map(op => op.kind), ['copy-tree']);
});
```

- [ ] **Step 2: Confirm lifecycle commands are unsupported**

Run: `npm test -- --test-name-pattern="uninstall preserves|repair derives"`

Expected: planning functions and CLI commands are missing.

- [ ] **Step 3: Implement ownership-aware lifecycle planning**

```javascript
function planUninstall(manifest, currentState) {
  const operations = [];
  const warnings = [];
  for (const file of manifest.files) {
    if (currentState.hash(file.path) !== file.sha256) {
      warnings.push({ code: 'USER_MODIFIED_FILE', path: file.path });
      continue;
    }
    operations.push(removeOwnedFileOperation(file));
  }
  operations.push(...removeManagedBlocks(manifest, currentState));
  return createChangePlan({ action: 'uninstall', warnings }, operations);
}
```

`repair` and `uninstall` support `--dry-run`. `packages/installer/lib/logs.js` applies the same retention defaults and protected-file categories as `src/log-store.ts`, verified through shared JSON fixtures in the test. `logs` commands require `--workspace <absolute-path>`. `logs purge` defaults to run logs only; `--include-baseline` and `--include-analytics` are required to remove those categories.

- [ ] **Step 4: Verify repeated lifecycle operations**

Run: `npm test -- --test-name-pattern="repair|uninstall|logs status|logs prune|logs purge|user-modified"`

Expected: repair and uninstall are idempotent, user changes survive, and purge scope requires explicit flags.

- [ ] **Step 5: Commit installer lifecycle commands**

```bash
git add packages/installer/lib/uninstall.js packages/installer/lib/logs.js packages/installer/lib/doctor.js packages/installer/bin/token-optimizer.js test/installer
git commit -m "feat: add repair uninstall and log commands"
```

### Task 7: Publish the beta.1 installer checkpoint

**Files:**
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
- Test: `test/scripts/plugin-generators.test.ts`
- Test: all `test/installer/*.test.ts`

**Interfaces:**
- Documents: dry-run, manifest ownership, migration, credential stores, status, doctor, repair, uninstall, and logs commands.
- Produces: aligned `2.0.0-beta.1` artifacts.

- [ ] **Step 1: Add failing packaged-lifecycle assertions**

```typescript
assert.match(installerHelp, /install --dry-run/);
assert.match(installerHelp, /doctor/);
assert.match(installerHelp, /uninstall --dry-run/);
assert.match(installerReadme, /gateway-byok/);
assert.match(installerReadme, /OpenRouter key.*gateway/i);
```

- [ ] **Step 2: Confirm packaged assets do not yet expose the lifecycle**

Run: `npm test -- --test-name-pattern="packaged lifecycle|release version|plugin generator"`

Expected: help, docs, and generated assets mismatch.

- [ ] **Step 3: Update documentation and aligned versions**

Set every release source to `2.0.0-beta.1`. Document complete mutation previews, credential-store fallback choices, exit codes, manifest location, user-modification preservation, migration cleanup, and command examples.

- [ ] **Step 4: Execute cross-platform-ready milestone verification**

Run: `npm run build`

Expected: succeeds.

Run: `npm test`

Expected: all server, gateway, installer, launcher, generator, and lifecycle tests pass.

Run: `npm run build:plugin`

Expected: all client artifacts regenerate with beta.1 behavior.

Run: `npm run build:installer`

Expected: installer assets contain plan, manifest, credential, doctor, and uninstall modules.

Run: `npm pack ./packages/installer --dry-run`

Expected: all required modules and no local credentials/logs appear in the tarball.

- [ ] **Step 5: Review and commit the milestone**

Run Token Optimizer changed-files review, test verdict, and installer tarball digest before committing.

```bash
git add packages/installer scripts test README.md skill package.json package-lock.json src plugin .agents .claude-plugin
git commit -m "chore: prepare v2.0.0-beta.1 installer milestone"
```
