import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunLog, ensureLogGitignore, purgeLogs, pruneLogs } from '../../src/log-store';
import { appendRun, loadRun } from '../../src/registry';

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
