import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, GATEWAY_PROVIDER_NAME, queryLocalLLM } from '../../src/llm';
import type { ProviderConfig } from '../../src/providers';

function directConfig(key: string): ProviderConfig {
  process.env.OPENROUTER_API_KEY = key;
  return { mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', credentialEnv: 'OPENROUTER_API_KEY' };
}

function gatewayByokConfig(key: string): ProviderConfig {
  process.env.OPENROUTER_BYOK_KEY = key;
  return { mode: 'gateway-byok', apiUrl: 'https://llm-proxy.lnf.gr/v1', model: 'gateway-managed', credentialEnv: 'OPENROUTER_BYOK_KEY' };
}

function clearEnv(): void {
  delete process.env.LLM_GATEWAY_URL;
  delete process.env.LLM_GATEWAY_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LOCAL_LLM_API_URL;
  delete process.env.OPENROUTER_BYOK_KEY;
  delete process.env.OPENROUTER_BYOK_MODEL;
}

test('resolveProvider prefers the gateway when its token+url are set', () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  const p = resolveProvider('verdict');
  assert.equal(p.providerName, GATEWAY_PROVIDER_NAME);
  assert.equal(p.apiUrl, 'https://llm-proxy.lnf.gr/v1');
  assert.equal(p.authHeaders['Authorization'], 'Bearer shared-token');
  assert.equal(p.authHeaders['X-Task-Type'], 'verdict');
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

test('gateway-byok carries an explicit trust disclosure', () => {
  clearEnv();
  const provider = resolveProvider(gatewayByokConfig('sk-or-user'), 'triage');
  assert.match(provider.warnings.join('\n'), /key.*gateway/i);
  clearEnv();
});

test('explicit credentialEnv selects the configured direct-provider secret', () => {
  clearEnv();
  process.env.CUSTOM_OPENROUTER_SECRET = 'sk-custom';
  const provider = resolveProvider({ mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'm', credentialEnv: 'CUSTOM_OPENROUTER_SECRET' }, 'triage');
  assert.equal(provider.authHeaders.Authorization, 'Bearer sk-custom');
  delete process.env.CUSTOM_OPENROUTER_SECRET;
});

test('resolveProvider adds X-OpenRouter-Key when OPENROUTER_BYOK_KEY is set, omits it otherwise', () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  const withByok = resolveProvider('verdict');
  assert.equal(withByok.authHeaders['X-OpenRouter-Key'], 'sk-or-v1-mykey');
  delete process.env.OPENROUTER_BYOK_KEY;
  const withoutByok = resolveProvider('verdict');
  assert.ok(!('X-OpenRouter-Key' in withoutByok.authHeaders));
  clearEnv();
});

test('resolveProvider sends a trimmed BYOK model only beside a BYOK key', () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  process.env.OPENROUTER_BYOK_MODEL = '  openai/gpt-4o-mini  ';
  const withByok = resolveProvider('verdict');
  assert.equal(withByok.authHeaders['X-OpenRouter-Model'], 'openai/gpt-4o-mini');

  delete process.env.OPENROUTER_BYOK_KEY;
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  const withoutByok = resolveProvider('verdict');
  assert.ok(!('X-OpenRouter-Model' in withoutByok.authHeaders));

  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  process.env.OPENROUTER_BYOK_MODEL = '   ';
  const blank = resolveProvider('verdict');
  assert.ok(!('X-OpenRouter-Model' in blank.authHeaders));
  clearEnv();
});

test('resolveProvider engages the gateway on OPENROUTER_BYOK_KEY alone, with no Authorization header at all', () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  const p = resolveProvider('verdict');
  assert.equal(p.providerName, GATEWAY_PROVIDER_NAME);
  assert.equal(p.authHeaders['X-OpenRouter-Key'], 'sk-or-v1-mykey');
  assert.ok(!('Authorization' in p.authHeaders));
  clearEnv();
});

test('resolveProvider falls back to local when no gateway env is set', () => {
  clearEnv();
  const p = resolveProvider('triage');
  assert.equal(p.providerName, 'local-openai-compatible');
  clearEnv();
});

test('OPENROUTER_API_KEY alone no longer selects a remote provider (legacy path removed)', () => {
  clearEnv();
  process.env.OPENROUTER_API_KEY = 'sk-legacy';
  const p = resolveProvider('verdict');
  assert.equal(p.providerName, 'local-openai-compatible');
  clearEnv();
});

test('gateway result reports the model from the response body', async () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
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
    assert.equal(result.llmProvider, GATEWAY_PROVIDER_NAME);
  } finally {
    globalThis.fetch = orig;
    clearEnv();
  }
});

test('invalid remote output returns conservative fallback with validation metadata', async () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
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

test('gateway failure falls back to the local model', async () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  process.env.LOCAL_LLM_API_URL = 'http://127.0.0.1:8080/v1';
  const orig = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return new Response('nope', { status: 502 }); // gateway path fails
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
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
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
