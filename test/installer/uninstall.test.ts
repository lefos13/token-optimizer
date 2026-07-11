import test from 'node:test';
import assert from 'node:assert/strict';
const { planUninstall } = require('../../../packages/installer/lib/uninstall.js');

test('uninstall emits a warning and preserves user-modified files', () => {
  const file = '/managed/user-edited';
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [{ path: file, sha256: 'installer', ownership: 'installer' }] };
  const plan = planUninstall(manifest, { hash: () => 'user' });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.warnings[0].code, 'USER_MODIFIED_FILE');
});
