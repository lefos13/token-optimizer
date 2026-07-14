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

test('non-credential operation fields survive even when they contain a credential-shaped word', () => {
  /* Real failure: a bundled dependency (jose) ships a file literally named generate_secret.js.
   * The credential-value scrub must not touch this path just because it contains "secret" --
   * that scrub is for actual secret values inside credential operations, not arbitrary paths. */
  const josePath = '/Users/x/.cursor/token-optimizer-server/.data/node_modules/jose/dist/webapi/key/generate_secret.js';
  const removeOp = plans.removeFileOperation(josePath);
  assert.equal(removeOp.path, josePath);
  const copyOp = plans.copyTreeOperation('/src/api_key_reference.md', '/dest/api_key_reference.md');
  assert.equal(copyOp.source, '/src/api_key_reference.md');
  assert.equal(copyOp.path, '/dest/api_key_reference.md');
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

test('apply emits ordered sanitized progress events for success and rollback', () => {
  const successPlan = plans.createChangePlan({}, [
    { kind: 'write-file', id: 'write-config', phase: 'configure', path: '/managed/config.json' },
  ]);
  applyPlan.registerPlan(successPlan, () => undefined, () => ({ inverse: () => undefined }));
  const successEvents: any[] = [];
  const success = applyPlan.applyChangePlan(successPlan, { onProgress: (event: any) => successEvents.push(event) });
  assert.equal(success.error, undefined);
  assert.deepEqual(successEvents.map((event) => event.event), ['operation-start', 'operation-complete', 'complete']);
  assert.equal(successEvents[0].phase, 'configure');
  assert.equal(successEvents[0].sequence, 1);
  assert.equal(successEvents[0].total, 1);
  assert.equal(successEvents[0].path, '/managed/config.json');

  const failedPlan = plans.createChangePlan({}, [
    { kind: 'credential', id: 'credential', phase: 'credentials', provider: 'gateway', token: 'fixture-secret' },
  ]);
  applyPlan.registerPlan(failedPlan, () => { throw new Error('contains fixture-secret'); }, () => ({ inverse: () => undefined }));
  const failedEvents: any[] = [];
  const failed = applyPlan.applyChangePlan(failedPlan, { onProgress: (event: any) => failedEvents.push(event) });
  assert.ok(failed.error);
  assert.deepEqual(failedEvents.map((event) => event.event), ['operation-start', 'rollback-start', 'operation-rolled-back', 'complete']);
  assert.doesNotMatch(JSON.stringify(failedEvents), /fixture-secret/);
});
