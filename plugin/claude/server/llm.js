"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
const LLM_USAGE = Symbol('llmUsage');
const LLM_METADATA = Symbol('llmMetadata');
const PROVIDER_NAME = 'local-openai-compatible';
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
    Object.defineProperty(value, LLM_USAGE, {
        value: usage,
        enumerable: false,
        configurable: false
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
        llmProvider: provider.provider,
        llmModel: provider.model,
        llmLatencyMs: latencyMs,
        llmTaskType: provider.taskType,
        ...(fallbackReason ? { fallbackReason } : {})
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
function resolveProvider(taskType) {
    const modelEnvName = TASK_MODEL_ENV[taskType];
    return {
        taskType,
        provider: PROVIDER_NAME,
        apiUrl: process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL,
        model: (modelEnvName && process.env[modelEnvName]) || process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL
    };
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
/* Shared transport for every local-LLM call: resolves the task-specific local model, builds the OpenAI-compatible request, and returns raw message content plus token/provider accounting. */
async function callChatCompletion(taskType, systemPrompt, userPrompt) {
    const provider = resolveProvider(taskType);
    const start = Date.now();
    const response = await fetch(`${provider.apiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: provider.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.1,
            response_format: { type: 'json_object' }
        }),
    });
    if (!response.ok) {
        throw new Error(`Local LLM API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json());
    const rawContent = data.choices?.[0]?.message?.content || '';
    if (!rawContent) {
        throw new Error('Empty response from local LLM');
    }
    return {
        content: rawContent,
        usage: normalizeUsage(data, systemPrompt, userPrompt, rawContent),
        metadata: metadataFromProvider(provider, Date.now() - start)
    };
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
    const provider = resolveProvider('health');
    const systemPrompt = 'Return JSON only.';
    const userPrompt = 'Return {"ok":true}.';
    const start = Date.now();
    try {
        const completion = await callChatCompletion('health', systemPrompt, userPrompt);
        JSON.parse(extractJSON(completion.content));
        return {
            ...completion.metadata,
            apiBase: redactApiBase(provider.apiUrl),
            available: true
        };
    }
    catch (error) {
        const latencyMs = Date.now() - start;
        const metadata = fallbackMetadata(provider, error, latencyMs);
        return {
            ...metadata,
            apiBase: redactApiBase(provider.apiUrl),
            available: false,
            error: error.message || String(error)
        };
    }
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
    try {
        const completion = await callChatCompletion(taskType, systemPrompt, userPrompt);
        const jsonString = extractJSON(completion.content);
        const parsed = JSON.parse(jsonString);
        const result = {
            verdict: parsed.verdict || 'uncertain',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            likelyRelevantToRecentChanges: typeof parsed.likelyRelevantToRecentChanges === 'boolean' ? parsed.likelyRelevantToRecentChanges : false,
            failures: Array.isArray(parsed.failures) ? parsed.failures : [],
            needsRawLogs: typeof parsed.needsRawLogs === 'boolean' ? parsed.needsRawLogs : false
        };
        // Validate verdict values
        if (!['pass', 'fail', 'uncertain'].includes(result.verdict)) {
            result.verdict = 'uncertain';
        }
        if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence)) {
            result.confidence = 0;
        }
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
        const provider = resolveProvider(taskType);
        return attachLLMMetadata({
            verdict: 'uncertain',
            confidence: 0.0,
            summary: `Failed to triage using local LLM: ${error.message || error}`,
            likelyRelevantToRecentChanges: false,
            failures: [],
            needsRawLogs: true,
        }, fallbackMetadata(provider, error, Date.now() - start));
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
    try {
        const completion = await callChatCompletion('review', systemPrompt, userPrompt);
        const jsonString = extractJSON(completion.content);
        const parsed = JSON.parse(jsonString);
        const result = {
            hasIssues: typeof parsed.hasIssues === 'boolean' ? parsed.hasIssues : false,
            issues: Array.isArray(parsed.issues) ? parsed.issues : [],
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            reviewAvailable: true
        };
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* The local LLM is offline or returned unparseable output. Stay conservative: report no issues rather than a phantom warning, and flag that the review did not actually run. */
        const provider = resolveProvider('review');
        return attachLLMMetadata({
            hasIssues: false,
            issues: [],
            summary: 'Code review did not run.',
            reviewAvailable: false,
            note: `Failed to review code using local LLM: ${error.message || error}`
        }, fallbackMetadata(provider, error, Date.now() - start));
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
    try {
        const completion = await callChatCompletion('digest', systemPrompt, userPrompt);
        const parsed = JSON.parse(extractJSON(completion.content));
        const result = {
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
            digest: typeof parsed.digest === 'string' ? parsed.digest : '',
            needsRawLogs: typeof parsed.needsRawLogs === 'boolean' ? parsed.needsRawLogs : false
        };
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* Local model offline or unparseable output: stay conservative and tell the caller to fall back to the raw log rather than inventing a digest. */
        const provider = resolveProvider('digest');
        return attachLLMMetadata({
            summary: `Failed to digest command output using local LLM: ${error.message || error}`,
            keyFindings: [],
            digest: '',
            needsRawLogs: true,
        }, fallbackMetadata(provider, error, Date.now() - start));
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
    try {
        const completion = await callChatCompletion('scout', systemPrompt, userPrompt);
        const parsed = JSON.parse(extractJSON(completion.content));
        const result = {
            pointers: Array.isArray(parsed.pointers) ? parsed.pointers.filter(isValidPointer) : [],
            suggestedNextSearches: Array.isArray(parsed.suggestedNextSearches) ? parsed.suggestedNextSearches : [],
            summary: typeof parsed.summary === 'string' ? parsed.summary : '',
            needsDeeperLook: typeof parsed.needsDeeperLook === 'boolean' ? parsed.needsDeeperLook : false,
            scoutAvailable: true
        };
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
        const provider = resolveProvider('scout');
        return attachLLMMetadata({
            pointers: [],
            suggestedNextSearches: [],
            summary: 'Candidate ranking did not run.',
            needsDeeperLook: true,
            scoutAvailable: false,
            note: `Failed to rank candidates using local LLM: ${error.message || error}`
        }, fallbackMetadata(provider, error, Date.now() - start));
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
    try {
        const completion = await callChatCompletion('query', systemPrompt, userPrompt);
        const parsed = JSON.parse(extractJSON(completion.content));
        const result = {
            answer: typeof parsed.answer === 'string' ? parsed.answer : '',
            relevantExcerpt: typeof parsed.relevantExcerpt === 'string' ? parsed.relevantExcerpt : '',
            lineRange: typeof parsed.lineRange === 'string' ? parsed.lineRange : '',
            available: true
        };
        return attachLLMResultMetadata(result, completion);
    }
    catch (error) {
        /* Model offline or unparseable: signal unavailability so the caller can fall back to grep_log or a raw-log slice. */
        const provider = resolveProvider('query');
        return attachLLMMetadata({
            answer: `Failed to query log using local LLM: ${error.message || error}`,
            relevantExcerpt: '',
            lineRange: '',
            available: false,
        }, fallbackMetadata(provider, error, Date.now() - start));
    }
}
