import { createServer as httpCreateServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { GatewayConfig } from './config';
import { isAuthorized, extractBearer } from './auth';
import { resolveModel } from './model-map';
import { parseByokModelHeader } from './byok-model';
import { createRateLimiter, RateLimiter } from './rate-limit';
import { TokenStore, createTokenStore, normalizeEmail } from './tokens';
import { StatsStore, createStatsStore } from './stats';
import { sendTokenEmail, sendTokenRequestNotification, EmailResult } from './email';
import { renderAccessRequestPage, renderStatsPage, renderAdminPage } from './pages';

export interface ServerDeps {
  fetchImpl?: typeof fetch;
  rateLimiter?: RateLimiter;
  tokenStore?: TokenStore;
  statsStore?: StatsStore;
  emailSender?: (config: GatewayConfig, to: string, token: string) => Promise<EmailResult>;
  tokenRequestNotificationSender?: (config: GatewayConfig, requesterEmail: string, requestedAt: Date) => Promise<EmailResult>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
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

async function readJsonBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<any | undefined> {
  const raw = await readBody(req, maxBytes);
  if (raw === null) {
    sendJson(res, 413, { error: 'payload too large' });
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'invalid json' });
    return undefined;
  }
}

/* Caddy fronts the gateway, so the first X-Forwarded-For entry is the real
   client; fall back to the socket address for direct/loopback access. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (first) {
    return first.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const BYOK_HEADER = 'x-openrouter-key';
const BYOK_KEY_RE = /^sk-or-[A-Za-z0-9_-]{10,200}$/;

/* Bring-your-own-key: a caller may supply their own OpenRouter key so their
   calls bill against their own account instead of the operator's, in exchange
   for skipping the daily-limit consumption on an issued token. A malformed or
   disabled header is silently ignored (falls back to the operator key and
   normal limiting) rather than erroring, so a bad header never blocks a call. */
function extractByokKey(req: IncomingMessage, config: GatewayConfig): string | null {
  if (!config.allowByok) {
    return null;
  }
  const raw = req.headers[BYOK_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return BYOK_KEY_RE.test(trimmed) ? trimmed : null;
}

type CallerAuth =
  | { ok: true; kind: 'shared' | 'issued'; token: string }
  | { ok: false; status: number; body: unknown };

/* Two token classes are accepted: shared operator tokens from PROXY_TOKENS
   (unlimited) and issued per-email tokens from the registry (daily-limited).
   `consume` counts the call against an issued token's daily allowance; shared
   tokens are never consumed. */
function authenticateCaller(
  authHeader: string | undefined,
  config: GatewayConfig,
  tokenStore: TokenStore,
  consume: boolean
): CallerAuth {
  const token = extractBearer(authHeader);
  if (!token) {
    return { ok: false, status: 401, body: { error: 'unauthorized' } };
  }
  if (isAuthorized(authHeader, config.tokens)) {
    return { ok: true, kind: 'shared', token };
  }
  const issued = tokenStore.authorize(token, consume);
  if (issued.ok) {
    return { ok: true, kind: 'issued', token };
  }
  if (issued.reason === 'daily_limit') {
    return {
      ok: false,
      status: 429,
      body: { error: 'daily limit reached', dailyLimit: issued.dailyLimit, resetsAt: 'midnight UTC' }
    };
  }
  return { ok: false, status: 401, body: { error: 'unauthorized' } };
}

/* A valid BYOK key means the caller bills OpenRouter directly, so a
   proxy/issued token is not required at all — the gateway only pins the
   model and proxies the request, it never pays for it. Per-minute rate
   limiting still applies (never skipped) so a single key can't be hammered:
   bucketed by whatever bearer token was presented, or by a hash of the BYOK
   key itself when none was, so anonymous BYOK callers are still throttled. */
function byokRateLimitKey(byokKey: string): string {
  return `byok:${createHash('sha256').update(byokKey, 'utf8').digest('hex').slice(0, 16)}`;
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  doFetch: typeof fetch,
  limiter: RateLimiter,
  tokenStore: TokenStore
): Promise<void> {
  const byokKey = extractByokKey(req, config);
  const byokModel = byokKey
    ? parseByokModelHeader(req.headers['x-openrouter-model'])
    : { kind: 'absent' as const };

  /* A caller-selected model is valid only on the user-funded BYOK path. Invalid
     BYOK model input stops here so it can never fall through to operator-funded
     inference; model headers from non-BYOK callers remain inert. */
  if (byokKey && byokModel.kind === 'invalid') {
    return sendJson(res, 400, { error: 'invalid BYOK model' });
  }
  const authHeader = req.headers['authorization'] as string | undefined;
  const bearer = extractBearer(authHeader);

  if (byokKey) {
    if (!limiter.allow(bearer || byokRateLimitKey(byokKey))) {
      return sendJson(res, 429, { error: 'rate limited' });
    }
  } else {
    /* No BYOK key: fall back to the normal proxy/issued-token path. Per-minute
       limiter runs before token validation so a burst does not also burn
       daily uses. */
    if (!bearer) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (!limiter.allow(bearer)) {
      return sendJson(res, 429, { error: 'rate limited' });
    }
    const auth = authenticateCaller(authHeader, config, tokenStore, true);
    if (!auth.ok) {
      return sendJson(res, auth.status, auth.body);
    }
  }

  const body = await readJsonBody(req, res, config.maxBodyBytes);
  if (body === undefined) {
    return;
  }

  body.model = byokModel.kind === 'valid'
    ? byokModel.model
    : resolveModel(req.headers['x-task-type'] as string | undefined, config);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const upstream = await doFetch(`${config.openRouterUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${byokKey || config.openRouterKey}`
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

/* Liveness plus optional token verification. A bare /health (no Authorization
   header) is pure loopback/uptime liveness and always returns ok. When a bearer
   token IS presented — as the client's check_local_llm_health does — it is
   validated (shared or issued, without consuming a daily use) so a misconfigured
   token is caught at health-check time (401) rather than only surfacing later
   as a fallback on the first real call. */
function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  tokenStore: TokenStore
): void {
  const authHeader = req.headers['authorization'] as string | undefined;
  if (authHeader) {
    const auth = authenticateCaller(authHeader, config, tokenStore, false);
    if (!auth.ok) {
      return sendJson(res, auth.status, auth.body);
    }
  }
  return sendJson(res, 200, { ok: true });
}

/* BYOK diagnostics validate the supplied key against OpenRouter's metadata
   endpoint. This authenticates the real upstream credential without creating
   a completion, selecting a model, or consuming inference quota. */
async function handleProviderHealth(req: IncomingMessage, res: ServerResponse, config: GatewayConfig, doFetch: typeof fetch): Promise<void> {
  const key = extractByokKey(req, config);
  if (!key) return sendJson(res, 401, { error: 'invalid BYOK credential' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);
  try {
    const upstream = await doFetch(`${config.openRouterUrl.replace(/\/+$/, '')}/auth/key`, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    return sendJson(res, upstream.ok ? 200 : upstream.status, upstream.ok ? { ok: true } : { error: 'provider authentication failed' });
  } finally { clearTimeout(timer); }
}

/* Global analytics ingest: authenticated clients push a sanitized aggregate
   record after each local tool call. Ingest never consumes a daily use (it is
   telemetry, not an LLM call) and the stats store re-sanitizes everything. */
async function handleAnalyticsIngest(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  limiter: RateLimiter,
  tokenStore: TokenStore,
  statsStore: StatsStore
): Promise<void> {
  const auth = authenticateCaller(req.headers['authorization'] as string | undefined, config, tokenStore, false);
  if (!auth.ok) {
    return sendJson(res, auth.status, auth.body);
  }
  if (!limiter.allow(`analytics:${auth.token}`)) {
    return sendJson(res, 429, { error: 'rate limited' });
  }
  const body = await readJsonBody(req, res, 32 * 1024);
  if (body === undefined) {
    return;
  }
  const accepted = statsStore.ingest(body);
  return sendJson(res, accepted ? 202 : 400, accepted ? { ok: true } : { error: 'invalid record' });
}

/* Bot signals are checked before storage. The ordinary pending response avoids
   revealing which safeguard rejected an automated submission. */
const MIN_REQUEST_COMPLETION_MS = 1_500;
const MAX_REQUEST_COMPLETION_MS = 60 * 60 * 1_000;
const PENDING_TOKEN_REQUEST_RESPONSE = {
  status: 'pending',
  message: 'Request received. You will get your token by email once approved.'
};

async function handleTokenRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestLimiter: RateLimiter,
  tokenStore: TokenStore,
  config: GatewayConfig,
  notificationSender: NonNullable<ServerDeps['tokenRequestNotificationSender']>
): Promise<void> {
  if (!requestLimiter.allow(`ip:${clientIp(req)}`)) {
    return sendJson(res, 429, { error: 'rate limited' });
  }
  const body = await readJsonBody(req, res, 4 * 1024);
  if (body === undefined) {
    return;
  }
  const email = normalizeEmail(body?.email);
  if (!email) {
    return sendJson(res, 400, { error: 'a valid email is required' });
  }
  if (typeof body?.website === 'string' && body.website.trim()) {
    return sendJson(res, 202, PENDING_TOKEN_REQUEST_RESPONSE);
  }
  if (body?.startedAt !== undefined) {
    if (typeof body.startedAt !== 'number' || !Number.isFinite(body.startedAt)) {
      return sendJson(res, 400, { error: 'startedAt must be a valid timestamp' });
    }
    const elapsed = Date.now() - body.startedAt;
    if (elapsed < MIN_REQUEST_COMPLETION_MS || elapsed > MAX_REQUEST_COMPLETION_MS) {
      return sendJson(res, 202, PENDING_TOKEN_REQUEST_RESPONSE);
    }
  }
  const result = tokenStore.requestToken(email);
  if (!result.ok) {
    return sendJson(res, 409, { error: 'a token has already been requested for this email' });
  }
  void notificationSender(config, email, new Date());
  return sendJson(res, 202, PENDING_TOKEN_REQUEST_RESPONSE);
}

function isAdminAuthorized(req: IncomingMessage, config: GatewayConfig): boolean {
  if (!config.adminToken) {
    return false;
  }
  const token = extractBearer(req.headers['authorization'] as string | undefined);
  return !!token && safeEqual(token, config.adminToken);
}

/* Admin surface: a static dashboard page plus a small JSON API. Everything is
   disabled (404) unless ADMIN_TOKEN is configured. The page itself carries no
   data; every data-bearing /admin/api/* call requires the admin bearer token.
   Approving generates the token, emails it, and only when email delivery is
   unavailable returns the plaintext once for manual hand-off. */
async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  config: GatewayConfig,
  tokenStore: TokenStore,
  emailSender: NonNullable<ServerDeps['emailSender']>
): Promise<void> {
  if (!config.adminToken) {
    return sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && req.url === '/admin') {
    return sendHtml(res, 200, renderAdminPage());
  }
  if (!isAdminAuthorized(req, config)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  if (req.method === 'GET' && req.url === '/admin/api/requests') {
    /* tokenHash never leaves the server, even to the admin. */
    const requests = tokenStore.listRequests().map(({ tokenHash: _hash, ...rest }) => rest);
    return sendJson(res, 200, { requests });
  }
  if (req.method === 'POST' && (req.url || '').startsWith('/admin/api/')) {
    const action = (req.url || '').slice('/admin/api/'.length);
    const body = await readJsonBody(req, res, 4 * 1024);
    if (body === undefined) {
      return;
    }
    const email = normalizeEmail(body?.email);
    if (!email) {
      return sendJson(res, 400, { error: 'a valid email is required' });
    }
    if (action === 'approve') {
      const approved = tokenStore.approve(email);
      if (!approved.ok) {
        return sendJson(res, 404, { error: 'request not found' });
      }
      const delivery = await emailSender(config, email, approved.token);
      return sendJson(res, 200, {
        email,
        status: 'approved',
        dailyLimit: approved.record.dailyLimit,
        emailSent: delivery.sent,
        ...(delivery.sent ? {} : { emailError: delivery.error, token: approved.token })
      });
    }
    if (action === 'deny' || action === 'revoke') {
      const result = action === 'deny' ? tokenStore.deny(email) : tokenStore.revoke(email);
      if (!result.ok) {
        return sendJson(res, 404, { error: 'request not found' });
      }
      return sendJson(res, 200, { email, status: result.record.status });
    }
    if (action === 'limit') {
      const result = tokenStore.setDailyLimit(email, Number(body?.dailyLimit));
      if (!result.ok) {
        return sendJson(res, result.error === 'not_found' ? 404 : 400, { error: result.error });
      }
      return sendJson(res, 200, { email, dailyLimit: result.record.dailyLimit });
    }
  }
  return sendJson(res, 404, { error: 'not found' });
}

/* HTTP gateway routes:
   - GET  /health              liveness (+ optional token verification)
   - POST /v1/chat/completions OpenAI-compatible proxy. Requires a proxy/issued
     token UNLESS a valid X-OpenRouter-Key (BYOK) is presented, in which case no
     token is needed at all — the caller bills OpenRouter directly and is only
     rate-limited, never daily-limited.
   - POST /v1/analytics        aggregate analytics ingest (auth, never daily-limited)
   - GET  /v1/stats            public aggregate stats JSON
   - GET  /stats               public showcase page
   - POST /v1/token-requests   public token request (per-IP limited, one per email ever)
   - /admin, /admin/api/*      operator dashboard (requires ADMIN_TOKEN)
   Request bodies are never logged (they carry user code and log snippets). */
export function createGatewayServer(config: GatewayConfig, deps: ServerDeps = {}): Server {
  const doFetch = deps.fetchImpl || fetch;
  const limiter = deps.rateLimiter || createRateLimiter(config.rateLimitPerMin);
  const requestLimiter = createRateLimiter(config.tokenRequestsPerMin);
  const tokenStore = deps.tokenStore || createTokenStore(config.stateDir, config.defaultDailyLimit);
  const statsStore = deps.statsStore || createStatsStore(config.stateDir);
  const emailSender = deps.emailSender || ((cfg, to, token) => sendTokenEmail(cfg, to, token));
  const tokenRequestNotificationSender = deps.tokenRequestNotificationSender
    || ((cfg, email, requestedAt) => sendTokenRequestNotification(cfg, email, requestedAt));

  return httpCreateServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/') {
        return sendHtml(res, 200, renderAccessRequestPage());
      }
      if (req.method === 'GET' && req.url === '/health') {
        return handleHealth(req, res, config, tokenStore);
      }
      if (req.method === 'GET' && req.url === '/v1/provider-health') {
        return await handleProviderHealth(req, res, config, doFetch);
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        return await handleChat(req, res, config, doFetch, limiter, tokenStore);
      }
      if (req.method === 'POST' && req.url === '/v1/analytics') {
        return await handleAnalyticsIngest(req, res, config, limiter, tokenStore, statsStore);
      }
      if (req.method === 'GET' && (req.url === '/v1/stats' || req.url === '/stats.json')) {
        return sendJson(res, 200, statsStore.publicStats());
      }
      if (req.method === 'GET' && req.url === '/stats') {
        return sendHtml(res, 200, renderStatsPage(statsStore.publicStats()));
      }
      if (req.method === 'POST' && req.url === '/v1/token-requests') {
        return await handleTokenRequest(req, res, requestLimiter, tokenStore, config, tokenRequestNotificationSender);
      }
      if ((req.url || '').startsWith('/admin')) {
        return await handleAdmin(req, res, config, tokenStore, emailSender);
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
