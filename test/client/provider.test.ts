import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, GATEWAY_PROVIDER_NAME, queryLocalLLM } from '../../src/llm';

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
