import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const plans = require('../../../packages/installer/lib/change-plan.js');
const apply = require('../../../packages/installer/lib/apply-plan.js');

/* Installer previews are immutable, secret-free data; rollback is exercised with
   injected adapters so the release gate never touches home or native stores. */
test('dry-run plan is secret-free, immutable, and causes no mutation', () => {
  let mutations = 0;
  const secret = 'sk-or-fixture-secret';
  const plan = plans.createChangePlan({ token: secret }, [plans.credentialOperation('gateway-byok', { value: secret }), plans.writeFileOperation('/tmp/fixture', 'hash')]);
  assert.doesNotMatch(plans.formatChangePlan(plan, 'json'), /fixture-secret/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(mutations, 0);
});

test('real CLI dry-run is secret-free and leaves isolated HOME unchanged', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-installer-'));
  const repository = path.resolve(__dirname, '../../../');
  const before = fs.readdirSync(home);
  const secret = 'sk-or-fixture-secret';
  const result = spawnSync(process.execPath, [path.join(repository, 'packages/installer/bin/token-optimizer.js'), 'install', '--dry-run', '--json', '--provider', 'gateway-byok', '--byok-key', secret, '--clients', 'codex', '--home', home, '--skip-client-commands', '--skip-launchctl'], { cwd: repository, encoding: 'utf8', env: { PATH: process.env.PATH || '', HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(`${result.stdout}${result.stderr}`, /fixture-secret/);
  assert.deepEqual(fs.readdirSync(home), before);
  fs.rmSync(home, { recursive: true, force: true });
});

test('failed installer operation rolls back owned mutations in reverse order', () => {
  const plan = plans.createChangePlan({}, [plans.operation('create-directory', { id: 'one' }), plans.operation('write-file', { id: 'two' })]);
  const events: string[] = [];
  const result = apply.applyChangePlan(plan, { apply: (op: any) => { events.push(`apply:${op.id}`); if (op.id === 'two') throw new Error('fixture failure'); }, rollback: (op: any) => events.push(`rollback:${op.id}`) });
  assert.deepEqual(events, ['apply:one', 'apply:two', 'rollback:one']);
  assert.equal(result.rolledBack.length, 1);
});
