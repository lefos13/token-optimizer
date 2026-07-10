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
