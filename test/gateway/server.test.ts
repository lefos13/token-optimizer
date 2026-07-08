import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { createGatewayServer } from '../../gateway/src/server';
import { loadConfig } from '../../gateway/src/config';

const config = loadConfig({
  OPENROUTER_API_KEY: 'sk-real', PROXY_TOKENS: 'good-token',
  DEFAULT_MODEL: 'default/model', MODEL_VERDICT: 'verdict/model', RATE_LIMIT_PER_MIN: '0'
} as any);

/* Start the real server on an ephemeral port with a stubbed upstream fetch so
   we assert on what the gateway would send to OpenRouter and return to callers. */
async function withServer(
  fetchImpl: typeof fetch,
  run: (base: string) => Promise<void>
): Promise<void> {
  const server = createGatewayServer(config, { fetchImpl });
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
