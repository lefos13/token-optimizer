import test from 'node:test';
import assert from 'node:assert/strict';
const plans = require('../../../packages/installer/lib/change-plan.js');
const applyPlan = require('../../../packages/installer/lib/apply-plan.js');

test('change plans are immutable and contain no credential value', () => {
  const plan = plans.createChangePlan({ version: '2.0.0-beta.1' }, [
    plans.credentialOperation('openrouter', { reference: 'token-optimizer/openrouter', fingerprint: 'sha256:abcd', token: 'sk-or-secret' }),
  ]);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.operations), true);
  assert.doesNotMatch(JSON.stringify(plan), /sk-or-/);
  assert.doesNotMatch(JSON.stringify(plans.createChangePlan({ note: 'plain secret', apiKey: 'secret' }, [plans.credentialOperation('x', { apiKey: 'plain-secret' })])), /plain-secret|plain secret/);
});

test('change plans reject unknown operation kinds and format deterministically', () => {
  assert.throws(() => plans.createChangePlan({}, [{ kind: 'delete-everything' }]), /unsupported operation kind/);
  const plan = plans.createChangePlan({ version: '2.0.0' }, [{ kind: 'write-file', path: '/managed/file' }]);
  assert.match(plans.formatChangePlan(plan), /write-file/);
  assert.equal(plans.formatChangePlan(plan, 'json'), JSON.stringify(plan, null, 2));
});

test('credential operations preserve dry-run identity without secret values', () => {
  const plan = plans.createChangePlan({}, [{ kind: 'credential', id: 'install:cursor:credentials', client: 'cursor', phase: 'credentials', provider: 'gateway', reference: 'cursor/provider', token: 'secret' }]);
  assert.equal(plan.operations[0].id, 'install:cursor:credentials');
  assert.equal(plan.operations[0].client, 'cursor');
  assert.equal(plan.operations[0].phase, 'credentials');
  assert.doesNotMatch(JSON.stringify(plan), /secret/);
});

test('apply registers inverse before a mutating operation throws', () => {
  const plan = plans.createChangePlan({ clients: ['fixture'] }, [{ kind: 'write-file', id: 'fixture:write' }]);
  let value = 'before';
  applyPlan.registerPlan(plan, () => { value = 'after'; throw new Error('boom'); }, () => ({ inverse: () => { value = 'before'; } }));
  const result = applyPlan.applyChangePlan(plan);
  assert.equal(value, 'before');
  assert.equal(result.rolledBack.length, 1);
});

test('apply commits prepared rollback snapshots after every operation succeeds', () => {
  const plan = plans.createChangePlan({}, [{ kind: 'write-file', id: 'fixture:write' }]);
  let committed = false;
  applyPlan.registerPlan(plan, () => undefined, () => ({
    inverse: () => undefined,
    commit: () => { committed = true; },
  }));

  const result = applyPlan.applyChangePlan(plan);
  assert.equal(result.error, undefined);
  assert.equal(committed, true);
});
