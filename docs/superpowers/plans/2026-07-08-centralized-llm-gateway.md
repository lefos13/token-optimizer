# Centralized LLM Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the OpenRouter-calling layer of `local-tester-mcp` behind a shared HTTPS gateway on a DigitalOcean droplet, so users hold a revocable proxy token instead of the real OpenRouter key and the model is chosen centrally.

**Architecture:** The local MCP server keeps running commands and reading files locally; it only repoints its "remote LLM" calls at the droplet. The droplet runs a tiny Node HTTP gateway (behind Caddy for TLS) that authenticates a shared bearer token, pins the model per task type, and forwards to OpenRouter with the real key. If the gateway is unreachable, the client falls back to the user's local model exactly as it does today.

**Tech Stack:** TypeScript (existing `tsc` toolchain), Node 18+ built-ins only (`node:http`, global `fetch`/`Response`, `node:crypto`, `node:test`, `node:assert`). Caddy + systemd on the droplet. No new npm dependencies.

## Global Constraints

- **No new runtime npm dependencies.** Gateway and client use Node built-ins only. Node 18+ is required (global `fetch`/`Response`/`AbortController`).
- **Command exit codes remain authoritative.** This change touches only the LLM transport; no verdict/triage adjudication logic changes.
- **Tool contracts stay stable.** No MCP tool name, input schema, or output field is added or removed. Behavior changes are driven entirely by environment variables.
- **Analytics stay per-workspace.** Written under `<workspacePath>/.codex-local-test-runs/`, never the server's own directory. No server-side analytics.
- **Secrets never in git.** The real `OPENROUTER_API_KEY` and proxy tokens live only in the droplet's env file. Example files use placeholders.
- **Docs + plugin sync on contract/setup change (AGENTS.md).** When env vars / setup change: update `README.md` and `skill/skill-example.md`, bump `VERSION` in all three generators (`generate-plugin-antigravity.js`, `generate-plugin-claude.js`, `generate-plugin-codex.js`) from `1.2.6` to `1.3.0`, then run `npm run build:plugin`. Never edit `plugin/` by hand.
- **Comment style:** `/* ... */` block comments atop large added/modified blocks; no stacks of `//`.
- **Gateway task types mirror `LLMTaskType`** in `src/llm.ts` (the model-facing subset: `verdict`, `triage`, `review`, `digest`, `scout`, `query` — `health` never hits the model).

---

## File Structure

**New — gateway service (compiled by root toolchain into `gateway/dist`, gitignored):**
- `gateway/src/config.ts` — load + validate `GatewayConfig` from env.
- `gateway/src/auth.ts` — bearer extraction + constant-time token check.
- `gateway/src/model-map.ts` — resolve task type → pinned model.
- `gateway/src/rate-limit.ts` — in-memory fixed-window limiter (injectable clock).
- `gateway/src/server.ts` — `createGatewayServer(config, deps)`: routes `/health` and `/v1/chat/completions`.
- `gateway/src/index.ts` — entry point: load config, listen on loopback.
- `gateway/deploy/Caddyfile.example`, `gateway/deploy/local-tester-gateway.service`, `gateway/deploy/gateway.env.example` — deployment assets.
- `gateway/README.md` — droplet deployment doc.

**New — test harness (gitignored build output):**
- `tsconfig.test.json` — compiles `src`, `gateway/src`, and `test/` to `.test-build/`.
- `tsconfig.gateway.json` — compiles `gateway/src` to `gateway/dist`.
- `test/gateway/*.test.ts`, `test/client/*.test.ts` — Node built-in tests.

**Modified:**
- `src/llm.ts` — gateway provider resolution, `X-Task-Type` header, model-from-response, generalized remote→local fallback, gateway health ping.
- `package.json` — add `build:gateway`, `start:gateway`, `test` scripts.
- `.gitignore` — add `.test-build/` and `gateway/dist/`.
- `.mcp.json` — example env swaps real OpenRouter key for gateway URL + token.
- `README.md`, `skill/skill-example.md` — document new env vars + gateway setup.
- `scripts/generate-plugin-*.js` — `VERSION` `1.2.6` → `1.3.0`.

---

## Task 1: Gateway pure core + test harness

Sets up the zero-dependency test harness and the gateway's pure modules (config, auth, model-map, rate-limit) with tests.

**Files:**
- Create: `tsconfig.test.json`, `tsconfig.gateway.json`
- Create: `gateway/src/config.ts`, `gateway/src/auth.ts`, `gateway/src/model-map.ts`, `gateway/src/rate-limit.ts`
- Create: `test/gateway/config.test.ts`, `test/gateway/auth.test.ts`, `test/gateway/model-map.test.ts`, `test/gateway/rate-limit.test.ts`
- Modify: `package.json` (scripts), `.gitignore`

**Interfaces:**
- Produces:
  - `type GatewayTaskType = 'verdict'|'triage'|'review'|'digest'|'scout'|'query'`
  - `interface GatewayConfig { port:number; openRouterKey:string; openRouterUrl:string; tokens:string[]; defaultModel:string; taskModels:Partial<Record<GatewayTaskType,string>>; rateLimitPerMin:number; maxBodyBytes:number; upstreamTimeoutMs:number }`
  - `function loadConfig(env?:NodeJS.ProcessEnv): GatewayConfig`
  - `function extractBearer(header:string|undefined): string|null`
  - `function isAuthorized(header:string|undefined, tokens:string[]): boolean`
  - `function resolveModel(taskTypeHeader:string|undefined, config:GatewayConfig): string`
  - `interface RateLimiter { allow(key:string): boolean }`
  - `function createRateLimiter(perMin:number, now?:()=>number): RateLimiter`

- [ ] **Step 1: Add gitignore entries**

Append to `.gitignore` (after the `dist/` line group):

```
.test-build/
gateway/dist/
```

- [ ] **Step 2: Create the two build configs**

`tsconfig.gateway.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./gateway/dist",
    "rootDir": "./gateway/src"
  },
  "include": ["gateway/src/**/*"]
}
```

`tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "./.test-build",
    "rootDir": "."
  },
  "include": ["src/**/*", "gateway/src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Add npm scripts**

Modify `package.json` `scripts` — add these three keys (keep existing scripts):

```json
"build:gateway": "tsc -p tsconfig.gateway.json",
"start:gateway": "node gateway/dist/index.js",
"test": "tsc -p tsconfig.test.json && node --test .test-build/test"
```

- [ ] **Step 4: Write failing tests for config, auth, model-map, rate-limit**

`test/gateway/config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config';

const base = { OPENROUTER_API_KEY: 'sk-real', PROXY_TOKENS: 'tok1, tok2' };

test('loadConfig requires the OpenRouter key', () => {
  assert.throws(() => loadConfig({ PROXY_TOKENS: 'tok1' } as any), /OPENROUTER_API_KEY/);
});

test('loadConfig requires at least one proxy token', () => {
  assert.throws(() => loadConfig({ OPENROUTER_API_KEY: 'sk-real' } as any), /PROXY_TOKENS/);
});

test('loadConfig parses tokens, defaults, and per-task models', () => {
  const c = loadConfig({ ...base, DEFAULT_MODEL: 'd/model', MODEL_VERDICT: 'v/model' } as any);
  assert.deepEqual(c.tokens, ['tok1', 'tok2']);
  assert.equal(c.defaultModel, 'd/model');
  assert.equal(c.taskModels.verdict, 'v/model');
  assert.equal(c.port, 8787);
  assert.equal(c.openRouterUrl, 'https://openrouter.ai/api/v1');
});
```

`test/gateway/auth.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearer, isAuthorized } from '../../gateway/src/auth';

test('extractBearer pulls the token or returns null', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc');
  assert.equal(extractBearer('bearer  xyz '), 'xyz');
  assert.equal(extractBearer('Token abc'), null);
  assert.equal(extractBearer(undefined), null);
});

test('isAuthorized accepts a listed token and rejects others', () => {
  const tokens = ['good-token'];
  assert.equal(isAuthorized('Bearer good-token', tokens), true);
  assert.equal(isAuthorized('Bearer bad', tokens), false);
  assert.equal(isAuthorized(undefined, tokens), false);
});
```

`test/gateway/model-map.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../../gateway/src/model-map';
import { loadConfig } from '../../gateway/src/config';

const config = loadConfig({
  OPENROUTER_API_KEY: 'sk', PROXY_TOKENS: 't',
  DEFAULT_MODEL: 'default/model', MODEL_VERDICT: 'verdict/model'
} as any);

test('resolveModel uses the per-task model when configured', () => {
  assert.equal(resolveModel('verdict', config), 'verdict/model');
});

test('resolveModel falls back to default for unmapped/unknown/missing task', () => {
  assert.equal(resolveModel('triage', config), 'default/model');
  assert.equal(resolveModel('bogus', config), 'default/model');
  assert.equal(resolveModel(undefined, config), 'default/model');
});
```

`test/gateway/rate-limit.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../gateway/src/rate-limit';

test('limiter allows up to N per window then blocks, and resets', () => {
  let now = 1000;
  const limiter = createRateLimiter(2, () => now);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  now += 60_000;
  assert.equal(limiter.allow('k'), true);
});

test('perMin<=0 disables limiting', () => {
  const limiter = createRateLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(limiter.allow('k'), true);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `tsc` errors that `gateway/src/config` (etc.) cannot be found / modules do not exist.

- [ ] **Step 6: Implement the four pure modules**

`gateway/src/config.ts`:

```ts
/* Gateway configuration loaded from environment. The real OpenRouter key and
   the accepted proxy tokens live only here (droplet env file), never in git.
   GatewayTaskType mirrors the model-facing subset of LLMTaskType in src/llm.ts. */
export type GatewayTaskType = 'verdict' | 'triage' | 'review' | 'digest' | 'scout' | 'query';

export interface GatewayConfig {
  port: number;
  openRouterKey: string;
  openRouterUrl: string;
  tokens: string[];
  defaultModel: string;
  taskModels: Partial<Record<GatewayTaskType, string>>;
  rateLimitPerMin: number;
  maxBodyBytes: number;
  upstreamTimeoutMs: number;
}

const TASK_MODEL_ENV: Record<GatewayTaskType, string> = {
  verdict: 'MODEL_VERDICT',
  triage: 'MODEL_TRIAGE',
  review: 'MODEL_REVIEW',
  digest: 'MODEL_DIGEST',
  scout: 'MODEL_SCOUT',
  query: 'MODEL_QUERY'
};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== '' ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const openRouterKey = env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    throw new Error('OPENROUTER_API_KEY is required');
  }
  const tokens = (env.PROXY_TOKENS || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new Error('PROXY_TOKENS is required (comma-separated list of accepted tokens)');
  }

  const taskModels: Partial<Record<GatewayTaskType, string>> = {};
  for (const task of Object.keys(TASK_MODEL_ENV) as GatewayTaskType[]) {
    const value = env[TASK_MODEL_ENV[task]];
    if (value) {
      taskModels[task] = value;
    }
  }

  return {
    port: num(env.PORT, 8787),
    openRouterKey,
    openRouterUrl: (env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    tokens,
    defaultModel: env.DEFAULT_MODEL || 'openai/gpt-4o-mini',
    taskModels,
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 60),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 256 * 1024),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, 60_000)
  };
}
```

`gateway/src/auth.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';

export function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* Accept the request only if its bearer token matches one of the configured
   tokens. Length-guarded timingSafeEqual avoids leaking token length/content
   through comparison timing. */
export function isAuthorized(header: string | undefined, tokens: string[]): boolean {
  const token = extractBearer(header);
  if (!token) {
    return false;
  }
  return tokens.some((t) => safeEqual(t, token));
}
```

`gateway/src/model-map.ts`:

```ts
import { GatewayConfig, GatewayTaskType } from './config';

const VALID_TASKS: GatewayTaskType[] = ['verdict', 'triage', 'review', 'digest', 'scout', 'query'];

/* Central model control: the X-Task-Type header selects a pinned model; anything
   unmapped, unknown, or absent falls back to the configured default. The client's
   requested model is always ignored. */
export function resolveModel(taskTypeHeader: string | undefined, config: GatewayConfig): string {
  const task = taskTypeHeader as GatewayTaskType;
  if (task && VALID_TASKS.includes(task) && config.taskModels[task]) {
    return config.taskModels[task] as string;
  }
  return config.defaultModel;
}
```

`gateway/src/rate-limit.ts`:

```ts
export interface RateLimiter {
  allow(key: string): boolean;
}

/* Fixed-window per-key limiter. Cheap insurance if a shared token leaks. The
   clock is injectable so tests are deterministic. perMin<=0 disables limiting. */
export function createRateLimiter(perMin: number, now: () => number = () => Date.now()): RateLimiter {
  if (perMin <= 0) {
    return { allow: () => true };
  }
  const windowMs = 60_000;
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const t = now();
      const bucket = buckets.get(key);
      if (!bucket || t >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      if (bucket.count >= perMin) {
        return false;
      }
      bucket.count++;
      return true;
    }
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all config/auth/model-map/rate-limit tests green.

- [ ] **Step 8: Commit**

```bash
git add .gitignore package.json tsconfig.test.json tsconfig.gateway.json gateway/src test/gateway
git commit -m "feat(gateway): pure core (config, auth, model-map, rate-limit) + test harness"
```

---

## Task 2: Gateway HTTP server

Wire the pure modules into an HTTP server that authenticates, rate-limits, pins the model, and forwards to OpenRouter.

**Files:**
- Create: `gateway/src/server.ts`
- Create: `test/gateway/server.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig`, `isAuthorized`, `extractBearer`, `resolveModel`, `createRateLimiter`, `RateLimiter` (Task 1).
- Produces:
  - `interface ServerDeps { fetchImpl?: typeof fetch; rateLimiter?: RateLimiter }`
  - `function createGatewayServer(config: GatewayConfig, deps?: ServerDeps): import('node:http').Server`

- [ ] **Step 1: Write failing server tests**

`test/gateway/server.test.ts`:

```ts
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
    assert.equal((await res.json()).model, 'verdict/model'); // response passed through verbatim
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createGatewayServer` not found.

- [ ] **Step 3: Implement the server**

`gateway/src/server.ts`:

```ts
import { createServer as httpCreateServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { GatewayConfig } from './config';
import { isAuthorized, extractBearer } from './auth';
import { resolveModel } from './model-map';
import { createRateLimiter, RateLimiter } from './rate-limit';

export interface ServerDeps {
  fetchImpl?: typeof fetch;
  rateLimiter?: RateLimiter;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

/* Read the request body up to a byte cap. Returns null if the cap is exceeded
   so the caller can respond 413 instead of buffering unbounded input. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  doFetch: typeof fetch,
  limiter: RateLimiter
): Promise<void> {
  const auth = req.headers['authorization'] as string | undefined;
  if (!isAuthorized(auth, config.tokens)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  const token = extractBearer(auth) as string;
  if (!limiter.allow(token)) {
    return sendJson(res, 429, { error: 'rate limited' });
  }

  const raw = await readBody(req, config.maxBodyBytes);
  if (raw === null) {
    return sendJson(res, 413, { error: 'payload too large' });
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'invalid json' });
  }

  /* Central model control: ignore whatever model the client sent. */
  body.model = resolveModel(req.headers['x-task-type'] as string | undefined, config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const upstream = await doFetch(`${config.openRouterUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openRouterKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json'
    });
    res.end(text);
  } finally {
    clearTimeout(timer);
  }
}

/* HTTP gateway: /health for liveness, /v1/chat/completions for the OpenAI-compatible
   proxy path. Request bodies are never logged (they carry user code and log snippets). */
export function createGatewayServer(config: GatewayConfig, deps: ServerDeps = {}): Server {
  const doFetch = deps.fetchImpl || fetch;
  const limiter = deps.rateLimiter || createRateLimiter(config.rateLimitPerMin);

  return httpCreateServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        return await handleChat(req, res, config, doFetch, limiter);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'gateway error',
        detail: err instanceof Error ? err.message : String(err)
      });
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all server tests green (health, 401, model pinning + key injection, error passthrough).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/server.ts test/gateway/server.test.ts
git commit -m "feat(gateway): HTTP server with auth, model pinning, and upstream forwarding"
```

---

## Task 3: Gateway entry point + deployment assets

Add the runnable entry point, the gateway build, and the droplet deployment files, then verify a local run end-to-end against a stub upstream.

**Files:**
- Create: `gateway/src/index.ts`
- Create: `gateway/deploy/Caddyfile.example`, `gateway/deploy/local-tester-gateway.service`, `gateway/deploy/gateway.env.example`
- Create: `gateway/README.md`

**Interfaces:**
- Consumes: `loadConfig` (Task 1), `createGatewayServer` (Task 2).

- [ ] **Step 1: Implement the entry point**

`gateway/src/index.ts`:

```ts
import { loadConfig } from './config';
import { createGatewayServer } from './server';

/* Loopback-bound: only Caddy (on the same host) reaches the gateway; TLS and the
   public interface are Caddy's job. */
const config = loadConfig();
const server = createGatewayServer(config);
server.listen(config.port, '127.0.0.1', () => {
  console.log(`local-tester gateway listening on 127.0.0.1:${config.port}`);
});
```

- [ ] **Step 2: Build the gateway**

Run: `npm run build:gateway`
Expected: no errors; `gateway/dist/index.js` and siblings exist.

- [ ] **Step 3: Verify a local run against a stub upstream**

Start the gateway pointed at a throwaway upstream URL (we only test auth + health here, not a real OpenRouter call):

```bash
OPENROUTER_API_KEY=sk-test PROXY_TOKENS=local-token DEFAULT_MODEL=test/model \
OPENROUTER_API_URL=http://127.0.0.1:9 PORT=8787 \
node gateway/dist/index.js &
GATEWAY_PID=$!
sleep 1
curl -s http://127.0.0.1:8787/health
echo
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer wrong' -H 'Content-Type: application/json' -d '{"messages":[]}'
kill $GATEWAY_PID
```

Expected output:
```
{"ok":true}
401
```

- [ ] **Step 4: Create the deployment assets**

`gateway/deploy/Caddyfile.example`:

```
# /etc/caddy/Caddyfile — automatic HTTPS via Let's Encrypt once the A record resolves.
llm-proxy.lnf.gr {
	reverse_proxy 127.0.0.1:8787
}
```

`gateway/deploy/local-tester-gateway.service`:

```ini
[Unit]
Description=local-tester LLM gateway
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/local-tester-gateway.env
ExecStart=/usr/bin/node /opt/local-tester-gateway/dist/index.js
Restart=always
RestartSec=2
User=gateway
Group=gateway
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`gateway/deploy/gateway.env.example`:

```
# Copy to /etc/local-tester-gateway.env, chmod 600, fill in real values. NEVER commit the real file.
PORT=8787
OPENROUTER_API_KEY=sk-or-REPLACE_ME
OPENROUTER_API_URL=https://openrouter.ai/api/v1
# Comma-separated list of accepted proxy tokens (generate with: openssl rand -hex 32)
PROXY_TOKENS=REPLACE_WITH_LONG_RANDOM_TOKEN
DEFAULT_MODEL=openai/gpt-4o-mini
# Optional per-task overrides; blank = use DEFAULT_MODEL
MODEL_VERDICT=
MODEL_TRIAGE=
MODEL_REVIEW=
MODEL_DIGEST=
MODEL_SCOUT=
MODEL_QUERY=
RATE_LIMIT_PER_MIN=60
MAX_BODY_BYTES=262144
UPSTREAM_TIMEOUT_MS=60000
```

- [ ] **Step 5: Write the deployment doc**

`gateway/README.md`:

````markdown
# local-tester LLM gateway

A tiny Node HTTP service that holds the shared OpenRouter API key, authenticates
clients with a shared bearer token, pins the model per task type, and forwards to
OpenRouter. Zero runtime dependencies (Node 18+ built-ins only). Fronted by Caddy
for automatic HTTPS.

## Request contract

- `GET /health` → `{"ok":true}` (no auth; used by the MCP client's health check).
- `POST /v1/chat/completions` → OpenAI-compatible. Requires `Authorization: Bearer <proxy-token>`.
  The `X-Task-Type` header (`verdict|triage|review|digest|scout|query`) selects the
  pinned model. The client's `model` field is always ignored.

## Deploy to the droplet

1. **DNS:** add an A record `llm-proxy.lnf.gr` → droplet IP. Wait for it to resolve.
2. **Install Node 18+ and Caddy** on the droplet.
3. **Build locally and copy the compiled service:**
   ```bash
   npm run build:gateway
   ssh droplet 'sudo mkdir -p /opt/local-tester-gateway'
   scp -r gateway/dist droplet:/tmp/gateway-dist
   ssh droplet 'sudo mv /tmp/gateway-dist /opt/local-tester-gateway/dist'
   ```
4. **Create a service user and the env file:**
   ```bash
   sudo useradd --system --no-create-home gateway
   sudo cp gateway/deploy/gateway.env.example /etc/local-tester-gateway.env
   sudo chmod 600 /etc/local-tester-gateway.env
   sudo nano /etc/local-tester-gateway.env   # fill in the real key + a random PROXY_TOKENS value
   ```
5. **Install and start the systemd unit:**
   ```bash
   sudo cp gateway/deploy/local-tester-gateway.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now local-tester-gateway
   sudo systemctl status local-tester-gateway
   ```
6. **Configure Caddy:**
   ```bash
   sudo cp gateway/deploy/Caddyfile.example /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```
7. **Firewall (ufw):** allow only 80/443; the gateway port stays loopback-bound.
   ```bash
   sudo ufw allow 80,443/tcp && sudo ufw enable
   ```
8. **Verify:**
   ```bash
   curl https://llm-proxy.lnf.gr/health   # → {"ok":true}
   ```

## Changing the model centrally

Edit `/etc/local-tester-gateway.env` (`DEFAULT_MODEL` or a `MODEL_<TASK>` line),
then `sudo systemctl restart local-tester-gateway`. Every client follows on its
next call; no client update needed.

## Rotating / revoking the shared token

`PROXY_TOKENS` accepts a comma-separated list, so you can add a new token, roll
clients over, then drop the old one — all via the env file + a restart.
````

- [ ] **Step 6: Commit**

```bash
git add gateway/src/index.ts gateway/deploy gateway/README.md
git commit -m "feat(gateway): entry point, deployment assets, and deploy doc"
```

---

## Task 4: Client — gateway provider, header, model-from-response, generalized fallback

Repoint `src/llm.ts` at the gateway when its env is present, send `X-Task-Type`, report the real model from the response, and generalize the remote→local fallback to cover the gateway.

**Files:**
- Modify: `src/llm.ts`
- Create: `test/client/provider.test.ts`

**Interfaces:**
- Produces (newly exported for tests):
  - `function resolveProvider(taskType: LLMTaskType): LLMProvider` (add `export`)
  - `const GATEWAY_PROVIDER_NAME = 'gateway'` (add `export`)
- Env consumed: `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN` (gateway takes precedence over `OPENROUTER_API_KEY`, which takes precedence over local).

- [ ] **Step 1: Write failing client provider tests**

`test/client/provider.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, GATEWAY_PROVIDER_NAME, queryLocalLLM } from '../../src/llm';

function clearEnv(): void {
  delete process.env.LLM_GATEWAY_URL;
  delete process.env.LLM_GATEWAY_TOKEN;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LOCAL_LLM_API_URL;
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

test('resolveProvider falls back to local when no gateway/openrouter env is set', () => {
  clearEnv();
  const p = resolveProvider('triage');
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `resolveProvider`/`GATEWAY_PROVIDER_NAME` not exported; model-from-response and gateway-fallback assertions fail.

- [ ] **Step 3: Add the gateway provider constant and resolver**

In `src/llm.ts`, near the other provider-name constants (around line 38-43), add:

```ts
const GATEWAY_PROVIDER_NAME = 'gateway';
```

Then export it by changing the declaration to:

```ts
export const GATEWAY_PROVIDER_NAME = 'gateway';
```

Add this resolver just above `resolveProvider` (after `resolveLocalProvider`):

```ts
/* Gateway is the centralized proxy: the client holds a revocable proxy token (not
   the real OpenRouter key) and sends X-Task-Type so the gateway can pin the model.
   The model here is nominal; the gateway overrides it and reports the real one. */
function resolveGatewayProvider(taskType: LLMTaskType): LLMProvider | null {
  const token = process.env.LLM_GATEWAY_TOKEN;
  const url = process.env.LLM_GATEWAY_URL;
  if (!token || !url) {
    return null;
  }
  return {
    taskType,
    providerName: GATEWAY_PROVIDER_NAME,
    apiUrl: url.replace(/\/+$/, ''),
    model: 'gateway-managed',
    authHeaders: {
      Authorization: `Bearer ${token}`,
      'X-Task-Type': taskType
    }
  };
}
```

- [ ] **Step 4: Make `resolveProvider` prefer the gateway and export it**

Replace the existing `resolveProvider` (lines ~139-152) with:

```ts
export function resolveProvider(taskType: LLMTaskType): LLMProvider {
  const gateway = resolveGatewayProvider(taskType);
  if (gateway) {
    return gateway;
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey) {
    const modelEnvName = TASK_OPENROUTER_MODEL_ENV[taskType];
    return {
      taskType,
      providerName: OPENROUTER_PROVIDER_NAME,
      apiUrl: OPENROUTER_API_URL,
      model: (modelEnvName && process.env[modelEnvName]) || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      authHeaders: { Authorization: `Bearer ${apiKey}` }
    };
  }
  return resolveLocalProvider(taskType);
}
```

- [ ] **Step 5: Report the real model from the response in `callChatCompletion`**

In `callChatCompletion` (around lines 246-255), after `const data = (await response.json()) as any;` and the `rawContent` guard, replace the `return { ... }` block with:

```ts
  /* The gateway (and OpenRouter) echo the model that actually ran; prefer it so
     analytics/metadata reflect central config without any client update. */
  const responseModel = typeof data.model === 'string' && data.model ? data.model : provider.model;
  const metadata = metadataFromProvider(provider, Date.now() - start);
  metadata.llmModel = responseModel;
  return {
    content: rawContent,
    usage: normalizeUsage(data, systemPrompt, userPrompt, rawContent),
    metadata
  };
```

- [ ] **Step 6: Generalize the remote→local fallback in `callWithFallback`**

In `callWithFallback` (around lines 259-275), replace the guard and fallback block with:

```ts
async function callWithFallback(taskType: LLMTaskType, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
  const provider = resolveProvider(taskType);
  const isRemote = provider.providerName === OPENROUTER_PROVIDER_NAME || provider.providerName === GATEWAY_PROVIDER_NAME;
  try {
    return await callChatCompletion(provider, systemPrompt, userPrompt);
  } catch (error) {
    if (!isRemote) {
      throw error;
    }
    const localProvider = resolveLocalProvider(taskType);
    const result = await callChatCompletion(localProvider, systemPrompt, userPrompt);
    result.metadata = {
      ...result.metadata,
      fallbackReason: `${provider.providerName} call failed: ${error instanceof Error ? error.message : String(error)}`
    };
    return result;
  }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — provider preference, local fallback, model-from-response, and gateway-failure-fallback tests green.

- [ ] **Step 8: Commit**

```bash
git add src/llm.ts test/client/provider.test.ts
git commit -m "feat(client): route LLM calls through the gateway with local fallback"
```

---

## Task 5: Client — gateway health check

When the gateway is configured, `check_local_llm_health` should ping the gateway's `/health` rather than blindly reporting available.

**Files:**
- Modify: `src/llm.ts` (`checkLocalLLMHealth`)
- Create: `test/client/health.test.ts`

**Interfaces:**
- Consumes: `LLMHealthResponse`, `GATEWAY_PROVIDER_NAME` (Task 4).

- [ ] **Step 1: Write failing health tests**

`test/client/health.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalLLMHealth, GATEWAY_PROVIDER_NAME } from '../../src/llm';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — current `checkLocalLLMHealth` has no gateway branch; it hits the local provider path and the URL/provider assertions fail.

- [ ] **Step 3: Add the gateway branch to `checkLocalLLMHealth`**

In `src/llm.ts`, at the very top of `checkLocalLLMHealth` (before the existing `if (process.env.OPENROUTER_API_KEY)` block around line 290), insert:

```ts
  /* Gateway is the configured primary: ping its /health (served at the root, not
     under /v1) to confirm reachability before real calls spend tokens. */
  if (process.env.LLM_GATEWAY_TOKEN && process.env.LLM_GATEWAY_URL) {
    const base = process.env.LLM_GATEWAY_URL.replace(/\/+$/, '');
    const healthUrl = `${base.replace(/\/v1$/, '')}/health`;
    const start = Date.now();
    try {
      const response = await fetch(healthUrl, { headers: { Authorization: `Bearer ${process.env.LLM_GATEWAY_TOKEN}` } });
      if (!response.ok) {
        throw new Error(`Gateway health ${response.status} ${response.statusText}`);
      }
      return {
        llmAvailable: true,
        llmProvider: GATEWAY_PROVIDER_NAME,
        llmModel: 'gateway-managed',
        llmLatencyMs: Date.now() - start,
        llmTaskType: 'health',
        apiBase: redactApiBase(base),
        available: true
      };
    } catch (error: any) {
      return {
        llmAvailable: false,
        llmProvider: GATEWAY_PROVIDER_NAME,
        llmModel: 'gateway-managed',
        llmLatencyMs: Date.now() - start,
        llmTaskType: 'health',
        apiBase: redactApiBase(base),
        available: false,
        error: error.message || String(error)
      };
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — both health tests green.

- [ ] **Step 5: Full build + all tests**

Run: `npm run build && npm run build:gateway && npm test`
Expected: all three succeed with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/llm.ts test/client/health.test.ts
git commit -m "feat(client): health check pings the gateway when configured"
```

---

## Task 6: Docs, config example, and plugin regeneration

Update user-facing docs and the `.mcp.json` example for the new env vars, bump plugin versions, and regenerate plugin assets.

**Files:**
- Modify: `.mcp.json`
- Modify: `README.md`
- Modify: `skill/skill-example.md`
- Modify: `scripts/generate-plugin-antigravity.js`, `scripts/generate-plugin-claude.js`, `scripts/generate-plugin-codex.js`

- [ ] **Step 1: Update the `.mcp.json` example env**

Replace the `env` block in `.mcp.json` with (keeps local as fallback, drops the real key):

```json
      "env": {
        "LLM_GATEWAY_URL": "https://llm-proxy.lnf.gr/v1",
        "LLM_GATEWAY_TOKEN": "your-shared-proxy-token",
        "LOCAL_LLM_API_URL": "http://127.0.0.1:8080/v1",
        "LOCAL_LLM_MODEL": "unsloth/GLM-4.7-Flash-REAP-23B-A3B-GGUF:Q4_K_XL"
      }
```

- [ ] **Step 2: Document the gateway in `README.md`**

Find the section documenting the OpenRouter / local LLM environment variables (search `README.md` for `OPENROUTER_API_KEY`). Add a subsection immediately before it titled `### Centralized gateway (recommended)` with this content, and add a one-line pointer to `gateway/README.md` for hosting:

````markdown
### Centralized gateway (recommended)

Point the server at a shared gateway so users never hold the real OpenRouter key
and the model is chosen centrally. Set two variables:

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_URL` | Gateway base URL, e.g. `https://llm-proxy.lnf.gr/v1`. |
| `LLM_GATEWAY_TOKEN` | Shared proxy token issued by the gateway operator (revocable; not your OpenRouter key). |

When both are set, the gateway is the primary LLM provider. Each call sends an
`X-Task-Type` header so the gateway pins the model; the client's model choice is
ignored and the actually-used model is reported back in analytics. If the gateway
is unreachable, the server falls back to a local model when `LOCAL_LLM_*` is
configured, otherwise it returns a conservative `uncertain` result.

Precedence: `LLM_GATEWAY_TOKEN` → `OPENROUTER_API_KEY` (direct, for local dev) →
local model. To host the gateway, see [`gateway/README.md`](gateway/README.md).
````

- [ ] **Step 3: Update `skill/skill-example.md`**

Search `skill/skill-example.md` for any mention of `OPENROUTER_API_KEY` or LLM configuration. Add a short note that, when a centralized gateway is configured (`LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN`), the skill behaves identically — the gateway just centralizes the key and model choice, and `check_local_llm_health` verifies gateway reachability. If the file has no LLM-config section, add a one-paragraph note near the setup/prerequisites section stating the same.

- [ ] **Step 4: Bump the plugin versions**

In each of `scripts/generate-plugin-antigravity.js`, `scripts/generate-plugin-claude.js`, `scripts/generate-plugin-codex.js`, change:

```js
  const VERSION = "1.2.6";
```
to:
```js
  const VERSION = "1.3.0";
```

- [ ] **Step 5: Regenerate plugin assets**

Run: `npm run build && npm run build:plugin`
Expected: succeeds; `plugin/claude/**` and `plugin/codex/**` and the two `marketplace.json` files reflect `1.3.0`.

- [ ] **Step 6: Verify docs/plugin consistency**

Run: `grep -rn "1.3.0" .claude-plugin/marketplace.json .agents/plugins/marketplace.json plugin/claude plugin/codex | head`
Expected: version strings show `1.3.0`. Confirm `LLM_GATEWAY_URL` appears in the regenerated skill docs if the skill docs reference env vars.

- [ ] **Step 7: Commit**

```bash
git add .mcp.json README.md skill/skill-example.md scripts/generate-plugin-*.js plugin .claude-plugin .agents
git commit -m "docs: document centralized gateway; bump plugins to 1.3.0"
```

---

## Task 7: End-to-end integration verification

Prove the client actually talks to the gateway and gets a verdict, using a local gateway with a stubbed upstream. No real OpenRouter spend.

**Files:**
- Create (temporary, scratchpad, not committed): a stub upstream + a driver script.

- [ ] **Step 1: Start a stub OpenRouter upstream and the gateway**

Create `/tmp/stub-upstream.mjs`:

```js
import { createServer } from 'node:http';
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const model = JSON.parse(body || '{}').model || 'unknown';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model,
      choices: [{ message: { content: '{"verdict":"pass","confidence":0.95,"summary":"stub ok","likelyRelevantToRecentChanges":false,"failures":[],"needsRawLogs":false}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }));
  });
}).listen(9099, '127.0.0.1', () => console.log('stub upstream on 9099'));
```

Run:

```bash
node /tmp/stub-upstream.mjs &
STUB_PID=$!
OPENROUTER_API_KEY=sk-stub PROXY_TOKENS=e2e-token DEFAULT_MODEL=stub/model \
OPENROUTER_API_URL=http://127.0.0.1:9099 PORT=8788 \
node gateway/dist/index.js &
GATEWAY_PID=$!
sleep 1
```

- [ ] **Step 2: Drive a real verdict call through the gateway from the built client**

Create `/tmp/drive.mjs`:

```js
process.env.LLM_GATEWAY_URL = 'http://127.0.0.1:8788/v1';
process.env.LLM_GATEWAY_TOKEN = 'e2e-token';
const { queryLocalLLM, checkLocalLLMHealth } = await import('./dist/llm.js');
console.log('health:', JSON.stringify(await checkLocalLLMHealth()));
const verdict = await queryLocalLLM('e2e', ['npm test'], { 'npm test': 0 }, [], 'all good', 'verdict');
console.log('verdict:', verdict.verdict, '| provider:', verdict.llmProvider, '| model:', verdict.llmModel);
```

Run (from the repo root, where `dist/` exists):

```bash
node /tmp/drive.mjs
```

Expected output (health `available:true` with provider `gateway`, verdict line):
```
health: {..."llmProvider":"gateway"..."available":true...}
verdict: pass | provider: gateway | model: stub/model
```

`model: stub/model` confirms the gateway pinned `DEFAULT_MODEL` (client's model ignored) and the client reported the response's model.

- [ ] **Step 3: Tear down**

```bash
kill $GATEWAY_PID $STUB_PID
rm -f /tmp/stub-upstream.mjs /tmp/drive.mjs
```

- [ ] **Step 4: Final full verification**

Run: `npm run build && npm run build:gateway && npm test`
Expected: all pass.

- [ ] **Step 5: Commit (if any incidental fixes were needed)**

```bash
git add -A
git commit -m "test: end-to-end gateway integration verification" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Thin proxy on droplet → Tasks 1-3. ✓
- Executor stays local (untouched) → only `src/llm.ts` transport changes (Tasks 4-5). ✓
- Keep local as fallback → Task 4 Step 6 (generalized remote→local). ✓
- Server pins model via `X-Task-Type` + default → Task 1 (`resolveModel`), Task 2 (server injects), Task 4 (client header). ✓
- Model reported from response → Task 4 Step 5. ✓
- Shared bearer token / 401 / security floor (rate limit, body cap, timeout, no body logging, loopback) → Tasks 1-3. ✓
- Caddy + systemd + env file + firewall at `llm-proxy.lnf.gr` → Task 3. ✓
- Health pings gateway → Task 5. ✓
- Analytics unchanged, per-workspace → no analytics files touched; provider label flows through metadata. ✓
- Docs + `.mcp.json` + VERSION bump `1.2.6`→`1.3.0` + `build:plugin` → Task 6. ✓
- Testing (unit + integration) → Tasks 1-5 unit, Task 7 integration. ✓
- Deferred per-user tokens → `PROXY_TOKENS` is already a list, so adding per-user lookup later is additive. ✓

**Placeholder scan:** No TBD/TODO. Example files use explicit `REPLACE_ME` placeholders by design (secrets must not be real). README doc-edit steps (Task 6 Steps 2-3) give exact insert content plus a search anchor because the full 31KB `README.md`/`skill-example.md` are not reproduced — the content to add is fully specified.

**Type consistency:** `GatewayConfig`, `GatewayTaskType`, `resolveModel`, `isAuthorized`, `extractBearer`, `createRateLimiter`/`RateLimiter`, `createGatewayServer`/`ServerDeps`, `resolveProvider`, `GATEWAY_PROVIDER_NAME` are used with identical signatures across tasks. Client env names (`LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`) and gateway env names (`OPENROUTER_API_KEY`, `PROXY_TOKENS`, `DEFAULT_MODEL`, `MODEL_<TASK>`, `PORT`, `RATE_LIMIT_PER_MIN`, `MAX_BODY_BYTES`, `UPSTREAM_TIMEOUT_MS`) are consistent across config loader, tests, deploy env example, and docs.
