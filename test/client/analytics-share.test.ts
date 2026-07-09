import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalyticsRecord, buildSharedAnalyticsRecord, isAnalyticsSharingEnabled } from '../../src/analytics';

test('shared analytics record strips workspace paths, commands, and error text', () => {
  const record = buildAnalyticsRecord({
    toolName: 'run_test_verdict',
    rawSourceText: 'x'.repeat(4000),
    responseText: 'y'.repeat(400),
    targetWorkspacePath: 'C:/secret/project',
    runId: 'run-123',
    rawLogPath: 'C:/secret/project/.codex-local-test-runs/run-123.log',
    commands: ['npm test'],
    exitCodes: { 'npm test': 1 },
    llmMetadata: {
      llmAvailable: true,
      llmProvider: 'gateway',
      llmModel: 'openai/gpt-4o-mini',
      llmLatencyMs: 900,
      llmTaskType: 'verdict',
      fallbackReason: 'gateway call failed: http://10.0.0.5:8080 refused'
    }
  });
  const shared = buildSharedAnalyticsRecord(record);
  const serialized = JSON.stringify(shared);
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('npm test'));
  assert.ok(!serialized.includes('run-123'));
  assert.ok(!serialized.includes('10.0.0.5'));
  assert.equal(shared.usedFallback, true);
  assert.equal(shared.toolName, 'run_test_verdict');
  assert.equal(shared.rawSourceTokens, 1000);
  assert.equal(shared.returnedToMainTokens, 100);
});

test('sharing requires gateway config and honours the opt-out', () => {
  assert.equal(isAnalyticsSharingEnabled({} as any), false);
  const env = { LLM_GATEWAY_URL: 'https://gw/v1', LLM_GATEWAY_TOKEN: 't' } as any;
  assert.equal(isAnalyticsSharingEnabled(env), true);
  assert.equal(isAnalyticsSharingEnabled({ ...env, LLM_GATEWAY_SHARE_ANALYTICS: 'off' }), false);
  assert.equal(isAnalyticsSharingEnabled({ ...env, LLM_GATEWAY_SHARE_ANALYTICS: '0' }), false);
  assert.equal(isAnalyticsSharingEnabled({ ...env, LLM_GATEWAY_SHARE_ANALYTICS: 'on' }), true);
});
