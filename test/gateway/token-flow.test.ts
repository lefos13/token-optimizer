import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { createGatewayServer } from '../../gateway/src/server';
import { loadConfig } from '../../gateway/src/config';

/* End-to-end coverage of the token request → approve → use → limit → revoke
   lifecycle, the analytics ingest path, and the public stats surfaces, all
   against the real HTTP server with a stubbed upstream and no email provider
   (so approve returns the plaintext token for manual delivery). */

const okUpstream: typeof fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], model: 'default/model' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

function makeConfig(stateDir: string) {
  return loadConfig({
    OPENROUTER_API_KEY: 'sk-real',
    PROXY_TOKENS: 'shared-token',
    DEFAULT_MODEL: 'default/model',
    RATE_LIMIT_PER_MIN: '0',
    STATE_DIR: stateDir,
    ADMIN_TOKEN: 'admin-secret',
    DEFAULT_DAILY_LIMIT: '2',
    TOKEN_REQUESTS_PER_MIN: '0'
  } as any);
}

async function withServer(run: (base: string) => Promise<void>): Promise<void> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-flow-'));
  const server = createGatewayServer(makeConfig(stateDir), { fetchImpl: okUpstream });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

function chat(base: string, token: string): Promise<Response> {
  return post(base, '/v1/chat/completions', { messages: [] }, token);
}

test('full issued-token lifecycle: request, approve, daily limit, limit bump, revoke', async () => {
  await withServer(async (base) => {
    /* Public request; duplicate is rejected forever. */
    assert.equal((await post(base, '/v1/token-requests', { email: 'user@example.com' })).status, 202);
    assert.equal((await post(base, '/v1/token-requests', { email: 'User@Example.com' })).status, 409);
    assert.equal((await post(base, '/v1/token-requests', { email: 'nope' })).status, 400);

    /* Admin API requires the admin token. */
    assert.equal((await fetch(`${base}/admin/api/requests`)).status, 401);
    assert.equal((await post(base, '/admin/api/approve', { email: 'user@example.com' }, 'wrong')).status, 401);

    /* Approve without an email provider returns the plaintext once. */
    const approveRes = await post(base, '/admin/api/approve', { email: 'user@example.com' }, 'admin-secret');
    assert.equal(approveRes.status, 200);
    const approved = (await approveRes.json()) as any;
    assert.equal(approved.emailSent, false);
    assert.ok(approved.token.startsWith('to_'));

    /* Issued token works for chat and for an authenticated health check. */
    const health = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${approved.token}` } });
    assert.equal(health.status, 200);
    assert.equal((await chat(base, approved.token)).status, 200);
    assert.equal((await chat(base, approved.token)).status, 200);

    /* Third call of the day hits the daily limit (DEFAULT_DAILY_LIMIT=2). */
    const limited = await chat(base, approved.token);
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as any).error, 'daily limit reached');

    /* Admin raises the limit; calls flow again. */
    assert.equal((await post(base, '/admin/api/limit', { email: 'user@example.com', dailyLimit: 5 }, 'admin-secret')).status, 200);
    assert.equal((await chat(base, approved.token)).status, 200);

    /* Requests listing exposes usage but never token hashes. */
    const listRes = await fetch(`${base}/admin/api/requests`, { headers: { Authorization: 'Bearer admin-secret' } });
    const list = (await listRes.json()) as any;
    assert.equal(list.requests[0].email, 'user@example.com');
    assert.equal(list.requests[0].usageCount, 3);
    assert.equal(list.requests[0].tokenHash, undefined);

    /* Revoke kills the token immediately; shared token is unaffected. */
    assert.equal((await post(base, '/admin/api/revoke', { email: 'user@example.com' }, 'admin-secret')).status, 200);
    assert.equal((await chat(base, approved.token)).status, 401);
    assert.equal((await chat(base, 'shared-token')).status, 200);
  });
});

test('analytics ingest feeds the public stats JSON and showcase page', async () => {
  await withServer(async (base) => {
    assert.equal((await post(base, '/v1/analytics', { toolName: 'run_test_verdict' })).status, 401);
    const accepted = await post(base, '/v1/analytics', {
      toolName: 'run_test_verdict',
      rawSourceTokens: 1000,
      returnedToMainTokens: 100,
      estimatedTokensSaved: 900,
      savingsPercentage: 0.9,
      localLlmTotalTokens: 400,
      llmModel: 'default/model'
    }, 'shared-token');
    assert.equal(accepted.status, 202);

    const stats = (await (await fetch(`${base}/v1/stats`)).json()) as any;
    assert.equal(stats.totalCalls, 1);
    assert.equal(stats.totalTokensSaved, 900);
    assert.equal(stats.byTool.run_test_verdict.calls, 1);

    const page = await fetch(`${base}/stats`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('token-optimizer'));
    assert.ok(html.includes('run_test_verdict'));
  });
});

test('root serves the public access request portal', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('Request access'));
    assert.ok(html.includes('/v1/token-requests'));
    assert.ok(html.includes('type="email"'));
    assert.ok(html.includes('You will receive your token after approval.'));
  });
});

test('admin routes are disabled entirely without ADMIN_TOKEN', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-noadmin-'));
  const config = loadConfig({
    OPENROUTER_API_KEY: 'sk-real', PROXY_TOKENS: 'shared-token',
    STATE_DIR: stateDir, RATE_LIMIT_PER_MIN: '0'
  } as any);
  const server = createGatewayServer(config, { fetchImpl: okUpstream });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/admin`)).status, 404);
    assert.equal((await fetch(`${base}/admin/api/requests`, { headers: { Authorization: 'Bearer anything' } })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
