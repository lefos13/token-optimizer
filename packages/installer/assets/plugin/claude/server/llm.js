"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GATEWAY_PROVIDER_NAME = exports.providerHealth = exports.resolveProvider = void 0;
exports.getLLMUsage = getLLMUsage;
exports.getLLMMetadata = getLLMMetadata;
exports.attachLLMUsage = attachLLMUsage;
exports.combineLLMUsage = combineLLMUsage;
exports.checkLocalLLMHealth = checkLocalLLMHealth;
exports.queryLocalLLM = queryLocalLLM;
exports.queryCodeReview = queryCodeReview;
exports.queryCommandDigest = queryCommandDigest;
exports.queryScout = queryScout;
exports.queryLogQuestion = queryLogQuestion;
const providers_1 = require("./providers");
const llm_schemas_1 = require("./llm-schemas");
const redaction_1 = require("./redaction");
var providers_2 = require("./providers");
Object.defineProperty(exports, "resolveProvider", { enumerable: true, get: function () { return providers_2.resolveProvider; } });
Object.defineProperty(exports, "providerHealth", { enumerable: true, get: function () { return providers_2.providerHealth; } });
const LLM_USAGE = Symbol('llmUsage');
const LLM_METADATA = Symbol('llmMetadata');
const LOCAL_PROVIDER_NAME = 'local-openai-compatible';
exports.GATEWAY_PROVIDER_NAME = 'gateway';
const DEFAULT_API_URL = 'http://localhost:8080/v1';
const DEFAULT_MODEL = 'local-model';
const TASK_MODEL_ENV = {
    verdict: 'LOCAL_LLM_VERDICT_MODEL',
    triage: 'LOCAL_LLM_TRIAGE_MODEL',
    review: 'LOCAL_LLM_REVIEW_MODEL',
    digest: 'LOCAL_LLM_DIGEST_MODEL',
    scout: 'LOCAL_LLM_SCOUT_MODEL',
    query: 'LOCAL_LLM_QUERY_MODEL',
    health: undefined
};
const VERDICT_CONFIDENCE_FLOOR = 0.4;
const SCOUT_POINTER_CONFIDENCE_FLOOR = 0.5;
function getLLMUsage(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    return value[LLM_USAGE];
}
function getLLMMetadata(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    return value[LLM_METADATA];
}
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function attachLLMUsage(value, usage) {
    if (!usage) {
        return value;
    }
    /* Auto-triage replaces primary usage with the combined primary/follow-up
       total, so this private analytics property must permit replacement. */
    Object.defineProperty(value, LLM_USAGE, {
        value: usage,
        enumerable: false,
        configurable: true,
        writable: true
    });
    return value;
}
function attachLLMMetadata(value, metadata) {
    Object.assign(value, metadata);
    Object.defineProperty(value, LLM_METADATA, {
        value: metadata,
        enumerable: false,
        configurable: true
    });
    return value;
}
function metadataFromProvider(provider, latencyMs, fallbackReason) {
    return {
        llmAvailable: !fallbackReason,
        llmProvider: provider.providerName,
        llmModel: provider.model,
        llmLatencyMs: latencyMs,
        llmTaskType: provider.taskType,
        ...(provider.warnings.length ? { providerWarnings: provider.warnings } : {}),
        ...(fallbackReason ? { fallbackReason } : {})
    };
}
function summarizeRedaction(systemPrompt, userPrompt) {
    const system = (0, redaction_1.redactText)(systemPrompt);
    const user = (0, redaction_1.redactText)(userPrompt);
    return {
        systemPrompt: system.text,
        userPrompt: user.text,
        summary: {
            text: '',
            count: system.count + user.count,
            categories: [...new Set([...system.categories, ...user.categories])].sort()
        }
    };
}
function attachLLMResultMetadata(value, completion) {
    attachLLMUsage(value, completion.usage);
    return attachLLMMetadata(value, completion.metadata);
}
function fallbackMetadata(provider, error, latencyMs) {
    const message = error instanceof Error ? error.message : String(error);
    return metadataFromProvider(provider, latencyMs, message);
}
class LLMValidationFailure extends Error {
    validationErrors;
    constructor(validationErrors) {
        super('LLM response failed schema validation');
        this.validationErrors = validationErrors;
    }
}
function metadataForFailure(provider, error, latencyMs, completion) {
    const metadata = completion?.metadata || fallbackMetadata(provider, error, latencyMs);
    if (error instanceof LLMValidationFailure)
        metadata.validationErrors = error.validationErrors;
    metadata.llmAvailable = false;
    metadata.fallbackReason = error instanceof Error ? error.message : String(error);
    return metadata;
}
function resolveLocalProvider(taskType) {
    /* Leave model empty so the adapter applies task-specific LOCAL_LLM_<TASK>_MODEL
       before the shared LOCAL_LLM_MODEL fallback. */
    return (0, providers_1.resolveProvider)({ mode: 'local', apiUrl: process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL, model: '' }, taskType);
}
/* Gateway is the centralized proxy: it pins the model per task type via
   X-Task-Type. Two ways to use it:
   - LLM_GATEWAY_TOKEN: a revocable proxy/issued token (not the real upstream
     key); the operator's OpenRouter account pays and daily limits apply.
   - OPENROUTER_BYOK_KEY: the caller's own OpenRouter key, sent as
     X-OpenRouter-Key; the caller's own account pays, usage is unlimited, and
     no proxy token is needed at all — the gateway only proxies and pins the
     model, it never authenticates a BYOK-only caller. An optional model
     header is sent only on the user-funded BYOK path. Either value alone is
     enough to engage the gateway; both may be set together. */
/* Legacy environment resolution remains available through resolveProvider(taskType);
   callers using EffectiveConfig should pass the provider object explicitly. */
function resolveGatewayProvider(taskType) {
    const token = process.env.LLM_GATEWAY_TOKEN;
    const url = process.env.LLM_GATEWAY_URL;
    const byokKey = process.env.OPENROUTER_BYOK_KEY;
    const byokModel = process.env.OPENROUTER_BYOK_MODEL?.trim();
    if (!url || (!token && !byokKey)) {
        return null;
    }
    return (0, providers_1.resolveProvider)({ mode: token ? 'gateway-token' : 'gateway-byok', apiUrl: url, model: 'gateway-managed', credentialEnv: token ? 'LLM_GATEWAY_TOKEN' : 'OPENROUTER_BYOK_KEY' }, taskType);
}
function combineLLMUsage(usage1, usage2) {
    if (!usage1)
        return usage2;
    if (!usage2)
        return usage1;
    return {
        promptTokens: usage1.promptTokens + usage2.promptTokens,
        completionTokens: usage1.completionTokens + usage2.completionTokens,
        totalTokens: usage1.totalTokens + usage2.totalTokens,
        source: usage1.source === 'api' || usage2.source === 'api' ? 'api' : 'estimated'
    };
}
/**
 * Extracts a JSON substring from a potentially conversational or markdown-wrapped model output.
 */
function extractJSON(text) {
    // Try to find markdown block first
    const markdownRegex = /```json\s*([\s\S]*?)\s*```/;
    const match = text.match(markdownRegex);
    if (match && match[1]) {
        return match[1].trim();
    }
    // Fallback: search for first '{' and last '}'
    const startIdx = text.indexOf('{');
    const endIdx = text.lastIndexOf('}');
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        return text.substring(startIdx, endIdx + 1).trim();
    }
    return text;
}
function normalizeUsage(data, systemPrompt, userPrompt, rawContent) {
    const usage = data?.usage;
    if (usage &&
        typeof usage.prompt_tokens === 'number' &&
        typeof usage.completion_tokens === 'number' &&
        typeof usage.total_tokens === 'number') {
        return {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            source: 'api'
        };
    }
    const promptTokens = estimateTokens(`${systemPrompt}\n${userPrompt}`);
    const completionTokens = estimateTokens(rawContent);
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        source: 'estimated'
    };
}
/* Shared transport for every LLM call: accepts an already-resolved provider, builds the OpenAI-compatible request, and returns raw message content plus token/provider accounting. */
async function callChatCompletion(provider, systemPrompt, userPrompt, inheritedRedaction) {
    const start = Date.now();
    /* Redact only at the final remote boundary. Local providers retain the full
       diagnostic payload so offline development and local models are unchanged. */
    const outbound = provider.mode === 'local'
        ? { systemPrompt, userPrompt, redaction: inheritedRedaction }
        : (() => { const result = summarizeRedaction(systemPrompt, userPrompt); return { ...result, redaction: result.summary }; })();
    const response = await fetch(`${provider.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...provider.authHeaders,
        },
        body: JSON.stringify({
            model: provider.model,
            messages: [
                { role: 'system', content: outbound.systemPrompt },
                { role: 'user', content: outbound.userPrompt }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
        }),
    });
    if (!response.ok) {
        throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json());
    const rawContent = data.choices?.[0]?.message?.content || '';
    if (!rawContent) {
        throw new Error('Empty response from LLM');
    }
    /* The gateway (and upstream provider) echo the model that actually ran; prefer it so
       analytics/metadata reflect central config without any client update. */
    const responseModel = typeof data.model === 'string' && data.model ? data.model : provider.model;
    const metadata = metadataFromProvider(provider, Date.now() - start);
    if (provider.mode !== 'local' && outbound.redaction) {
        metadata.redactionSummary = { count: outbound.redaction.count, categories: outbound.redaction.categories };
    }
    metadata.llmModel = responseModel;
    return {
        content: rawContent,
        usage: normalizeUsage(data, outbound.systemPrompt, outbound.userPrompt, rawContent),
        metadata
    };
}
/* Resolve provider, attempt the call. If the primary provider is the gateway and the call
   fails, retry once with the local provider and surface the fallback reason in metadata. */
async function callWithFallback(taskType, systemPrompt, userPrompt) {
    const provider = (0, providers_1.resolveProvider)(taskType);
    const isRemote = provider.providerName === exports.GATEWAY_PROVIDER_NAME;
    try {
        return await callChatCompletion(provider, systemPrompt, userPrompt);
    }
    catch (error) {
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
function redactApiBase(apiUrl) {
    const start = Date.now();
    try {
        const url = new URL(apiUrl);
        return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
    }
    catch {
        return apiUrl.replace(/[?#].*$/, '');
    }
}
async function checkLocalLLMHealth() {
    return (0, providers_1.providerHealth)((0, providers_1.resolveProvider)('health'));
}
async function queryLocalLLM(taskSummary, commandsRun, exitCodes, changedFiles, trimmedLogs, taskType = 'verdict') {
    const systemPrompt = `You are a diagnostic and test-log triage assistant.
You analyze build logs, linter outputs, typechecker warnings/errors, and test execution results.
You do not decide pass/fail from intuition.
Use command exit codes as truth.

Analyze the output log, exit codes, recent changes, and task summary.
Identify any failures (such as compilation errors, type mismatches, linter infractions, or failing tests), explain why they occurred, and suggest a specific fix.

Return JSON ONLY matching the following schema. Do not write any conversational text or explanation outside the JSON block.

Schema:
{
  "verdict": "pass" | "fail" | "uncertain",
  "confidence": number (between 0.0 and 1.0),
  "summary": "String explaining what passed or failed",
  "likelyRelevantToRecentChanges": boolean,
  "failures": [
    {
      "file": "path/to/failed_file.ts" or null,
      "reason": "Clear explanation of the error/failure",
      "suggestedFix": "Code adjustment recommendation or null"
    }
  ],
  "needsRawLogs": boolean (true if log is too trimmed to understand error details)
}`;
    const userPrompt = `Task Summary: ${taskSummary}
Changed Files: ${JSON.stringify(changedFiles)}
Commands Run with Exit Codes: ${JSON.stringify(exitCodes)}

Logs:
${trimmedLogs}`;
    const start = Date.now();
    let completion;
    try {
        completion = await callWithFallback(taskType, systemPrompt, userPrompt);
        const jsonString = extractJSON(completion.content);
        const parsed = (0, llm_schemas_1.parseLLMResponse)(taskType, jsonString);
        if (!parsed.success)
            throw new LLMValidationFailure(parsed.validationErrors);
        const result = parsed.data;
        if (result.confidence < VERDICT_CONFIDENCE_FLOOR) {
            result.verdict = 'uncertain';
            result.needsRawLogs = true;
            return attachLLMResultMetadata(result, {
                ...completion,
                metadata: {
                    ...completion.metadata,
                    llmAvailable: true,
                    fallbackReason: `Local verdict confidence ${result.confidence} was below ${VERDICT_CONFIDENCE_FLOOR}.`
                }
            });
        }
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        // If the local model is offline, fails to respond, or output is unparseable
        const provider = (0, providers_1.resolveProvider)(taskType);
        return attachLLMMetadata({
            verdict: 'uncertain',
            confidence: 0.0,
            summary: `Failed to triage using local LLM: ${error.message || error}`,
            likelyRelevantToRecentChanges: false,
            failures: [],
            needsRawLogs: true,
        }, metadataForFailure(provider, error, Date.now() - start, completion));
    }
}
async function queryCodeReview(files) {
    const systemPrompt = `You are a code review assistant.
Analyze the provided code changes in the files.
Check for basic syntax errors, typical logical bugs, formatting issues, type errors, or potential regressions.

Return JSON ONLY matching the following schema. Do not write any conversational text or explanation outside the JSON block.

Schema:
{
  "hasIssues": boolean,
  "summary": "Short overall summary of the review (one or two sentences)",
  "issues": [
    {
      "file": "relative/path/to/file.ts",
      "line": number (optional, line number of the issue),
      "severity": "error" | "warning",
      "description": "Clear explanation of the issue/concern",
      "suggestedFix": "Code adjustment recommendation or null"
    }
  ]
}`;
    let userPrompt = "Files to review:\n";
    for (const f of files) {
        userPrompt += `\n--- File: ${f.filename} ---\n${f.content}\n`;
    }
    const start = Date.now();
    let completion;
    try {
        completion = await callWithFallback('review', systemPrompt, userPrompt);
        const jsonString = extractJSON(completion.content);
        const parsed = (0, llm_schemas_1.parseLLMResponse)('review', jsonString);
        if (!parsed.success)
            throw new LLMValidationFailure(parsed.validationErrors);
        const result = { ...parsed.data, reviewAvailable: true };
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* The local LLM is offline or returned unparseable output. Stay conservative: report no issues rather than a phantom warning, and flag that the review did not actually run. */
        const provider = (0, providers_1.resolveProvider)('review');
        return attachLLMMetadata({
            hasIssues: false,
            issues: [],
            summary: 'Code review did not run.',
            reviewAvailable: false,
            note: `Failed to review code using local LLM: ${error.message || error}`
        }, metadataForFailure(provider, error, Date.now() - start, completion));
    }
}
/* Generic, intent-steered digest of any command's output. Unlike queryLocalLLM it does NOT decide pass/fail; the caller keeps the exit code authoritative. The model only describes what the output means for the stated intent. */
async function queryCommandDigest(intent, commands, exitCodes, trimmedLogs) {
    const systemPrompt = `You are a command-output digest assistant.
You are given the output of one or more shell commands and the caller's intent for running them.
Summarize the output compactly so the caller does not need to read the raw log.
Do NOT decide success or failure; the caller already has the authoritative exit codes. Describe, do not adjudicate.
Focus only on what is relevant to the stated intent.

Return JSON ONLY matching the following schema. Do not write any conversational text or explanation outside the JSON block.

Schema:
{
  "summary": "One or two sentence plain-language summary of what the command output shows, relative to the intent",
  "keyFindings": ["Short bullet strings: the specific facts, names, counts, errors, or results the caller asked about"],
  "digest": "A compact distillation of the relevant output (a handful of lines), preserving exact identifiers/messages where they matter",
  "needsRawLogs": boolean (true if the trimmed log is missing detail needed to satisfy the intent)
}`;
    const userPrompt = `Intent: ${intent}
Command(s) with exit codes: ${JSON.stringify(exitCodes)}

Output:
${trimmedLogs}`;
    const start = Date.now();
    let completion;
    try {
        completion = await callWithFallback('digest', systemPrompt, userPrompt);
        const parsed = (0, llm_schemas_1.parseLLMResponse)('digest', extractJSON(completion.content));
        if (!parsed.success)
            throw new LLMValidationFailure(parsed.validationErrors);
        const result = parsed.data;
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* Local model offline or unparseable output: stay conservative and tell the caller to fall back to the raw log rather than inventing a digest. */
        const provider = (0, providers_1.resolveProvider)('digest');
        return attachLLMMetadata({
            summary: `Failed to digest command output using local LLM: ${error.message || error}`,
            keyFindings: [],
            digest: '',
            needsRawLogs: true,
        }, metadataForFailure(provider, error, Date.now() - start, completion));
    }
}
/* Rank server-gathered code candidates against a navigation goal so the main model reads only the few regions that matter. The candidates were found deterministically (grep); the model only orders/explains them and must not invent paths. This is a hint, not authority: the main model verifies every pointer. */
async function queryScout(goal, candidates) {
    const systemPrompt = `You are a codebase navigation assistant for a larger coding agent.
You are given a GOAL and a set of CANDIDATE code regions that were already found by a grep over the workspace. Each region is shown with its file path and line-numbered source.

Your job is to point the larger agent at the few regions most relevant to the goal, so it does not have to read everything.

Rules:
- Only cite files and line ranges that appear in the provided candidates. Never invent a path, symbol, or line number.
- Rank by how directly each region addresses the goal. Prefer a small number of strong pointers over many weak ones.
- If the candidates do not look sufficient to satisfy the goal, set needsDeeperLook to true and suggest more search terms.

Return JSON ONLY matching the following schema. Do not write any conversational text or explanation outside the JSON block.

Schema:
{
  "pointers": [
    {
      "file": "relative/path/from/candidates.ts",
      "lineRange": "40-72 (must be within a provided region)",
      "why": "One sentence: why this region is relevant to the goal",
      "confidence": number (between 0.0 and 1.0)
    }
  ],
  "suggestedNextSearches": ["additional grep terms the agent could try next"],
  "summary": "One or two sentences orienting the agent: where the relevant code lives",
  "needsDeeperLook": boolean (true if the candidates seem insufficient for the goal)
}`;
    let userPrompt = `Goal: ${goal}\n\nCandidates:\n`;
    for (const c of candidates) {
        userPrompt += `\n### ${c.file} (${c.hitCount} hits)\n`;
        for (const r of c.regions) {
            userPrompt += `[lines ${r.lineRange}]\n${r.snippet}\n`;
        }
    }
    const start = Date.now();
    let completion;
    try {
        completion = await callWithFallback('scout', systemPrompt, userPrompt);
        const parsed = (0, llm_schemas_1.parseLLMResponse)('scout', extractJSON(completion.content));
        if (!parsed.success)
            throw new LLMValidationFailure(parsed.validationErrors);
        const result = { ...parsed.data, scoutAvailable: true };
        if (result.pointers.length === 0 || result.pointers.every((p) => p.confidence < SCOUT_POINTER_CONFIDENCE_FLOOR)) {
            result.needsDeeperLook = true;
            completion.metadata = {
                ...completion.metadata,
                fallbackReason: `No scout pointer met confidence ${SCOUT_POINTER_CONFIDENCE_FLOOR}.`
            };
        }
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* Model offline or unparseable: stay conservative. Return no ranked pointers and flag that ranking did not run, so the caller falls back to the deterministic candidate list the server already gathered. */
        const provider = (0, providers_1.resolveProvider)('scout');
        return attachLLMMetadata({
            pointers: [],
            suggestedNextSearches: [],
            summary: 'Candidate ranking did not run.',
            needsDeeperLook: true,
            scoutAvailable: false,
            note: `Failed to rank candidates using local LLM: ${error.message || error}`
        }, metadataForFailure(provider, error, Date.now() - start, completion));
    }
}
function isValidPointer(p) {
    return p && typeof p.file === 'string' && typeof p.lineRange === 'string' && typeof p.why === 'string';
}
/* Answer a targeted question about a stored log so the caller never has to read the whole file. The log is supplied with 1-based line-number prefixes so the model can cite an exact lineRange. */
async function queryLogQuestion(question, numberedLog) {
    const systemPrompt = `You answer a specific question about a stored command/test log.
The log is provided with each line prefixed by its line number ("123: ...").
Answer ONLY from the log content. If the log does not contain the answer, say so plainly.
Quote as few lines as needed to support the answer; do not dump the whole log.

Return JSON ONLY matching the following schema. Do not write any conversational text or explanation outside the JSON block.

Schema:
{
  "answer": "Direct answer to the question, grounded in the log",
  "relevantExcerpt": "The few supporting log lines, keeping their line-number prefixes (empty string if none apply)",
  "lineRange": "Line range of the excerpt, e.g. \\"120-126\\", or empty string if not applicable"
}`;
    const userPrompt = `Question: ${question}

Log (line-numbered):
${numberedLog}`;
    const start = Date.now();
    let completion;
    try {
        completion = await callWithFallback('query', systemPrompt, userPrompt);
        const parsed = (0, llm_schemas_1.parseLLMResponse)('query', extractJSON(completion.content));
        if (!parsed.success)
            throw new LLMValidationFailure(parsed.validationErrors);
        const result = { ...parsed.data, available: true };
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* Model offline or unparseable: signal unavailability so the caller can fall back to grep_log or a raw-log slice. */
        const provider = (0, providers_1.resolveProvider)('query');
        return attachLLMMetadata({
            answer: `Failed to query log using local LLM: ${error.message || error}`,
            relevantExcerpt: '',
            lineRange: '',
            available: false,
        }, metadataForFailure(provider, error, Date.now() - start, completion));
    }
}
