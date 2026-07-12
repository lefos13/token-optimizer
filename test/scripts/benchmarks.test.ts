import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(__dirname, '..', '..', '..');
/* The runner owns contract self-tests so CI and release evidence exercise the same path. */
test('benchmark contracts and bounded streaming pass deterministically', () => {
  const result = spawnSync(process.execPath, ['scripts/run-benchmarks.js', '--self-test'], { cwd: root, encoding: 'utf8', env: { ...process.env, TOKEN_OPTIMIZER_BENCHMARK_MODE: 'deterministic-local' }, timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schemaVersion, 1); assert.equal(report.selfTest, 'passed');
  assert.ok(report.largeWorkload.rawBytes > 50 * 1024 * 1024); assert.ok(report.largeWorkload.peakRssDeltaMb < 100);
  assert.equal(report.failure.exitCode, 7); assert.equal(report.failure.outcome, 'failure');
  assert.equal(report.redactionCount, 2); assert.ok(!JSON.stringify(report).includes(root));
});

test('optimized benchmark path imports the compiled production runner', () => {
  const source = require('node:fs').readFileSync(path.join(root, 'scripts', 'run-benchmarks.js'), 'utf8');
  assert.match(source, /require\('\.\.\/dist\/runner'\)/);
  assert.match(source, /await runCommand\(/);
});
