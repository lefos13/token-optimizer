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
