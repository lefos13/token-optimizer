import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSuite } from '../../src/runner';
import { buildAnalyticsRecord } from '../../src/analytics';

test('streamed suite bounds returned excerpt and cleans temporary files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task4-'));
  const result = await runSuite([`node -e "process.stdout.write('x'.repeat(1200000))"`], root);
  assert.ok(result.rawSourceBytes > 1_000_000);
  assert.ok(result.trimmedLogContent.length < 400_000);
  assert.equal(fs.readdirSync(path.join(root, '.codex-local-test-runs')).some((name) => name.startsWith('.stream-')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('raw log preserves stdout/stderr arrival tags', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task4-'));
  const result = await runSuite([`node -e "console.log('out'); console.error('err')"`], root);
  const raw = fs.readFileSync(path.join(root, result.rawLogPath), 'utf8');
  assert.ok(raw.indexOf('[stdout]') < raw.indexOf('[stderr]'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('analytics accepts source counters without raw text', () => {
  const record = buildAnalyticsRecord({ toolName: 'run_test_verdict', rawSourceText: '', rawSourceBytes: 8192, responseText: 'ok' });
  assert.equal(record.rawSourceTokens, 2048);
});

test('streaming preserves exact binary byte counts and bounds pathological lines', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task4-binary-'));
  const bytes = 52 * 1024 * 1024 + 3;
  const rssBefore = process.memoryUsage.rss();
  const result = await runSuite([`node -e "process.stdout.write(Buffer.alloc(${bytes}, 0xff)); process.stderr.write(Buffer.from([0,1,2]))"`], root);
  const rssDelta = process.memoryUsage.rss() - rssBefore;
  assert.equal(result.rawSourceBytes, bytes + 3);
  assert.ok(result.trimmedLogContent.length < 400_000);
  assert.equal(result.auditStatus, 'persisted');
  /* RSS is sampled in-process, so only positive growth is relevant; the generous
   * ceiling detects accidental whole-log buffering while tolerating allocator noise. */
  assert.ok(Math.max(0, rssDelta) < 100 * 1024 * 1024, `RSS grew by ${rssDelta} bytes`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rename failure returns explicit audit failure and retains temporary evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task4-audit-'));
  const error = Object.assign(new Error('injected rename failure'), { code: 'EACCES' });
  const result = await runSuite([`node -e "process.stdout.write('executed')"`], root, { logFs: { rename: async () => { throw error; } } });
  assert.equal(result.results[0].exitCode, 0);
  assert.equal(result.results[0].executionStatus, 'completed');
  assert.equal(result.auditStatus, 'failed');
  assert.equal(result.auditFailure?.code, 'EACCES');
  assert.equal(result.auditFailure?.tempCleanup, 'retained');
  assert.ok(result.auditFailure?.evidencePath);
  assert.equal(fs.existsSync(path.join(root, result.auditFailure!.evidencePath!)), true);
  fs.rmSync(root, { recursive: true, force: true });
});
