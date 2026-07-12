import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { createGatewayServer } from '../../gateway/src/server';
import { loadConfig } from '../../gateway/src/config';

const config = loadConfig({ OPENROUTER_API_KEY: 'sk-' + 'upstream-fixture', PROXY_TOKENS: 'good-token', DEFAULT_MODEL: 'default/model', MODEL_VERDICT: 'verdict/model', RATE_LIMIT_PER_MIN: '60' } as any);

/* A real ephemeral gateway server with an injected upstream verifies the public
   auth/BYOK/rate-limit boundary without network access or retained credentials. */
test('gateway enforces auth, forwards BYOK only upstream, and rate-limits on hashed identity', async () => {
  let upstreamAuth = ''; let limiterIdentity = ''; let calls = 0;
  const server = createGatewayServer(config, {
    fetchImpl: async (_url, init) => { calls += 1; upstreamAuth = new Headers(init?.headers).get('authorization') || ''; return new Response(JSON.stringify({ data: { label: 'fixture' } }), { status: 200 }); },
    rateLimiter: { allow: (identity: string) => { limiterIdentity = identity; return !identity.includes('deny'); } },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const key = 'sk-or-validfixturekey';
    assert.equal((await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': key } })).status, 200);
    assert.equal(upstreamAuth, `Bearer ${key}`); assert.doesNotMatch(limiterIdentity, /validfixturekey/); assert.equal(calls, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('gateway rate limit rejects before injected upstream sees BYOK', async () => {
  let calls = 0; const server = createGatewayServer(config, { fetchImpl: async () => { calls += 1; return new Response('{}'); }, rateLimiter: { allow: () => false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { assert.equal((await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-validfixturekey' } })).status, 429); assert.equal(calls, 0); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
