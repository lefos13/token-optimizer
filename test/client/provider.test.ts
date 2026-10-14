import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, queryLocalLLM } from '../../src/llm';
import type { ProviderConfig } from '../../src/providers';

function directConfig(key: string): ProviderConfig {
  process.env.OPENROUTER_API_KEY = key;
  return { mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', credentialEnv: 'OPENROUTER_API_KEY' };
}

function clearEnv(): void {
  delete process.env.LLM_GATEWAY_URL;
  delete process.env.LLM_GATEWAY_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LOCAL_LLM_API_URL;
  delete process.env.LOCAL_LLM_MODEL;
  delete process.env.LOCAL_LLM_TRIAGE_MODEL;
  delete process.env.OPENROUTER_BYOK_KEY;
  delete process.env.OPENROUTER_BYOK_MODEL;
  delete process.env.TOKEN_OPTIMIZER_PROVIDER_MODE;
}

test('resolveProvider resolves openrouter-direct when OPENROUTER_API_KEY is set', () => {
  clearEnv();
  process.env.OPENROUTER_API_KEY = 'direct-token';
  const p = resolveProvider('verdict');
  assert.equal(p.providerName, 'openrouter');
  assert.equal(p.apiUrl, 'https://openrouter.ai/api/v1');
  assert.equal(p.authHeaders['Authorization'], 'Bearer direct-token');
  clearEnv();
});

test('openrouter-direct sends bearer auth directly to OpenRouter', () => {
  clearEnv();
  const provider = resolveProvider(directConfig('sk-or-user'), 'triage');
  assert.equal(provider.mode, 'openrouter-direct');
  assert.equal(provider.apiUrl, 'https://openrouter.ai/api/v1');
  assert.equal(provider.authHeaders.Authorization, 'Bearer sk-or-user');
  assert.ok(!('X-OpenRouter-Key' in provider.authHeaders));
  clearEnv();
});

test('explicit credentialEnv selects the configured direct-provider secret', () => {
  clearEnv();
  process.env.CUSTOM_OPENROUTER_SECRET = 'sk-custom';
  const provider = resolveProvider({ mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'm', credentialEnv: 'CUSTOM_OPENROUTER_SECRET' }, 'triage');
  assert.equal(provider.authHeaders.Authorization, 'Bearer sk-custom');
  delete process.env.CUSTOM_OPENROUTER_SECRET;
});

test('resolveProvider falls back to local when no OPENROUTER_API_KEY is set', () => {
  clearEnv();
  const p = resolveProvider('triage');
  assert.equal(p.providerName, 'local-openai-compatible');
  clearEnv();
});

test('remote openrouter result reports the model from the response body', async () => {
  clearEnv();
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'test-token';
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"verdict":"pass","confidence":0.9,"summary":"ok","likelyRelevantToRecentChanges":false,"failures":[],"needsRawLogs":false}' } }],
        model: 'anthropic/claude-3.5'
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
  try {
    const result = await queryLocalLLM('t', ['npm test'], { 'npm test': 0 }, [], 'logs', 'verdict');
    assert.equal(result.verdict, 'pass');
    assert.equal(result.llmModel, 'anthropic/claude-3.5');
    assert.equal(result.llmProvider, 'openrouter');
  } finally {
    globalThis.fetch = orig;
    clearEnv();
  }
});

test('invalid remote output returns conservative fallback with validation metadata', async () => {
  clearEnv();
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'test-token';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"pass"}' } }] }), { status: 200 })) as typeof fetch;
  try {
    const result = await queryLocalLLM('t', [], {}, [], 'logs', 'verdict');
    assert.equal(result.verdict, 'uncertain');
    assert.ok(result.validationErrors && result.validationErrors.length > 0);
    assert.equal(result.llmAvailable, false);
  } finally {
    globalThis.fetch = originalFetch;
    clearEnv();
  }
});

test('openrouter failure falls back to the local model', async () => {
  clearEnv();
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'test-token';
  process.env.LOCAL_LLM_API_URL = 'http://127.0.0.1:8080/v1';
  const orig = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return new Response('nope', { status: 502 }); // openrouter path fails
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"verdict":"pass","confidence":0.9,"summary":"local","likelyRelevantToRecentChanges":false,"failures":[],"needsRawLogs":false}' } }],
        model: 'local-model'
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const result = await queryLocalLLM('t', ['npm test'], { 'npm test': 0 }, [], 'logs', 'verdict');
    assert.equal(result.llmProvider, 'local-openai-compatible');
    assert.match(String(result.fallbackReason), /failed/i);
  } finally {
    globalThis.fetch = orig;
    clearEnv();
  }
});

test('local fallback prefers the task-specific model environment', async () => {
  clearEnv();
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'test-token';
  process.env.LOCAL_LLM_MODEL = 'shared-local';
  process.env.LOCAL_LLM_TRIAGE_MODEL = 'triage-local';
  const orig = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async (_url: any, init?: any) => {
    call++;
    if (call === 1) return new Response('nope', { status: 502 });
    assert.equal(JSON.parse(init.body).model, 'triage-local');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"pass","confidence":0.9,"summary":"ok","likelyRelevantToRecentChanges":false,"failures":[],"needsRawLogs":false}' } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    await queryLocalLLM('t', ['npm test'], { 'npm test': 0 }, [], 'logs', 'triage');
  } finally {
    globalThis.fetch = orig;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.LOCAL_LLM_TRIAGE_MODEL;
    clearEnv();
  }
});
