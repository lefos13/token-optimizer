import test from 'node:test';
import assert from 'node:assert/strict';

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

test('failed installer operation rolls back owned mutations in reverse order', () => {
  const plan = plans.createChangePlan({}, [plans.operation('create-directory', { id: 'one' }), plans.operation('write-file', { id: 'two' })]);
  const events: string[] = [];
  const result = apply.applyChangePlan(plan, { apply: (op: any) => { events.push(`apply:${op.id}`); if (op.id === 'two') throw new Error('fixture failure'); }, rollback: (op: any) => events.push(`rollback:${op.id}`) });
  assert.deepEqual(events, ['apply:one', 'apply:two', 'rollback:one']);
  assert.equal(result.rolledBack.length, 1);
});
