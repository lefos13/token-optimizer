import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { createGatewayServer } from '../../gateway/src/server';
import { loadConfig } from '../../gateway/src/config';
import { createRateLimiter } from '../../gateway/src/rate-limit';

const config = loadConfig({
  OPENROUTER_API_KEY: 'sk-real', PROXY_TOKENS: 'good-token',
  DEFAULT_MODEL: 'default/model', MODEL_VERDICT: 'verdict/model', RATE_LIMIT_PER_MIN: '0'
} as any);

/* Start the real server on an ephemeral port with a stubbed upstream fetch so
   we assert on what the gateway would send to OpenRouter and return to callers. */
async function withServer(
  fetchImpl: typeof fetch,
  run: (base: string) => Promise<void>,
  options: { rateLimiter?: { allow(key: string): boolean }; providerHealthMaxConcurrency?: number; config?: typeof config } = {}
): Promise<void> {
  const server = createGatewayServer(options.config || config, { fetchImpl, rateLimiter: options.rateLimiter, providerHealthMaxConcurrency: options.providerHealthMaxConcurrency });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const okUpstream: typeof fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], model: 'verdict/model' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

test('GET /health returns ok without auth', async () => {
  await withServer(okUpstream, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /health validates a presented token and accepts a valid one', async () => {
  await withServer(okUpstream, async (base) => {
    const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer good-token' } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test('GET /health rejects a presented invalid token with 401', async () => {
  await withServer(okUpstream, async (base) => {
    const res = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong' } });
    assert.equal(res.status, 401);
  });
});

test('GET /v1/provider-health validates BYOK upstream without inference', async () => {
  let seenUrl = ''; let seenAuth = '';
  const upstream: typeof fetch = async (url, init) => {
    seenUrl = String(url); seenAuth = new Headers(init?.headers).get('authorization') || '';
    return new Response(JSON.stringify({ data: { label: 'key' } }), { status: 200 });
  };
  await withServer(upstream, async (base) => {
    const valid = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-validfixturekey' } });
    assert.equal(valid.status, 200); assert.match(seenUrl, /\/auth\/key$/); assert.equal(seenAuth, 'Bearer sk-or-validfixturekey');
  });
});

test('GET /v1/provider-health rejects invalid BYOK metadata auth', async () => {
  await withServer(async () => new Response('{}', { status: 401 }), async (base) => {
    const invalid = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-invalidfixture' } });
    assert.equal(invalid.status, 401);
  });
});

test('GET /v1/provider-health rate limits before contacting upstream without retaining the raw key', async () => {
  let upstreamCalls = 0; let limiterKey = '';
  await withServer(async () => { upstreamCalls++; return new Response('{}', { status: 200 }); }, async (base) => {
    const response = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-validfixturekey' } });
    assert.equal(response.status, 429);
    assert.equal(upstreamCalls, 0);
    assert.doesNotMatch(limiterKey, /validfixturekey/);
  }, { rateLimiter: { allow: (key) => { limiterKey = key; return false; } } });
});

test('GET /v1/provider-health limits socket IP independently when callers rotate BYOK keys', async () => {
  let upstreamCalls = 0;
  await withServer(async () => { upstreamCalls++; return new Response('{}', { status: 200 }); }, async (base) => {
    const first = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-firstfixturekey', 'X-Forwarded-For': '198.51.100.1' } });
    const second = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-secondfixturekey', 'X-Forwarded-For': '198.51.100.2' } });
    assert.equal(first.status, 200); assert.equal(second.status, 429); assert.equal(upstreamCalls, 1);
  }, { rateLimiter: createRateLimiter(1) });
});

test('GET /v1/provider-health bounds concurrent upstream probes', async () => {
  let release!: () => void; let upstreamCalls = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await withServer(async () => { upstreamCalls++; await pending; return new Response('{}', { status: 200 }); }, async (base) => {
    const headers = { 'X-OpenRouter-Key': 'sk-or-validfixturekey' };
    const first = fetch(`${base}/v1/provider-health`, { headers });
    while (upstreamCalls === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = await fetch(`${base}/v1/provider-health`, { headers });
    assert.equal(second.status, 429); assert.equal(upstreamCalls, 1);
    release(); assert.equal((await first).status, 200);
  }, { providerHealthMaxConcurrency: 1 });
});

test('GET /v1/provider-health aborts a timed-out upstream probe and releases concurrency', async () => {
  const shortTimeout = { ...config, upstreamTimeoutMs: 10 };
  await withServer(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), async (base) => {
    const response = await fetch(`${base}/v1/provider-health`, { headers: { 'X-OpenRouter-Key': 'sk-or-validfixturekey' } });
    assert.equal(response.status, 502);
  }, { providerHealthMaxConcurrency: 1, config: shortTimeout });
});

test('POST /v1/chat/completions rejects a missing/invalid token with 401', async () => {
  await withServer(okUpstream, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: 'client/asked', messages: [] })
    });
    assert.equal(res.status, 401);
  });
});

test('gateway pins model per task type and injects the real key upstream', async () => {
  let seenModel: string | undefined;
  let seenAuth: string | null = null;
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    seenModel = JSON.parse(String(init?.body)).model;
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token', 'X-Task-Type': 'verdict' },
      body: JSON.stringify({ model: 'client/asked', messages: [] })
    });
    assert.equal(res.status, 200);
    assert.equal(seenModel, 'verdict/model');       // client's model overridden
    assert.equal(seenAuth, 'Bearer sk-real');       // real key injected
    assert.equal(((await res.json()) as any).model, 'verdict/model'); // response passed through verbatim
  });
});

test('upstream error status is forwarded to the caller', async () => {
  const errUpstream: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'upstream boom' }), { status: 502, headers: { 'content-type': 'application/json' } });
  await withServer(errUpstream, async (base) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token', 'X-Task-Type': 'verdict' },
      body: JSON.stringify({ messages: [] })
    });
    assert.equal(res.status, 502);
  });
});
