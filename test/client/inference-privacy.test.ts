import test from 'node:test';
import assert from 'node:assert/strict';
import { queryLocalLLM } from '../../src/llm';

const valid = JSON.stringify({
  verdict: 'pass', confidence: 0.9, summary: 'ok',
  likelyRelevantToRecentChanges: false, failures: [], needsRawLogs: false
});

function clearEnv(): void {
  delete process.env.LLM_GATEWAY_URL;
  delete process.env.LLM_GATEWAY_TOKEN;
  delete process.env.LOCAL_LLM_API_URL;
}

test('remote fetch never receives a recognized secret', async () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://gateway.example/v1';
  process.env.LLM_GATEWAY_TOKEN = 'gateway-token';
  const originalFetch = globalThis.fetch;
  let outbound = '';
  globalThis.fetch = (async (_url, init) => {
    outbound = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await queryLocalLLM('task', ['npm test'], { 'npm test': 1 }, [], 'OPENAI_API_KEY=sk-live-secret');
    assert.doesNotMatch(outbound, /sk-live-secret/);
    assert.match(outbound, /\*\*\*/);
    assert.equal(result.redactionSummary?.count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv();
  }
});

test('local inference preserves diagnostic text without redaction metadata', async () => {
  clearEnv();
  const originalFetch = globalThis.fetch;
  let outbound = '';
  globalThis.fetch = (async (_url, init) => {
    outbound = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: valid } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await queryLocalLLM('task', [], {}, [], 'OPENAI_API_KEY=sk-live-secret');
    assert.match(outbound, /sk-live-secret/);
    assert.equal(result.redactionSummary, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
