import test from 'node:test';
import assert from 'node:assert/strict';
const plans = require('../../../packages/installer/lib/change-plan.js');

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
