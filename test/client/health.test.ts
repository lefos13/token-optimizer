import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalLLMHealth, GATEWAY_PROVIDER_NAME } from '../../src/llm';
import { providerHealth, resolveProvider } from '../../src/providers';

test('health pings the gateway /health (stripping the /v1 suffix) and reports available', async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  const orig = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(calledUrl, 'https://llm-proxy.lnf.gr/health');
    assert.equal(res.available, true);
    assert.equal(res.llmProvider, GATEWAY_PROVIDER_NAME);
  } finally {
    globalThis.fetch = orig;
    delete process.env.LLM_GATEWAY_URL;
    delete process.env.LLM_GATEWAY_TOKEN;
  }
});

test('health pings the gateway on OPENROUTER_BYOK_KEY alone, sending no Authorization header', async () => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LLM_GATEWAY_TOKEN;
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  const orig = globalThis.fetch;
  let seenAuth: string | null | undefined;
  globalThis.fetch = (async (_url: any, init?: any) => {
    seenAuth = init?.headers ? new Headers(init.headers).get('authorization') : undefined;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(res.available, true);
    assert.equal(res.llmProvider, GATEWAY_PROVIDER_NAME);
    assert.ok(!seenAuth);
  } finally {
    globalThis.fetch = orig;
    delete process.env.LLM_GATEWAY_URL;
    delete process.env.OPENROUTER_BYOK_KEY;
  }
});

test('health reports unavailable when the gateway ping fails', async () => {
  delete process.env.OPENROUTER_API_KEY;
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response('down', { status: 502 })) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(res.available, false);
  } finally {
    globalThis.fetch = orig;
    delete process.env.LLM_GATEWAY_URL;
    delete process.env.LLM_GATEWAY_TOKEN;
  }
});

test('providerHealth checks an explicitly selected direct provider', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-user';
  const orig = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await providerHealth(resolveProvider({ mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', credentialEnv: 'OPENROUTER_API_KEY' }, 'health'));
    assert.equal(result.available, true);
    assert.equal(calledUrl, 'https://openrouter.ai/api/health');
  } finally {
    globalThis.fetch = orig;
    delete process.env.OPENROUTER_API_KEY;
  }
});
