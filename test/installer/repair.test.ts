import test from 'node:test';
import assert from 'node:assert/strict';
const { planRepair } = require('../../../packages/installer/lib/uninstall.js');

test('repair is scoped to actionable doctor findings', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed', '/assets'], files: [
    { path: '/managed/server', source: '/assets/server', sha256: 'x', ownership: 'installer' },
    { path: '/managed/skill', source: '/assets/skill', sha256: 'y', ownership: 'installer' },
  ] };
  const plan = planRepair({ findings: [{ code: 'MISSING_LAUNCHER', path: '/managed/server' }] }, manifest);
  assert.deepEqual(plan.operations.map((item: any) => item.path), ['/managed/server']);
});

test('repair consumes stable operation hints and deduplicates exact external work', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed', '/assets'], files: [] };
  const plan = planRepair({ findings: [
    { code: 'STALE_REGISTRATION', client: 'codex', operation: 'rewrite-registration' },
    { code: 'STALE_REGISTRATION', client: 'codex', operation: 'rewrite-registration' },
    { code: 'PROVIDER_MISSING', operation: 'configure-provider' },
  ] }, manifest);
  assert.deepEqual(plan.operations, [{ kind: 'client-command', client: 'codex', command: 'rewrite-registration' }]);
});
