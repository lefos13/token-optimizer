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

test('uninstall preserves a directive file changed after installation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-block-edit-'));
  const file = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(file, 'user edited\n<!-- TOKEN_OPTIMIZER_START -->\nmanaged\n<!-- TOKEN_OPTIMIZER_END -->\n');
  const manifest = { schemaVersion: 2, roots: [home], files: [], managedBlocks: [{ path: file, marker: 'TOKEN_OPTIMIZER_START', sha256: 'installer-hash' }] };
  const plan = planUninstall(manifest, { hash: () => 'changed-hash' });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.warnings[0].code, 'USER_MODIFIED_FILE');
});

test('uninstall rolls back files when a later reversible registration fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-rollback-'));
  const file = path.join(home, 'owned'); fs.writeFileSync(file, 'owned');
  const sha256 = require('node:crypto').createHash('sha256').update('owned').digest('hex');
  const manifest = { schemaVersion: 2, roots: [home], files: [{ path: file, sha256, ownership: 'installer' }], registrations: [{ client: 'codex', ownership: 'installer' }] };
  const adapter = { capture: () => ({ present: true }), apply: () => { throw new Error('fixture'); }, restore: () => {} };
  assert.throws(() => applyLifecyclePlan(planUninstall(manifest), { registrationAdapter: adapter }), /rolled back/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned');
});

test('uninstall fails closed before external state without a reversible adapter', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [], registrations: [{ client: 'claude', ownership: 'installer' }] };
  assert.throws(() => applyLifecyclePlan(planUninstall(manifest), { requireExternalAdapters: true }), /rolled back/);
});
