# Token Optimizer v2 Execution and Log Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace buffered shell execution with policy-gated, streamed, process-tree-aware execution and a bounded log lifecycle.

**Architecture:** `src/runner.ts` becomes an orchestrator over focused command-policy, process-tree, bounded-excerpt, and log-store modules. Full output flows to disk; only counters and bounded excerpts flow through memory and analytics.

**Tech Stack:** TypeScript, Node.js `child_process.spawn`, Node streams, filesystem APIs, platform-specific process termination, Node test runner.

## Global Constraints

- This plan depends on the `2.0.0-alpha.1` trust/provider milestone and produces `2.0.0-alpha.2`.
- New installations default to `safe`; user configuration is the maximum privilege ceiling.
- Full output must not be assembled into a single in-memory string.
- Exit code, signal, timeout, spawn failure, and policy rejection remain distinguishable.
- Remote redaction from Plan 1 remains mandatory in every execution profile.
- Default retention is `7` days and default quota is `500` MB.
- Existing MCP result fields remain available; new execution metadata is additive.
- Update README, skill documentation, version sources, plugins, and installer assets at the milestone checkpoint.

---

### Task 1: Add command-policy decisions and workspace confinement

**Files:**
- Create: `src/command-policy.ts`
- Modify: `src/config.ts`
- Modify: `src/types.ts`
- Test: `test/client/command-policy.test.ts`

**Interfaces:**
- Consumes: `EffectiveConfig['execution']`, command string, canonical workspace path.
- Produces: `evaluateCommand(input): PolicyDecision`.

- [ ] **Step 1: Write failing allow, deny, and privilege-ceiling tests**

```typescript
test('safe allows configured validation commands', async () => {
  const decision = await evaluateCommand({
    command: 'npm test', workspacePath: fixtureRoot, profile: 'safe',
    allowedCommandPrefixes: ['npm test'],
  });
  assert.deepEqual(decision, { allowed: true, profile: 'safe', reasonCode: 'ALLOWLIST_MATCH' });
});

test('safe blocks sensitive paths and symlink escape', async () => {
  const sensitive = await evaluateCommand(commandFixture('cat ~/.ssh/id_rsa'));
  const escaped = await evaluateCommand(commandFixture('cat linked-outside/secret'));
  assert.equal(sensitive.allowed, false);
  assert.equal(escaped.allowed, false);
});
```

- [ ] **Step 2: Confirm policy tests fail without the module**

Run: `npm test -- --test-name-pattern="safe allows|sensitive paths|symlink"`

Expected: compilation fails because `evaluateCommand` does not exist.

- [ ] **Step 3: Implement a structured, deny-first decision**

```typescript
export type PolicyReasonCode =
  | 'ALLOWLIST_MATCH' | 'AUTO_DETECTED' | 'PROFILE_UNRESTRICTED'
  | 'COMMAND_NOT_ALLOWED' | 'SENSITIVE_PATH' | 'WORKSPACE_ESCAPE'
  | 'DESTRUCTIVE_PATTERN' | 'NETWORK_EXFILTRATION' | 'NESTED_SHELL';

export type PolicyDecision =
  | { allowed: true; profile: ExecutionProfile; reasonCode: PolicyReasonCode }
  | { allowed: false; profile: ExecutionProfile; reasonCode: PolicyReasonCode; message: string };

export async function evaluateCommand(input: PolicyInput): Promise<PolicyDecision> {
  const parsed = parseCommand(input.command);
  const denied = await findDeniedCondition(parsed, input.workspacePath);
  if (denied) return denied;
  if (input.profile === 'unrestricted') return allow('PROFILE_UNRESTRICTED', input.profile);
  if (matchesAllowlist(parsed, input.allowedCommandPrefixes)) return allow('ALLOWLIST_MATCH', input.profile);
  return deny('COMMAND_NOT_ALLOWED', input.profile, 'Command is not permitted by the active profile.');
}
```

Canonicalize every path with `realpath` or the nearest existing ancestor before containment checks. Do not claim this policy is a complete sandbox.

- [ ] **Step 4: Run the complete policy matrix**

Run: `npm test -- --test-name-pattern="policy|safe|standard|unrestricted|workspace"`

Expected: allowlist, nested-shell, redirection, environment dump, network, destructive, traversal, symlink, and profile fixtures pass.

- [ ] **Step 5: Commit the policy engine**

```bash
git add src/command-policy.ts src/config.ts src/types.ts test/client/command-policy.test.ts
git commit -m "feat: enforce command execution profiles"
```

### Task 2: Build a bounded streaming excerpt collector

**Files:**
- Create: `src/log-excerpt.ts`
- Test: `test/client/log-excerpt.test.ts`

**Interfaces:**
- Produces: `LogExcerptCollector.push(stream, chunk)` and `LogExcerptCollector.finish(): LogExcerpt`.
- Produces: character, byte, and line counters without retaining the full stream.

- [ ] **Step 1: Write a failing bounded-memory behavior test**

```typescript
test('collector bounds retained text while counting a large stream', () => {
  const collector = new LogExcerptCollector({ headLines: 100, tailLines: 200, markerWindows: 5 });
  for (let i = 0; i < 1_000_000; i += 1) collector.push('stdout', `line ${i}\n`);
  const result = collector.finish();
  assert.equal(result.totalLines, 1_000_000);
  assert.ok(result.text.length < 200_000);
  assert.equal(result.truncated, true);
});
```

- [ ] **Step 2: Confirm the test fails without a collector**

Run: `npm test -- --test-name-pattern="collector bounds"`

Expected: compilation fails because `LogExcerptCollector` is missing.

- [ ] **Step 3: Implement head, tail, and marker-window retention**

```typescript
export class LogExcerptCollector {
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private readonly markers: MarkerWindow[] = [];
  private pending = '';
  private totalBytes = 0;
  private totalLines = 0;

  push(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const text = String(chunk);
    this.totalBytes += Buffer.byteLength(text);
    this.consumeLines(stream, text);
  }

  finish(): LogExcerpt {
    this.flushPendingLine();
    return mergeExcerpt(this.head, this.markers, this.tail, this.totalBytes, this.totalLines);
  }
}
```

Keep partial lines across chunks and cap a single retained line to prevent an unbroken megabyte-scale line from defeating the memory bound.

- [ ] **Step 4: Verify chunk boundaries and marker behavior**

Run: `npm test -- --test-name-pattern="collector|partial line|marker window|long line"`

Expected: retained content is deterministic regardless of chunk boundaries.

- [ ] **Step 5: Commit the collector**

```bash
git add src/log-excerpt.ts test/client/log-excerpt.test.ts
git commit -m "feat: collect bounded streaming log excerpts"
```

### Task 3: Add cross-platform process-tree termination

**Files:**
- Create: `src/process-tree.ts`
- Test: `test/client/process-tree.test.ts`
- Create: `test/fixtures/spawn-process-tree.js`

**Interfaces:**
- Produces: `terminateProcessTree(child, platform, graceMs): Promise<TerminationResult>`.
- Consumes: a spawned root child configured as a Unix process-group leader where supported.

- [ ] **Step 1: Write a failing child-and-grandchild timeout test**

```typescript
test('termination removes the spawned grandchild', async () => {
  const child = spawn(process.execPath, [fixturePath], { detached: process.platform !== 'win32' });
  const grandchildPid = await readGrandchildPid(child);
  const result = await terminateProcessTree(child, process.platform, 250);
  assert.equal(result.terminated, true);
  assert.equal(isProcessAlive(grandchildPid), false);
});
```

- [ ] **Step 2: Confirm direct child termination leaves the fixture grandchild alive**

Run: `npm test -- --test-name-pattern="spawned grandchild"`

Expected: test fails with the current direct-child behavior.

- [ ] **Step 3: Implement platform adapters and escalation**

```typescript
export async function terminateProcessTree(
  child: ChildProcess,
  platform = process.platform,
  graceMs = 1000,
): Promise<TerminationResult> {
  if (!child.pid) return { terminated: true, method: 'already-exited' };
  if (platform === 'win32') return terminateWindowsTree(child.pid, graceMs);
  return terminateUnixGroup(child.pid, graceMs);
}
```

Unix sends `SIGTERM` to `-pid`, waits for the grace period, and escalates to `SIGKILL`. Windows invokes `taskkill /PID <pid> /T`, then `/F` after the grace period. Record the method and any termination error without replacing the command's authoritative execution outcome.

- [ ] **Step 4: Run platform-appropriate process tests**

Run: `npm test -- --test-name-pattern="process tree|timeout|signal"`

Expected: Unix tests pass locally; Windows-specific assertions are guarded by `process.platform` and run in Windows CI.

- [ ] **Step 5: Commit process termination**

```bash
git add src/process-tree.ts test/client/process-tree.test.ts test/fixtures/spawn-process-tree.js
git commit -m "fix: terminate complete command process trees"
```

### Task 4: Replace `exec()` with streamed `spawn()`

**Files:**
- Modify: `src/runner.ts`
- Modify: `src/types.ts`
- Modify: `src/analytics.ts`
- Modify: `src/index.ts`
- Test: `test/client/runner.test.ts`
- Test: `test/client/analytics.test.ts`

**Interfaces:**
- Consumes: `PolicyDecision`, `LogExcerptCollector`, `terminateProcessTree`.
- Produces: `runCommand(request: RunCommandRequest): Promise<RunCommandResult>`.
- Produces: raw-source byte/token counters for analytics instead of `rawLogContent`.

- [ ] **Step 1: Write failing streaming and outcome tests**

```typescript
test('large output streams to disk without rawLogContent', async () => {
  const result = await runSuite([largeOutputCommand()], fixtureRoot, safeOptions());
  assert.equal('rawLogContent' in result, false);
  assert.ok(result.rawSourceBytes > 50 * 1024 * 1024);
  assert.ok(result.trimmedLogContent.length < 200_000);
});

test('timeout returns a distinct execution status', async () => {
  const result = await runCommand(timeoutRequest(50));
  assert.equal(result.executionStatus, 'timed_out');
  assert.equal(result.exitCode, -1);
});
```

- [ ] **Step 2: Confirm the old runner fails the new contract**

Run: `npm test -- --test-name-pattern="large output streams|distinct execution status"`

Expected: tests fail because the runner returns the full accumulator and lacks `executionStatus`.

- [ ] **Step 3: Implement one settled, streamed execution path**

```typescript
export async function runCommand(request: RunCommandRequest): Promise<RunCommandResult> {
  const policy = await evaluateCommand(request);
  if (!policy.allowed) return blockedResult(request.command, policy);
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (result: RunCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await closeLog();
      resolve(result);
    };
    const child = spawnCommand(request);
    child.stdout?.on('data', chunk => writeAndCollect('stdout', chunk));
    child.stderr?.on('data', chunk => writeAndCollect('stderr', chunk));
    child.once('error', error => void finish(spawnFailureResult(error)));
    child.once('close', (code, signal) => void finish(completedResult(code, signal)));
    const timer = setTimeout(() => void timeoutAndFinish(child, finish), request.timeoutMs);
  });
}
```

Change analytics construction to accept `rawSourceTokens` or `rawSourceBytes` directly. No analytics path may reopen and read the complete log merely to estimate its size.

- [ ] **Step 4: Verify runner, analytics, build, and full suite**

Run: `npm test -- --test-name-pattern="runner|large output|timeout|analytics"`

Expected: streaming, blocked, spawn-failure, exit-code, parallel-ordering, and analytics tests pass.

Run: `npm run build`

Expected: compilation succeeds with no remaining `rawLogContent` consumer.

- [ ] **Step 5: Commit streamed execution**

```bash
git add src/runner.ts src/types.ts src/analytics.ts src/index.ts test/client/runner.test.ts test/client/analytics.test.ts
git commit -m "feat: stream command output with bounded memory"
```

### Task 5: Add managed log retention, quota, and atomic metadata

**Files:**
- Create: `src/log-store.ts`
- Modify: `src/redaction.ts`
- Modify: `src/registry.ts`
- Modify: `src/runner.ts`
- Test: `test/client/log-store.test.ts`
- Test: `test/client/registry.test.ts`

**Interfaces:**
- Produces: `createRunLog`, `finalizeRunLog`, `getLogStatus`, `pruneLogs`, `purgeLogs`, and `ensureLogGitignore`.
- Produces: `LogLifecycleResult` with removed files, freed bytes, warnings, and quota state.

- [ ] **Step 1: Write failing lifecycle and preservation tests**

```typescript
test('prune removes expired logs before quota victims', async () => {
  await seedLogs(fixtureRoot, [{ ageDays: 10, bytes: 10 }, { ageDays: 1, bytes: 600 }]);
  const result = await pruneLogs(fixtureRoot, { retentionDays: 7, maxDiskMb: 500 });
  assert.equal(result.removed[0].reason, 'expired');
  assert.ok(result.remainingBytes <= 500 * 1024 * 1024);
});

test('gitignore update preserves user content and is idempotent', async () => {
  await writeGitignore(fixtureRoot, 'dist/\n');
  await ensureLogGitignore(fixtureRoot);
  await ensureLogGitignore(fixtureRoot);
  assert.equal(await readGitignore(fixtureRoot), 'dist/\n.codex-local-test-runs/\n');
});

test('redacted-local removes secrets before the first disk write', async () => {
  const log = await createRunLog(fixtureRoot, { storageMode: 'redacted-local' });
  await log.write('OPENAI_API_KEY=sk-fixture-secret\n');
  await log.close();
  assert.doesNotMatch(await fs.promises.readFile(log.absolutePath, 'utf8'), /fixture-secret/);
});
```

- [ ] **Step 2: Confirm lifecycle tests fail without the log store**

Run: `npm test -- --test-name-pattern="prune removes|gitignore update"`

Expected: compilation fails because log lifecycle functions do not exist.

- [ ] **Step 3: Implement atomic writes and deterministic pruning**

```typescript
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.promises.rename(temp, filePath);
}

export async function pruneLogs(workspacePath: string, policy: LogPolicy): Promise<LogLifecycleResult> {
  const entries = await listManagedLogFiles(workspacePath);
  const expired = entries.filter(entry => entry.ageDays > policy.retentionDays);
  const removed = await removeEntries(expired, 'expired');
  removed.push(...await removeOldestUntilUnderQuota(entriesWithout(entries, expired), policy.maxDiskMb));
  return summarizeLifecycle(entries, removed, policy);
}
```

`createRunLog` writes chunks directly in `raw-local` mode and passes each chunk through the streaming redactor before the first disk write in `redacted-local` mode. Protect baseline and analytics files from retention pruning unless the explicit purge command includes them. Resolve all paths beneath the canonical log directory.

- [ ] **Step 4: Verify registry recovery and lifecycle behavior**

Run: `npm test -- --test-name-pattern="log store|prune|purge|registry|atomic|gitignore"`

Expected: corrupt registry recovery, concurrent write serialization, permissions, retention, quota, purge scope, and idempotent ignore tests pass.

- [ ] **Step 5: Commit managed logs**

```bash
git add src/log-store.ts src/redaction.ts src/registry.ts src/runner.ts test/client/log-store.test.ts test/client/registry.test.ts
git commit -m "feat: manage log retention and disk usage"
```

### Task 6: Expose additive execution metadata and publish alpha.2

**Files:**
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Modify: `README.md`
- Modify: `skill/skill-example.md`
- Modify: `packages/installer/README.md`
- Modify: `package.json`
- Modify: `packages/installer/package.json`
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
- Test: `test/client/tool-contracts.test.ts`
- Test: `test/scripts/release-versions.test.ts`

**Interfaces:**
- Adds: `executionStatus`, `signal`, `policyDecision`, `logTruncated`, `redactionSummary`, `providerStatus`, and `warnings` without removing v1 fields.
- Produces: aligned `2.0.0-alpha.2` artifacts.

Add optional `executionProfile` and `allowedCommandPrefixes` inputs to command-running MCP schemas. Resolve them through `resolveEffectiveConfig`; they may narrow the user ceiling but cannot elevate it. Auto-detected commands carry an internal `autoDetected: true` marker and do not require a broad default prefix such as `npm run`.

- [ ] **Step 1: Add failing MCP compatibility fixtures**

```typescript
assert.equal(result.verdict, 'fail');
assert.equal(result.executionStatus, 'completed');
assert.equal(result.exitCode, 1);
assert.equal(typeof result.rawLogPath, 'string');
assert.ok(Array.isArray(result.failures));
```

Add blocked, timed-out, and spawn-failed fixture assertions with stable machine-readable reason codes.

- [ ] **Step 2: Confirm tool-contract fixtures fail**

Run: `npm test -- --test-name-pattern="tool contract|blocked|timed-out"`

Expected: additive fields are absent from current MCP outputs.

- [ ] **Step 3: Shape stable tool responses and document profiles/log lifecycle**

Update `ListToolsRequestSchema` descriptions and matching handlers together. Document profile semantics, non-sandbox limitations, retention defaults, quota, purge behavior, timeout statuses, and raw-local privacy risk. Set every release source to `2.0.0-alpha.2`.

- [ ] **Step 4: Execute milestone verification**

Run: `npm run build`

Expected: succeeds.

Run: `npm test`

Expected: all tests pass, including large-output and process-tree fixtures.

Run: `npm run build:plugin`

Expected: all generated clients expose alpha.2 contract descriptions.

Run: `npm run build:installer`

Expected: packaged server includes streamed execution and log-store modules.

Run: `npm pack ./packages/installer --dry-run`

Expected: package audit succeeds.

- [ ] **Step 5: Review and commit the milestone**

Run changed-files review and an explicit `npm test` verdict through Token Optimizer before committing.

```bash
git add src test README.md skill packages/installer scripts plugin .agents .claude-plugin package.json package-lock.json
git commit -m "chore: prepare v2.0.0-alpha.2 reliability milestone"
```
