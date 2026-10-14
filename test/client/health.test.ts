import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalLLMHealth } from '../../src/llm';
import { providerHealth, resolveProvider } from '../../src/providers';

test('health probes openrouter-direct /models and reports available', async () => {
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'shared-token';
  const orig = globalThis.fetch;
  let calledUrl = '';
  let seenAuth = '';
  globalThis.fetch = (async (url: any, init?: any) => {
    calledUrl = String(url);
    seenAuth = init?.headers?.Authorization || '';
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(calledUrl, 'https://openrouter.ai/api/v1/models');
    assert.equal(seenAuth, 'Bearer shared-token');
    assert.equal(res.available, true);
    assert.equal(res.llmProvider, 'openrouter');
  } finally {
    globalThis.fetch = orig;
    delete process.env.TOKEN_OPTIMIZER_PROVIDER_MODE;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('health probes local /models when in local mode', async () => {
  delete process.env.TOKEN_OPTIMIZER_PROVIDER_MODE;
  delete process.env.OPENROUTER_API_KEY;
  const orig = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = (async (url: any) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(calledUrl, 'http://localhost:8080/v1/models');
    assert.equal(res.available, true);
    assert.equal(res.llmProvider, 'local-openai-compatible');
  } finally {
    globalThis.fetch = orig;
  }
});

test('health reports unavailable when the probe fails', async () => {
  process.env.TOKEN_OPTIMIZER_PROVIDER_MODE = 'openrouter-direct';
  process.env.OPENROUTER_API_KEY = 'shared-token';
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response('down', { status: 502 })) as typeof fetch;
  try {
    const res = await checkLocalLLMHealth();
    assert.equal(res.available, false);
  } finally {
    globalThis.fetch = orig;
    delete process.env.TOKEN_OPTIMIZER_PROVIDER_MODE;
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('providerHealth checks an explicitly selected direct provider', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-user';
  const orig = globalThis.fetch;
  let calledUrl = '';
  let seenAuth = '';
  globalThis.fetch = (async (url: any, init?: any) => {
    calledUrl = String(url);
    seenAuth = init?.headers?.Authorization || '';
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await providerHealth(resolveProvider({ mode: 'openrouter-direct', apiUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', credentialEnv: 'OPENROUTER_API_KEY' }, 'health'));
    assert.equal(result.available, true);
    assert.equal(calledUrl, 'https://openrouter.ai/api/v1/models');
    assert.equal(seenAuth, 'Bearer sk-or-user');
  } finally {
    globalThis.fetch = orig;
    delete process.env.OPENROUTER_API_KEY;
  }
});
