import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionMetadata } from '../../src/execution-metadata';
process.env.TOKEN_OPTIMIZER_NO_AUTOSTART = '1';
import { handleToolCall } from '../../src/index';

test('command response compatibility preserves legacy fields and additive metadata', () => {
  for (const [status, reason] of [['completed', undefined], ['terminated', undefined], ['blocked', 'COMMAND_NOT_ALLOWED'], ['timed_out', undefined], ['spawn_failed', 'SPAWN_FAILED']] as const) {
    const legacy = { verdict: status === 'completed' ? 'pass' : 'fail', exitCode: status === 'completed' ? 0 : -1, rawLogPath: '.codex-local-test-runs/run.log', failures: [] };
    const additive = buildExecutionMetadata([{ executionStatus: status, policyReasonCode: reason, autoDetected: status === 'completed' }], 'short', 100, ['config warning']);
    assert.equal(typeof legacy.verdict, 'string');
    assert.equal(typeof legacy.rawLogPath, 'string');
    assert.ok(Array.isArray(legacy.failures));
    assert.equal(additive.executionStatus, status);
    assert.equal(additive.policyDecision, reason);
    assert.equal(additive.signal, null);
    assert.equal(additive.logTruncated, true);
    assert.equal(typeof additive.autoDetected, 'boolean');
    assert.deepEqual(additive.warnings, ['config warning']);
  }
});

test('signal termination is distinct from timeout and retains the signal', async () => {
  const result = await import('../../src/runner').then(({ runCommand }) => runCommand(`node -e "process.kill(process.pid, 'SIGTERM')"`, process.cwd(), 5000));
  assert.equal(result.executionStatus, 'terminated');
  assert.equal(result.signal, 'SIGTERM');
  assert.equal(result.exitCode, -1);
});

test('MCP CallTool handler returns blocked compatibility shape', async () => {
  const result: any = await handleToolCall({ params: { name: 'run_command_digest', arguments: {
    workspacePath: process.cwd(), command: 'printf blocked', intent: 'contract', executionProfile: 'safe'
  } } });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.exitCode, -1);
  assert.equal(payload.executionStatus, 'blocked');
  assert.equal(payload.policyDecision, 'COMMAND_NOT_ALLOWED');
  assert.equal(payload.autoDetected, false);
  assert.equal(typeof payload.rawLogPath, 'string');
  assert.equal(Array.isArray(payload.warnings), true);
});

test('MCP CallTool handler returns completed and timed-out compatibility shapes', async () => {
  const base = { workspacePath: process.cwd(), intent: 'contract', executionProfile: 'safe', allowedCommandPrefixes: ['printf', 'sleep'] };
  const completed: any = await handleToolCall({ params: { name: 'run_command_digest', arguments: { ...base, command: 'printf ok' } } });
  const pass = JSON.parse(completed.content[0].text);
  assert.equal(pass.exitCode, 0);
  assert.equal(pass.executionStatus, 'completed');
  assert.equal(pass.signal, null);
  assert.equal(typeof pass.rawLogPath, 'string');
  assert.equal(Array.isArray(pass.warnings), true);

  const timed: any = await handleToolCall({ params: { name: 'run_command_digest', arguments: { ...base, command: 'sleep 1', timeoutMs: 10 } } });
  const timeout = JSON.parse(timed.content[0].text);
  assert.equal(timeout.executionStatus, 'timed_out');
  assert.equal(timeout.exitCode, -1);
  assert.equal(timeout.signal, null);
  assert.equal(typeof timeout.rawLogPath, 'string');
});

test('MCP CallTool handler preserves spawn-failure compatibility shape', async () => {
  const result: any = await handleToolCall({ params: { name: 'run_command_digest', arguments: {
    workspacePath: process.cwd(), command: '__token_optimizer_spawn_failed__', intent: 'contract', executionProfile: 'safe', allowedCommandPrefixes: ['__token_optimizer_spawn_failed__']
  } } });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.executionStatus, 'spawn_failed');
  assert.equal(payload.policyDecision, 'SPAWN_FAILED');
  assert.equal(payload.autoDetected, false);
  assert.equal(payload.exitCode, -1);
  assert.equal(typeof payload.rawLogPath, 'string');
  assert.equal(Array.isArray(payload.warnings), true);
});
