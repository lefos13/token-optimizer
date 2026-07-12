import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..', '..', '..');

/* The self-test launches the compiled stdio server and a deterministic HTTP fake,
 * so it covers the same provider, redaction, runner, and serialization path as a release run. */
test('benchmark production-path contracts pass deterministically', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--self-test'], {
    cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, TOKEN_OPTIMIZER_BENCHMARK_MODE: 'deterministic-local' }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.selfTest, 'passed');
  assert.equal(report.failure.exitCode, 7);
  assert.equal(report.failure.outcome, 'failure');
  assert.ok(report.large.rawBytes > 50 * 1024 * 1024);
  assert.equal(report.large.rawBytes, report.large.expectedBytes);
  assert.ok(report.large.aggregates.overheadRssMb.median < 100);
  assert.match(report.benchmarkInputHash, /^[a-f0-9]{64}$/);
  assert.equal(report.large.repetitions, 3);
  assert.equal(report.large.samples.length, 3);
  assert.ok(report.large.aggregates.overheadRssMb.median < 100);
  assert.ok(report.large.aggregates.overheadRssMb.min <= report.large.aggregates.overheadRssMb.median);
  assert.ok(report.large.aggregates.overheadRssMb.median <= report.large.aggregates.overheadRssMb.max);
  assert.ok(!JSON.stringify(report).includes(root));
});

test('benchmark detects a provenance change before writing output', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--source-change-self-test'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'BENCHMARK_SOURCE_CHANGED');
});

test('benchmark refuses a dirty source tree with a stable code', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--check-clean-fixture'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).code, 'BENCHMARK_SOURCE_DIRTY');
});

test('benchmark timeout tears down its detached process group', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--cleanup-self-test'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).cleanup, 'passed');
});

test('product timeout closes MCP transport, provider, and temporary config', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--product-cleanup-self-test'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).cleanup, 'passed');
});
