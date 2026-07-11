import test from 'node:test';
import assert from 'node:assert/strict';
const { planUninstall } = require('../../../packages/installer/lib/uninstall.js');
const { applyLifecyclePlan } = require('../../../packages/installer/lib/uninstall.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('uninstall emits a warning and preserves user-modified files', () => {
  const file = '/managed/user-edited';
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [{ path: file, sha256: 'installer', ownership: 'installer' }] };
  const plan = planUninstall(manifest, { hash: () => 'user' });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.warnings[0].code, 'USER_MODIFIED_FILE');
});

test('uninstall removes only the managed directive block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-block-'));
  const file = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(file, `before\n<!-- TOKEN_OPTIMIZER_START -->\nmanaged\n<!-- TOKEN_OPTIMIZER_END -->\nafter\n`);
  const manifest = { schemaVersion: 2, roots: [home], files: [], managedBlocks: [{ path: file, marker: 'TOKEN_OPTIMIZER_START' }] };
  applyLifecyclePlan(planUninstall(manifest, {}));
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\nafter\n');
});
