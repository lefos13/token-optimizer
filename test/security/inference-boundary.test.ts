import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryLocalLLM } from '../../src/llm';
import { buildAnalyticsRecord, buildSharedAnalyticsRecord } from '../../src/analytics';

const valid = JSON.stringify({ verdict: 'pass', confidence: 0.9, summary: 'ok', likelyRelevantToRecentChanges: false, failures: [], needsRawLogs: false });
const providerKeys = ['TOKEN_OPTIMIZER_PROVIDER_MODE', 'TOKEN_OPTIMIZER_CONFIG_HOME', 'LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN', 'OPENROUTER_BYOK_KEY', 'OPENROUTER_API_KEY', 'LOCAL_LLM_API_URL'];

async function withProvider(env: Record<string, string>, response: string, run: (bodies: string[]) => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(providerKeys.map((key) => [key, process.env[key]]));
  providerKeys.forEach((key) => delete process.env[key]); Object.assign(process.env, env);
  const original = globalThis.fetch; const bodies: string[] = [];
  globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: response } }] }), { status: 200 }); }) as typeof fetch;
  try { await run(bodies); } finally { globalThis.fetch = original; providerKeys.forEach((key) => saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]!); }
}

/* Exercise provider resolution and the real HTTP adapter. Every remote final hop
   receives redacted content, while local inference retains local diagnostics. */
test('resolved gateway, gateway-BYOK, and direct providers redact the final HTTP hop', async () => {
  const modes: Array<Record<string, string>> = [
    { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', LLM_GATEWAY_URL: 'https://gateway.invalid/v1', LLM_GATEWAY_TOKEN: 'fixture-token' },
    { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-byok', LLM_GATEWAY_URL: 'https://gateway.invalid/v1', OPENROUTER_BYOK_KEY: 'sk-or-fixture' },
    { TOKEN_OPTIMIZER_PROVIDER_MODE: 'openrouter-direct', OPENROUTER_API_KEY: 'sk-or-fixture' },
  ];
  for (const env of modes) await withProvider(env, valid, async (bodies) => {
    const result = await queryLocalLLM('task', ['npm test'], { 'npm test': 0 }, [], 'OPENAI_API_KEY=sk-output-secret');
    assert.equal(result.verdict, 'pass'); assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0], /sk-output-secret/); assert.match(bodies[0], /\*\*\*/);
  });
});

test('user and project redaction rules accumulate at the final remote request', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-inference-'));
  const configHome = path.join(root, 'config');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(configHome); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(configHome, 'config.json'), JSON.stringify({
    provider: { mode: 'gateway-token', apiUrl: 'https://gateway.invalid/v1' },
    redaction: { rules: [{ pattern: 'USER-\\d{3}', category: 'user-rule' }] },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, '.token-optimizer.json'), JSON.stringify({
    redaction: { rules: [{ pattern: 'PROJECT-\\d{3}', category: 'project-rule' }] },
  }));
  await withProvider({ TOKEN_OPTIMIZER_CONFIG_HOME: configHome, LLM_GATEWAY_TOKEN: 'fixture-token' }, valid, async (bodies) => {
    const result = await queryLocalLLM('task', [], {}, [], 'USER-123 PROJECT-456', 'verdict', workspace);
    assert.equal(result.verdict, 'pass'); assert.equal(bodies.length, 1);
    assert.doesNotMatch(bodies[0], /USER-123|PROJECT-456/);
    assert.deepEqual(result.redactionSummary?.categories, ['project-rule', 'user-rule']);
  });
  fs.rmSync(root, { recursive: true, force: true });
});

test('real inference handler conservatively rejects malformed, oversized, and contradictory responses', async () => {
  const responses = ['{bad', JSON.stringify({ verdict: 'pass', confidence: 1, summary: 'x'.repeat(200_000), likelyRelevantToRecentChanges: false, failures: [], needsRawLogs: false }), JSON.stringify({ verdict: 'pass', confidence: 1, summary: 'contradiction', likelyRelevantToRecentChanges: false, failures: [{ command: 'npm test', message: 'failed' }], needsRawLogs: false })];
  for (const response of responses) await withProvider({ TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', LLM_GATEWAY_URL: 'https://gateway.invalid/v1', LLM_GATEWAY_TOKEN: 'fixture-token' }, response, async () => {
    const result = await queryLocalLLM('task', ['npm test'], { 'npm test': 1 }, [], 'failed');
    assert.notEqual(result.verdict, 'pass'); assert.equal(result.llmAvailable, false);
  });
});

test('shared analytics built by the production sanitizer contain no raw context', () => {
  const record = buildAnalyticsRecord({ toolName: 'run_test_verdict', rawSourceText: 'fixture-secret raw output', llmInputText: 'prompt secret', responseText: 'uncertain', commands: ['cat secret'], targetWorkspacePath: '/private/workspace' });
  assert.doesNotMatch(JSON.stringify(buildSharedAnalyticsRecord(record)), /fixture-secret|prompt secret|cat secret|private\/workspace/);
});
