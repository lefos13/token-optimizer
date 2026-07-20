import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createStatsStore, sanitizeSharedRecord } from '../../gateway/src/stats';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-stats-'));
}

test('sanitizeSharedRecord clamps numbers and drops identifying garbage', () => {
  const record = sanitizeSharedRecord({
    toolName: 'run_test_verdict',
    rawSourceTokens: 1000,
    returnedToMainTokens: 100,
    estimatedTokensSaved: 900,
    savingsPercentage: 0.9,
    localLlmTotalTokens: 500,
    llmModel: 'openai/gpt-4o-mini',
    llmTaskType: 'verdict',
    llmLatencyMs: 1200,
    usedFallback: false,
    workspacePath: 'C:/secret/project',
    email: 'user@example.com'
  });
  assert.ok(record);
  assert.equal((record as any).workspacePath, undefined);
  assert.equal((record as any).email, undefined);
  assert.equal(record!.toolName, 'run_test_verdict');

  const hostile = sanitizeSharedRecord({
    toolName: '<script>alert(1)</script>',
    rawSourceTokens: 1e15,
    savingsPercentage: 99,
    llmLatencyMs: -5
  });
  assert.equal(hostile!.toolName, 'other');
  assert.equal(hostile!.rawSourceTokens, 10_000_000);
  assert.equal(hostile!.savingsPercentage, 1);
  assert.equal(hostile!.llmLatencyMs, 0);

  assert.equal(sanitizeSharedRecord(null), null);
  assert.equal(sanitizeSharedRecord('nope'), null);
});

test('ingest aggregates totals, per-tool, per-model, and per-day buckets', () => {
  const dir = tmpDir();
  let clock = Date.parse('2026-07-09T10:00:00Z');
  const store = createStatsStore(dir, () => clock);

  assert.equal(store.ingest({
    toolName: 'run_test_verdict', rawSourceTokens: 1000, returnedToMainTokens: 100,
    estimatedTokensSaved: 900, savingsPercentage: 0.9, localLlmTotalTokens: 400,
    llmModel: 'm/one', llmLatencyMs: 100
  }), true);
  clock = Date.parse('2026-07-10T10:00:00Z');
  assert.equal(store.ingest({
    toolName: 'scout_codebase', rawSourceTokens: 1000, returnedToMainTokens: 250,
    estimatedTokensSaved: 250, savingsPercentage: 0.5, localLlmTotalTokens: 200,
    llmModel: 'm/one', llmLatencyMs: 300, usedFallback: true
  }), true);
  assert.equal(store.ingest('garbage'), false);

  const stats = store.publicStats();
  assert.equal(stats.totalCalls, 2);
  assert.equal(stats.totalTokensSaved, 1150);
  assert.equal(stats.averageSavingsPercentage, 0.7);
  assert.equal(stats.averageLatencyMs, 200);
  assert.equal(stats.fallbackRate, 0.5);
  assert.equal(stats.byTool.run_test_verdict.calls, 1);
  assert.equal(stats.byTool.run_test_verdict.rawSourceTokens, 1000);
  assert.equal(stats.byTool.run_test_verdict.returnedToMainTokens, 100);
  assert.equal(stats.byTool.run_test_verdict.localLlmTokens, 400);
  assert.equal(stats.byTool.run_test_verdict.averageLatencyMs, 100);
  assert.equal(stats.byTool.run_test_verdict.fallbackRate, 0);
  assert.equal(stats.byTool.scout_codebase.fallbackRate, 1);
  assert.equal(stats.byModel['m/one'], 2);
  assert.equal(stats.days['2026-07-09'].tokensSaved, 900);
  assert.equal(stats.days['2026-07-10'].tokensSaved, 250);

  /* Aggregates survive a restart. */
  const reloaded = createStatsStore(dir, () => clock);
  assert.equal(reloaded.publicStats().totalCalls, 2);
  const persisted = fs.readFileSync(path.join(dir, 'global-stats.json'), 'utf8');
  assert.ok(!persisted.includes('workspace'));
});

test('ingest ignores sub-threshold records and resets legacy aggregate state', () => {
  const dir = tmpDir();
  const store = createStatsStore(dir);

  assert.equal(store.ingest({
    toolName: 'run_command_digest', rawSourceTokens: 999, returnedToMainTokens: 100,
    estimatedTokensSaved: 899, savingsPercentage: 0.9, localLlmTotalTokens: 400
  }), true);
  assert.equal(store.ingest({
    toolName: 'run_command_digest', rawSourceTokens: 1000, returnedToMainTokens: 100,
    estimatedTokensSaved: 900, savingsPercentage: 0.9, localLlmTotalTokens: 400
  }), true);
  assert.equal(store.publicStats().totalCalls, 1);

  fs.writeFileSync(path.join(dir, 'global-stats.json'), JSON.stringify({
    totals: { calls: 99, tokensSaved: 99 }, byTool: {}, byModel: {}, days: {}
  }));
  const restarted = createStatsStore(dir);
  assert.equal(restarted.publicStats().totalCalls, 0);
});

/* Regression checks remain useful locally, but their deterministic exit-code
   comparison is not a context-savings signal for the public aggregate page. */
test('ingest accepts run_regression_check without adding it to public stats', () => {
  const dir = tmpDir();
  const store = createStatsStore(dir);

  assert.equal(store.ingest({
    toolName: 'run_regression_check', rawSourceTokens: 5000, returnedToMainTokens: 400,
    estimatedTokensSaved: 4600, savingsPercentage: 0.92, localLlmTotalTokens: 0
  }), true);

  const stats = store.publicStats();
  assert.equal(stats.totalCalls, 0);
  assert.equal(stats.totalTokensSaved, 0);
  assert.equal(stats.byTool.run_regression_check, undefined);

  fs.writeFileSync(path.join(dir, 'global-stats.json'), JSON.stringify({
    schemaVersion: 2,
    totals: { calls: 1, rawSourceTokens: 5000, returnedToMainTokens: 400, tokensSaved: 4600, savingsSum: 0.92 },
    byTool: { run_regression_check: { calls: 1, tokensSaved: 4600, savingsSum: 0.92 } },
    byModel: {},
    days: {}
  }));
  const reloaded = createStatsStore(dir);
  assert.equal(reloaded.publicStats().totalCalls, 0);
  assert.equal(reloaded.publicStats().byTool.run_regression_check, undefined);
});

test('preserves old per-tool counters while defaulting new dimensions', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'global-stats.json'), JSON.stringify({
    schemaVersion: 3,
    totals: { calls: 1, rawSourceTokens: 1000, returnedToMainTokens: 100, tokensSaved: 900, savingsSum: 0.9 },
    byTool: { run_test_verdict: { calls: 1, tokensSaved: 900, savingsSum: 0.9 } },
    byModel: {},
    days: {}
  }));

  const stats = createStatsStore(dir).publicStats();
  assert.equal(stats.totalCalls, 1);
  assert.equal(stats.byTool.run_test_verdict.calls, 1);
  assert.equal(stats.byTool.run_test_verdict.rawSourceTokens, 0);
  assert.equal(stats.byTool.run_test_verdict.averageLatencyMs, 0);
});
