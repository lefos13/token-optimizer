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
        const gatewayUrl = env.LLM_GATEWAY_URL;
        const token = env.LLM_GATEWAY_TOKEN;
        const byok = env.OPENROUTER_BYOK_KEY;
        if (gatewayUrl && (token || byok)) {
            return resolveProvider({ mode: token ? 'gateway-token' : 'gateway-byok', apiUrl: gatewayUrl, model: 'gateway-managed', credentialEnv: token ? 'LLM_GATEWAY_TOKEN' : 'OPENROUTER_BYOK_KEY', credential: token || byok, byokCredential: token ? byok : undefined, byokModel: byok ? env.OPENROUTER_BYOK_MODEL?.trim() || undefined : undefined }, taskType);
        }
        return resolveProvider({ mode: 'local', apiUrl: env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_URL, model: modelFor(taskType, DEFAULT_LOCAL_MODEL) }, taskType);
    }
    const config = configOrTask;
    const taskType = taskTypeArg;
    const warnings = [...(config.mode === 'gateway-byok' ? ['BYOK key is sent through the gateway; the gateway can observe and proxy the key.'] : [])];
    switch (config.mode) {
        case 'openrouter-direct':
            return { mode: config.mode, taskType, providerName: 'openrouter', apiUrl: normalizeUrl(config.apiUrl || DEFAULT_OPENROUTER_URL), model: config.model || DEFAULT_OPENROUTER_MODEL, authHeaders: { Authorization: `Bearer ${credential(config, 'OPENROUTER_API_KEY')}` }, warnings };
        case 'gateway-token':
            return { mode: config.mode, taskType, providerName: 'gateway', apiUrl: normalizeUrl(config.apiUrl), model: config.model || 'gateway-managed', authHeaders: {
                    Authorization: `Bearer ${credential(config, 'LLM_GATEWAY_TOKEN')}`, 'X-Task-Type': taskType,
                    ...(config.byokCredential ? { 'X-OpenRouter-Key': config.byokCredential } : {}),
                    ...(config.byokModel ? { 'X-OpenRouter-Model': config.byokModel } : {})
                }, warnings };
        case 'gateway-byok': {
            const headers = { 'X-Task-Type': taskType, 'X-OpenRouter-Key': credential(config, 'OPENROUTER_BYOK_KEY') };
            const byokModel = config.byokModel;
            if (byokModel)
                headers['X-OpenRouter-Model'] = byokModel;
            return { mode: config.mode, taskType, providerName: 'gateway', apiUrl: normalizeUrl(config.apiUrl), model: config.model || 'gateway-managed', authHeaders: headers, warnings };
        }
        case 'local':
            return { mode: config.mode, taskType, providerName: 'local-openai-compatible', apiUrl: normalizeUrl(config.apiUrl || DEFAULT_LOCAL_URL), model: config.model || modelFor(taskType, DEFAULT_LOCAL_MODEL), authHeaders: {}, warnings };
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
    const healthUrl = provider.mode === 'local' ? `${provider.apiUrl}/models` : `${provider.apiUrl.replace(/\/v1$/, '')}/health`;
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
