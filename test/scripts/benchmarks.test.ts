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
  assert.ok(report.large.productPeakRssMb - report.large.baselinePeakRssMb < 100);
  assert.equal(report.redaction.count, 1);
  assert.equal(report.provider.model, 'benchmark-digest-v1');
  assert.ok(report.provider.latencyMs >= 0);
  assert.ok(!JSON.stringify(report).includes(root));
});
