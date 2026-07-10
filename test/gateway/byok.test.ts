import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { RateLimiter } from '../../gateway/src/rate-limit';
import { createGatewayServer } from '../../gateway/src/server';
import { loadConfig } from '../../gateway/src/config';

/* BYOK (bring-your-own-key) pass-through: a caller can add X-OpenRouter-Key so
   the call bills against their own OpenRouter account instead of the
   operator's. A valid BYOK key means NO proxy/issued token is required at all
   — the caller isn't using the operator's OpenRouter setup, so the gateway
   only proxies and pins the model; it does not authenticate a BYOK-only
   caller. Non-BYOK requests are unaffected: they still need a valid token. */

const VALID_BYOK = 'sk-or-v1-abcdefghijklmnop0123456789';

function makeConfig(stateDir: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    OPENROUTER_API_KEY: 'sk-operator-real',
    PROXY_TOKENS: 'shared-token',
    DEFAULT_MODEL: 'default/model',
    RATE_LIMIT_PER_MIN: '0',
    STATE_DIR: stateDir,
    ADMIN_TOKEN: 'admin-secret',
    DEFAULT_DAILY_LIMIT: '1',
    TOKEN_REQUESTS_PER_MIN: '0',
    ...overrides
  } as any);
}

async function withServer(
  fetchImpl: typeof fetch,
  run: (base: string) => Promise<void>,
  overrides: Record<string, string> = {},
  deps: { rateLimiter?: RateLimiter } = {}
): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-byok-'));
  const server = createGatewayServer(makeConfig(stateDir, overrides), { fetchImpl, ...deps });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function chat(
  base: string,
  token?: string,
  byokKey?: string,
  byokModel?: string,
  taskType?: string
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(byokKey ? { 'X-OpenRouter-Key': byokKey } : {}),
      ...(byokModel !== undefined ? { 'X-OpenRouter-Model': byokModel } : {}),
      ...(taskType ? { 'X-Task-Type': taskType } : {})
    },
    body: JSON.stringify({ messages: [] })
  });
}

const okUpstream: typeof fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], model: 'x' }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });

test('a valid BYOK model overrides the gateway model for every task', async () => {
  const seenModels: string[] = [];
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenModels.push(JSON.parse(String(init?.body)).model);
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    assert.equal((await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini')).status, 200);
    assert.equal((await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini', 'triage')).status, 200);
  }, { MODEL_TRIAGE: 'gateway/triage' });
  assert.deepEqual(seenModels, ['openai/gpt-4o-mini', 'openai/gpt-4o-mini']);
});

test('missing or explicitly empty override keeps gateway selection and non-BYOK callers cannot override it', async () => {
  const seenModels: string[] = [];
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenModels.push(JSON.parse(String(init?.body)).model);
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    assert.equal((await chat(base, undefined, VALID_BYOK, '')).status, 200);
    assert.equal((await chat(base, undefined, VALID_BYOK, '', 'triage')).status, 200);
    assert.equal((await chat(base, undefined, VALID_BYOK, undefined, 'triage')).status, 200);
    assert.equal((await chat(base, 'shared-token', undefined, 'openai/gpt-4o-mini', 'triage')).status, 200);
  }, { MODEL_TRIAGE: 'gateway/triage' });
  assert.deepEqual(seenModels, ['default/model', 'gateway/triage', 'gateway/triage', 'gateway/triage']);
});

test('an invalid BYOK model returns 400 without calling OpenRouter', async () => {
  let calls = 0;
  const spyUpstream: typeof fetch = async () => {
    calls += 1;
    return okUpstream('', {});
  };
  await withServer(spyUpstream, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK, 'openai/not valid');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid BYOK model' });
  });
  assert.equal(calls, 0);
});

test('an upstream error for a valid BYOK model is forwarded unchanged', async () => {
  const unavailable: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${VALID_BYOK}`);
    assert.equal(JSON.parse(String(init?.body)).model, 'openai/gpt-4o-mini');
    return new Response(JSON.stringify({ error: 'model unavailable' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  };
  await withServer(unavailable, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'model unavailable' });
  });
});

test('a valid BYOK key with NO Authorization header at all is accepted and billed to that key', async () => {
  let seenAuth: string | null = null;
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK);
    assert.equal(res.status, 200);
    assert.equal(seenAuth, `Bearer ${VALID_BYOK}`);
  });
});

test('a valid BYOK key is honored even alongside an invalid/unknown proxy token', async () => {
  await withServer(okUpstream, async (base) => {
    const res = await chat(base, 'not-a-real-proxy-token', VALID_BYOK);
    assert.equal(res.status, 200);
  });
});

test('BYOK never consumes an issued token\'s daily limit, even when one is presented alongside it', async () => {
  await withServer(okUpstream, async (base) => {
    await fetch(`${base}/v1/token-requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'byok@example.com' })
    });
    const approveRes = await fetch(`${base}/admin/api/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-secret' },
      body: JSON.stringify({ email: 'byok@example.com' })
    });
    const { token } = (await approveRes.json()) as any;

    /* DEFAULT_DAILY_LIMIT is 1: the first BYOK call would normally exhaust it,
       but BYOK calls never consume, so unlimited BYOK calls all succeed... */
    assert.equal((await chat(base, token, VALID_BYOK)).status, 200);
    assert.equal((await chat(base, token, VALID_BYOK)).status, 200);
    assert.equal((await chat(base, token, VALID_BYOK)).status, 200);

    /* ...while a normal (non-BYOK) call still consumes the untouched daily allowance. */
    assert.equal((await chat(base, token)).status, 200);
    assert.equal((await chat(base, token)).status, 429);
  });
});

test('a malformed or missing BYOK header requires a valid proxy/issued token as usual', async () => {
  let seenAuth: string | null = null;
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenAuth = new Headers(init?.headers).get('authorization');
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    const withGarbageKey = await chat(base, 'shared-token', 'not-a-real-key');
    assert.equal(withGarbageKey.status, 200);
    assert.equal(seenAuth, 'Bearer sk-operator-real');

    const noKeyNoToken = await chat(base, undefined, undefined);
    assert.equal(noKeyNoToken.status, 401);
  });
});

test('ALLOW_BYOK=false disables the pass-through: a BYOK-only request is rejected and a valid token is required', async () => {
  await withServer(okUpstream, async (base) => {
    const byokOnly = await chat(base, undefined, VALID_BYOK);
    assert.equal(byokOnly.status, 401);

    const withSharedToken = await chat(base, 'shared-token', VALID_BYOK);
    assert.equal(withSharedToken.status, 200);
  }, { ALLOW_BYOK: 'false' });
});

test('BYOK-only requests are still rate limited, bucketed by a hash of the key when no token is presented', async () => {
  const seenKeys: string[] = [];
  const spyLimiter: RateLimiter = { allow: (key) => { seenKeys.push(key); return true; } };
  await withServer(okUpstream, async (base) => {
    await chat(base, undefined, VALID_BYOK);
    await chat(base, 'shared-token', VALID_BYOK);
  }, {}, { rateLimiter: spyLimiter });
  assert.equal(seenKeys.length, 2);
  assert.match(seenKeys[0], /^byok:[a-f0-9]{16}$/);
  assert.equal(seenKeys[1], 'shared-token');
});

test('the BYOK key is never reflected in an upstream error response', async () => {
  const errUpstream: typeof fetch = async () =>
    new Response(JSON.stringify({ error: 'upstream boom' }), { status: 502, headers: { 'content-type': 'application/json' } });
  await withServer(errUpstream, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK);
    const text = await res.text();
    assert.ok(!text.includes(VALID_BYOK));
  });
});
