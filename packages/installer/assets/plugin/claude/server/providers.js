"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveProvider = resolveProvider;
exports.providerHealth = providerHealth;
const DEFAULT_LOCAL_URL = 'http://localhost:8080/v1';
const DEFAULT_LOCAL_MODEL = 'local-model';
const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
function modelFor(taskType, fallback) {
    const envNames = {
        verdict: 'LOCAL_LLM_VERDICT_MODEL', triage: 'LOCAL_LLM_TRIAGE_MODEL', review: 'LOCAL_LLM_REVIEW_MODEL',
        digest: 'LOCAL_LLM_DIGEST_MODEL', scout: 'LOCAL_LLM_SCOUT_MODEL', query: 'LOCAL_LLM_QUERY_MODEL', health: undefined
    };
    const envName = envNames[taskType];
    return (envName && process.env[envName]) || process.env.LOCAL_LLM_MODEL || fallback;
}
function normalizeUrl(url) { return url.replace(/\/+$/, ''); }
function credential(config, fallbackEnv) {
    if (config.credential !== undefined)
        return config.credential;
    const envName = config.credentialEnv || fallbackEnv;
    return process.env[envName] || '';
}
function resolveProvider(configOrTask, taskTypeArg) {
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
    const taskType = taskTypeArg;
    const warnings = [];
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
function redactApiBase(apiUrl) {
    try {
        const url = new URL(apiUrl);
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    }
    catch {
        return apiUrl.replace(/[?#].*$/, '');
    }
}
async function providerHealth(provider) {
    const start = Date.now();
    const base = redactApiBase(provider.apiUrl);
    const healthUrl = `${provider.apiUrl}/models`;
    try {
        const response = await fetch(healthUrl, { headers: provider.authHeaders });
        if (!response.ok)
            throw new Error(`Provider health ${response.status} ${response.statusText}`);
        return { llmAvailable: true, llmProvider: provider.providerName, llmModel: provider.model, llmLatencyMs: Date.now() - start, llmTaskType: 'health', apiBase: base, available: true };
    }
    catch (error) {
        return { llmAvailable: false, llmProvider: provider.providerName, llmModel: provider.model, llmLatencyMs: Date.now() - start, llmTaskType: 'health', apiBase: base, available: false, error: error instanceof Error ? error.message : String(error) };
    }
}
