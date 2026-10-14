import type { EffectiveConfig, ProviderMode } from './types';

export type LLMTaskType = 'verdict' | 'triage' | 'review' | 'digest' | 'scout' | 'query' | 'health';
export type ProviderConfig = EffectiveConfig['provider'];

export interface LLMProvider {
  mode: ProviderMode;
  taskType: LLMTaskType;
  providerName: string;
  apiUrl: string;
  model: string;
  authHeaders: Record<string, string>;
  warnings: string[];
}

export interface LLMHealthResponse {
  llmAvailable?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmLatencyMs?: number;
  llmTaskType?: string;
  fallbackReason?: string;
  apiBase: string;
  available: boolean;
  error?: string;
  skipped?: boolean;
}

const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';
const DEFAULT_LOCAL_MODEL = 'local-model';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

function modelFor(taskType: LLMTaskType, fallback: string): string {
  const envNames: Record<LLMTaskType, string | undefined> = {
    verdict: 'LOCAL_LLM_VERDICT_MODEL', triage: 'LOCAL_LLM_TRIAGE_MODEL', review: 'LOCAL_LLM_REVIEW_MODEL',
    digest: 'LOCAL_LLM_DIGEST_MODEL', scout: 'LOCAL_LLM_SCOUT_MODEL', query: 'LOCAL_LLM_QUERY_MODEL', health: undefined
  };
  const envName = envNames[taskType];
  return (envName && process.env[envName]) || process.env.LOCAL_LLM_MODEL || fallback;
}

function normalizeUrl(url: string): string { return url.replace(/\/+$/, ''); }

function credential(config: ProviderConfig, fallbackEnv: string): string {
  if (config.credential !== undefined) return config.credential;
  const envName = config.credentialEnv || fallbackEnv;
  return process.env[envName] || '';
}

/* Each mode owns its authentication semantics. Local endpoints require no credentials,
   while openrouter-direct sends the API key directly to OpenRouter. */
export function resolveProvider(config: ProviderConfig, taskType: LLMTaskType): LLMProvider;
export function resolveProvider(taskType: LLMTaskType): LLMProvider;
export function resolveProvider(configOrTask: ProviderConfig | LLMTaskType, taskTypeArg?: LLMTaskType): LLMProvider {
  if (typeof configOrTask === 'string') {
    const taskType = configOrTask;
    const env = process.env;
    if (env.OPENROUTER_API_KEY) {
      return resolveProvider({
        mode: 'openrouter-direct',
        apiUrl: env.OPENROUTER_API_URL || DEFAULT_OPENROUTER_URL,
        model: env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        credentialEnv: 'OPENROUTER_API_KEY',
        credential: env.OPENROUTER_API_KEY
      }, taskType);
    }
    return resolveProvider({
      mode: 'local',
      apiUrl: env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL,
      model: modelFor(taskType, DEFAULT_LOCAL_MODEL)
    }, taskType);
  }
  const config = configOrTask;
  const taskType = taskTypeArg!;
  const warnings: string[] = [];
  switch (config.mode) {
    case 'openrouter-direct':
      return {
        mode: config.mode,
        taskType,
        providerName: 'openrouter',
        apiUrl: normalizeUrl(config.apiUrl || DEFAULT_OPENROUTER_URL),
        model: config.model || DEFAULT_OPENROUTER_MODEL,
        authHeaders: { Authorization: `Bearer ${credential(config, 'OPENROUTER_API_KEY')}` },
        warnings
      };
    case 'local':
      return {
        mode: config.mode,
        taskType,
        providerName: 'local-openai-compatible',
        apiUrl: normalizeUrl(config.apiUrl || DEFAULT_LOCAL_URL),
        model: config.model || modelFor(taskType, DEFAULT_LOCAL_MODEL),
        authHeaders: {},
        warnings
      };
  }
}

function redactApiBase(apiUrl: string): string {
  try { const url = new URL(apiUrl); return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`; } catch { return apiUrl.replace(/[?#].*$/, ''); }
}

export async function providerHealth(provider: LLMProvider): Promise<LLMHealthResponse> {
  const start = Date.now();
  const base = redactApiBase(provider.apiUrl);
  const healthUrl = `${provider.apiUrl}/models`;
  try {
    const response = await fetch(healthUrl, { headers: provider.authHeaders });
    if (!response.ok) throw new Error(`Provider health ${response.status} ${response.statusText}`);
    return { llmAvailable: true, llmProvider: provider.providerName, llmModel: provider.model, llmLatencyMs: Date.now() - start, llmTaskType: 'health', apiBase: base, available: true };
  } catch (error) {
    return { llmAvailable: false, llmProvider: provider.providerName, llmModel: provider.model, llmLatencyMs: Date.now() - start, llmTaskType: 'health', apiBase: base, available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
