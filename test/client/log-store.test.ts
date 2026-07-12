import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunLog, ensureLogGitignore, getLogStatus, purgeLogs, pruneLogs } from '../../src/log-store';
import { appendRun, loadRun } from '../../src/registry';
import { resolveLogPath } from '../../src/registry';
import { runCommand } from '../../src/runner';

test('lifecycle redacts split secrets and honors purge scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-')); const log = await createRunLog(root, { storageMode: 'redacted-local', runId: 'x' });
  await log.write('OPENAI_API_'); await log.write('KEY=sk-secret'); await log.close();
  assert.doesNotMatch(await fs.readFile(log.absolutePath, 'utf8'), /sk-secret/);
  await fs.writeFile(path.join(root, '.codex-local-test-runs', 'baseline.json'), '{}'); await purgeLogs(root);
  assert.equal(await fs.access(path.join(root, '.codex-local-test-runs', 'baseline.json')).then(() => true, () => false), true);
  await purgeLogs(root, { includeBaseline: true }); assert.equal(await fs.access(path.join(root, '.codex-local-test-runs', 'baseline.json')).then(() => true, () => false), false);
});

test('gitignore and concurrent registry appends are deterministic', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-')); await fs.writeFile(path.join(root, '.gitignore'), 'dist/\n'); await ensureLogGitignore(root); await ensureLogGitignore(root);
  assert.equal(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), 'dist/\n.codex-local-test-runs/\n');
  for (let i = 0; i < 20; i++) appendRun(root, { runId: String(i), commands: [], exitCodes: {}, timestamp: new Date().toISOString(), rawLogPath: `.codex-local-test-runs/${i}.log`, lineCount: 0 });
  assert.ok(loadRun(root, '19'));
});

test('prune expires logs before quota victims', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-')); const dir = path.join(root, '.codex-local-test-runs'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'old.log'), 'x'); const old = new Date(Date.now() - 10 * 86400000); await fs.utimes(path.join(dir, 'old.log'), old, old);
  const result = await pruneLogs(root, { retentionDays: 7, maxDiskMb: 500 }); assert.equal(result.removed[0]?.reason, 'expired');
});

test('retained audit evidence participates in status, retention, quota, and purge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-audit-life-')); const dir = path.join(root, '.codex-local-test-runs'); await fs.mkdir(dir);
  const retained = path.join(dir, '.retained.audit.tmp'); await fs.writeFile(retained, Buffer.alloc(2048));
  assert.equal((await getLogStatus(root)).quota.bytes, 2048);
  const old = new Date(Date.now() - 10 * 86400000); await fs.utimes(retained, old, old);
  const expired = await pruneLogs(root, { retentionDays: 7, maxDiskMb: 500 });
  assert.equal(expired.removed[0]?.path, '.codex-local-test-runs/.retained.audit.tmp');
  await fs.writeFile(retained, Buffer.alloc(2048));
  const quota = await pruneLogs(root, { retentionDays: 7, maxDiskMb: 0.000001 });
  assert.equal(quota.removed[0]?.reason, 'quota');
  await fs.writeFile(retained, 'x');
  const purged = await purgeLogs(root);
  assert.ok(purged.removed.some((entry) => entry.path.endsWith('.audit.tmp')));
});

test('prune and purge exclude active logs until final close', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-active-life-'));
  const first = await createRunLog(root, { runId: 'active-prune' }); await first.write('still writing');
  const [status, pruned] = await Promise.all([getLogStatus(root), pruneLogs(root, { retentionDays: 0, maxDiskMb: 0 })]);
  assert.equal(status.quota.bytes, 0);
  assert.equal(pruned.removed.length, 0);
  assert.equal(await fs.access(first.temporaryPath).then(() => true, () => false), true);
  await first.close();
  assert.equal(await fs.readFile(first.absolutePath, 'utf8'), 'still writing');

  const second = await createRunLog(root, { runId: 'active-purge' }); await second.write('survives purge');
  const purged = await purgeLogs(root);
  assert.ok(purged.removed.some((entry) => entry.path.endsWith('active-prune.log')));
  assert.equal(await fs.access(second.temporaryPath).then(() => true, () => false), true);
  await second.close();
  assert.equal(await fs.readFile(second.absolutePath, 'utf8'), 'survives purge');
});

test('registry rejects log symlink escapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-')); const dir = path.join(root, '.codex-local-test-runs'); await fs.mkdir(dir);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'outside-')); await fs.writeFile(path.join(outside, 'secret.log'), 'x'); await fs.symlink(path.join(outside, 'secret.log'), path.join(dir, 'link.log'));
  assert.equal(resolveLogPath(root, { logPath: '.codex-local-test-runs/link.log' }), null);
});

test('runCommand redacts credentials split across output chunks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task5-')); const dir = path.join(root, '.codex-local-test-runs'); await fs.mkdir(dir);
  const file = path.join(dir, 'stream.out');
  await runCommand("node -e \"process.stdout.write('OPENAI_API_'); setTimeout(()=>process.stdout.write('KEY=sk-split-secret'),20)\"", root, 5000, undefined, file, 'redacted-local');
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /split-secret/);
});
