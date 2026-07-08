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
