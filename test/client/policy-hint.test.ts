import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionMetadata, buildPolicyHint } from '../../src/execution-metadata';

test('profile rejections carry a copy-pasteable allow command', () => {
  const hint = buildPolicyHint('npm install --save-dev vitest', 'COMMAND_NOT_ALLOWED');
  assert.equal(hint.allowPrefix, 'npm install');
  assert.equal(hint.allowCommand, 'npx @softawarest/token-optimizer-installer allow "npm install"');
  assert.match(hint.fix, /Ask the user/);
});

test('deny-first rejections never suggest an allowlist entry', () => {
  for (const reason of ['SHELL_METACHARACTER', 'SENSITIVE_PATH', 'WORKSPACE_ESCAPE', 'NETWORK_EXFILTRATION', 'NESTED_SHELL', 'DESTRUCTIVE_PATTERN']) {
    const hint = buildPolicyHint('anything', reason);
    assert.equal(hint.allowCommand, undefined, reason);
    assert.ok(hint.fix.length > 0, reason);
  }
});

test('execution metadata exposes the hint only for blocked commands', () => {
  const blocked = buildExecutionMetadata([{ command: 'npm test | head', executionStatus: 'blocked', policyReasonCode: 'SHELL_METACHARACTER' }], '', 0);
  assert.equal(blocked.policyHint?.reasonCode, 'SHELL_METACHARACTER');
  const completed = buildExecutionMetadata([{ command: 'npm test', executionStatus: 'completed' }], '', 0);
  assert.equal('policyHint' in completed, false);
});
