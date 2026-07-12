import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { runSuite } from '../../src/runner';
import { buildAnalyticsRecord, recordAnalytics } from '../../src/analytics';
import { loadRun, resolveLogPath } from '../../src/registry';

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
  const evidence = fs.readFileSync(path.join(root, result.rawLogPath));
  const emitted = Buffer.from(evidence.filter((value) => value === 0xff));
  assert.equal(emitted.length, bytes);
  assert.equal(createHash('sha256').update(emitted).digest('hex'), createHash('sha256').update(Buffer.alloc(bytes, 0xff)).digest('hex'));
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
  const runId = path.basename(result.auditFailure!.evidencePath!).split('.')[1];
  assert.equal(loadRun(root, runId)?.rawLogPath, result.auditFailure!.evidencePath);
  assert.equal(resolveLogPath(root, { runId }), path.join(root, result.auditFailure!.evidencePath!));
  fs.rmSync(root, { recursive: true, force: true });
});

for (const [phase, code] of [['open', 'EACCES'], ['write', 'ENOSPC'], ['end', 'EACCES']] as const) {
  test(`command temp-log ${phase} ${code} preserves command truth and reports audit failure`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `task4-${code}-`));
    const result = await runSuite([`node -e "process.stdout.write('executed')"`], root, {
      commandLogFs: {
        createWriteStream: (() => {
          const failure = () => Object.assign(new Error(`injected ${phase} ${code}`), { code });
          if (phase === 'open') throw failure();
          return new Writable({
            write(_chunk, _encoding, callback) { callback(phase === 'write' ? failure() : undefined); },
            final(callback) { callback(phase === 'end' ? failure() : undefined); },
          });
        }) as any,
      },
    });
    assert.equal(result.results[0].exitCode, 0);
    assert.equal(result.results[0].executionStatus, 'completed');
    assert.equal(result.auditStatus, 'failed');
    assert.equal(result.auditFailure?.stage, 'write');
    assert.equal(result.auditFailure?.code, code);
    assert.equal(result.rawLogPath, '');
    assert.equal(loadRun(root, path.basename(result.rawLogPath)), null);
    assert.ok(result.warnings.some((warning) => /no persisted audit evidence/.test(warning)));
    fs.rmSync(root, { recursive: true, force: true });
  });
}

test('analytics persistence failure is structured and non-throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task4-analytics-'));
  const record = buildAnalyticsRecord({ toolName: 'run_command_digest', rawSourceText: 'x', responseText: 'ok' });
  const result = recordAnalytics(root, record, () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  assert.equal(result.persisted, false);
  assert.match(result.warning || '', /analytics persistence failed: disk full/);
  fs.rmSync(root, { recursive: true, force: true });
});
