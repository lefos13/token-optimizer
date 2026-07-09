import { FailureDetail, LogQueryResponse, ScoutResponse, ScoutPointer, LLMResponseMetadata } from './types';
import { FileCandidate } from './runner';

/* Token usage is attached as private metadata for analytics, while provider metadata is also copied onto MCP JSON responses so callers can tell which local model answered and whether a fallback path was used. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: 'api' | 'estimated';
}

interface ChatCompletionResult {
  content: string;
  usage?: LLMUsage;
  metadata: LLMResponseMetadata;
}

const LLM_USAGE = Symbol('llmUsage');
const LLM_METADATA = Symbol('llmMetadata');

export type LLMTaskType = 'verdict' | 'triage' | 'review' | 'digest' | 'scout' | 'query' | 'health';

interface LLMProvider {
  taskType: LLMTaskType;
  providerName: string;
  apiUrl: string;
  model: string;
  authHeaders: Record<string, string>;
}

export interface LLMHealthResponse extends LLMResponseMetadata {
  apiBase: string;
  available: boolean;
  error?: string;
  skipped?: boolean;
}

const LOCAL_PROVIDER_NAME = 'local-openai-compatible';
export const GATEWAY_PROVIDER_NAME = 'gateway';
const DEFAULT_API_URL = 'http://localhost:8080/v1';
const DEFAULT_MODEL = 'local-model';
const TASK_MODEL_ENV: Record<LLMTaskType, string | undefined> = {
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

export function getLLMUsage(value: unknown): LLMUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as any)[LLM_USAGE] as LLMUsage | undefined;
}

export function getLLMMetadata(value: unknown): LLMResponseMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as any)[LLM_METADATA] as LLMResponseMetadata | undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function attachLLMUsage<T extends object>(value: T, usage: LLMUsage | undefined): T {
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

function attachLLMMetadata<T extends object>(value: T, metadata: LLMResponseMetadata): T {
  Object.assign(value, metadata);
  Object.defineProperty(value, LLM_METADATA, {
    value: metadata,
    enumerable: false,
    configurable: true
  });
  return value;
}

function metadataFromProvider(provider: LLMProvider, latencyMs: number, fallbackReason?: string): LLMResponseMetadata {
  return {
    llmAvailable: !fallbackReason,
    llmProvider: provider.providerName,
    llmModel: provider.model,
    llmLatencyMs: latencyMs,
    llmTaskType: provider.taskType,
    ...(fallbackReason ? { fallbackReason } : {})
  };
}

function attachLLMResultMetadata<T extends object>(value: T, completion: ChatCompletionResult): T {
  attachLLMUsage(value, completion.usage);
  return attachLLMMetadata(value, completion.metadata);
}

function fallbackMetadata(provider: LLMProvider, error: unknown, latencyMs: number): LLMResponseMetadata {
  const message = error instanceof Error ? error.message : String(error);
  return metadataFromProvider(provider, latencyMs, message);
}

function resolveLocalProvider(taskType: LLMTaskType): LLMProvider {
  const modelEnvName = TASK_MODEL_ENV[taskType];
  return {
    taskType,
    providerName: LOCAL_PROVIDER_NAME,
    apiUrl: process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL,
    model: (modelEnvName && process.env[modelEnvName]) || process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL,
    authHeaders: {}
  };
}

/* Gateway is the centralized proxy: it pins the model per task type via
   X-Task-Type. Two ways to use it:
   - LLM_GATEWAY_TOKEN: a revocable proxy/issued token (not the real upstream
     key); the operator's OpenRouter account pays and daily limits apply.
   - OPENROUTER_BYOK_KEY: the caller's own OpenRouter key, sent as
     X-OpenRouter-Key; the caller's own account pays, usage is unlimited, and
     no proxy token is needed at all — the gateway only proxies and pins the
     model, it never authenticates a BYOK-only caller. Either value alone is
     enough to engage the gateway; both may be set together. */
function resolveGatewayProvider(taskType: LLMTaskType): LLMProvider | null {
  const token = process.env.LLM_GATEWAY_TOKEN;
  const url = process.env.LLM_GATEWAY_URL;
  const byokKey = process.env.OPENROUTER_BYOK_KEY;
  if (!url || (!token && !byokKey)) {
    return null;
  }
  return {
    taskType,
    providerName: GATEWAY_PROVIDER_NAME,
    apiUrl: url.replace(/\/+$/, ''),
    model: 'gateway-managed',
    authHeaders: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Task-Type': taskType,
      ...(byokKey ? { 'X-OpenRouter-Key': byokKey } : {})
    }
  };
}

export function resolveProvider(taskType: LLMTaskType): LLMProvider {
  const gateway = resolveGatewayProvider(taskType);
  if (gateway) {
    return gateway;
  }
  return resolveLocalProvider(taskType);
}

export function combineLLMUsage(usage1?: LLMUsage, usage2?: LLMUsage): LLMUsage | undefined {
  if (!usage1) return usage2;
  if (!usage2) return usage1;
  return {
    promptTokens: usage1.promptTokens + usage2.promptTokens,
    completionTokens: usage1.completionTokens + usage2.completionTokens,
    totalTokens: usage1.totalTokens + usage2.totalTokens,
    source: usage1.source === 'api' || usage2.source === 'api' ? 'api' : 'estimated'
  };
}

export interface LLMVerdictResponse extends LLMResponseMetadata {
  verdict: 'pass' | 'fail' | 'uncertain';
  confidence: number;
  summary: string;
  likelyRelevantToRecentChanges: boolean;
  failures: FailureDetail[];
  needsRawLogs: boolean;
}

/**
 * Extracts a JSON substring from a potentially conversational or markdown-wrapped model output.
 */
function extractJSON(text: string): string {
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

function normalizeUsage(data: any, systemPrompt: string, userPrompt: string, rawContent: string): LLMUsage {
  const usage = data?.usage;
  if (
    usage &&
    typeof usage.prompt_tokens === 'number' &&
    typeof usage.completion_tokens === 'number' &&
    typeof usage.total_tokens === 'number'
  ) {
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
async function callChatCompletion(provider: LLMProvider, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
  const start = Date.now();

  const response = await fetch(`${provider.apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...provider.authHeaders,
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
    throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  if (!rawContent) {
    throw new Error('Empty response from LLM');
  }
  /* The gateway (and upstream provider) echo the model that actually ran; prefer it so
     analytics/metadata reflect central config without any client update. */
  const responseModel = typeof data.model === 'string' && data.model ? data.model : provider.model;
  const metadata = metadataFromProvider(provider, Date.now() - start);
  metadata.llmModel = responseModel;
  return {
    content: rawContent,
    usage: normalizeUsage(data, systemPrompt, userPrompt, rawContent),
    metadata
  };
}

/* Resolve provider, attempt the call. If the primary provider is the gateway and the call
   fails, retry once with the local provider and surface the fallback reason in metadata. */
async function callWithFallback(taskType: LLMTaskType, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
  const provider = resolveProvider(taskType);
  const isRemote = provider.providerName === GATEWAY_PROVIDER_NAME;
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

function redactApiBase(apiUrl: string): string {
  const start = Date.now();
  try {
    const url = new URL(apiUrl);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return apiUrl.replace(/[?#].*$/, '');
  }
}

export async function checkLocalLLMHealth(): Promise<LLMHealthResponse> {
  /* Gateway is the configured primary whenever a token or a BYOK key is set
     (see resolveGatewayProvider): ping its /health (served at the root, not
     under /v1) to confirm reachability before real calls spend tokens. A
     BYOK-only setup has no token to validate, so the request omits auth
     entirely and this only proves the gateway itself is reachable. */
  const gatewayUrl = process.env.LLM_GATEWAY_URL;
  const gatewayToken = process.env.LLM_GATEWAY_TOKEN;
  if (gatewayUrl && (gatewayToken || process.env.OPENROUTER_BYOK_KEY)) {
    const base = gatewayUrl.replace(/\/+$/, '');
    const healthUrl = `${base.replace(/\/v1$/, '')}/health`;
    const start = Date.now();
    try {
      const response = await fetch(healthUrl, gatewayToken ? { headers: { Authorization: `Bearer ${gatewayToken}` } } : {});
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

  const provider = resolveLocalProvider('health');
  const systemPrompt = 'Return JSON only.';
  const userPrompt = 'Return {"ok":true}.';
  const start = Date.now();

  try {
    const completion = await callChatCompletion(provider, systemPrompt, userPrompt);
    JSON.parse(extractJSON(completion.content));
    return {
      ...completion.metadata,
      apiBase: redactApiBase(provider.apiUrl),
      available: true
    };
  } catch (error: any) {
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

export async function queryLocalLLM(
  taskSummary: string,
  commandsRun: string[],
  exitCodes: Record<string, number>,
  changedFiles: string[],
  trimmedLogs: string,
  taskType: Extract<LLMTaskType, 'verdict' | 'triage'> = 'verdict'
): Promise<LLMVerdictResponse> {
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
    const completion = await callWithFallback(taskType, systemPrompt, userPrompt);
    const jsonString = extractJSON(completion.content);
    const parsed = JSON.parse(jsonString) as Partial<LLMVerdictResponse>;
    const result: LLMVerdictResponse = {
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
  } catch (error: any) {
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

export interface CodeReviewIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning';
  description: string;
  suggestedFix: string | null;
}

export interface CodeReviewResponse extends LLMResponseMetadata {
  hasIssues: boolean;
  issues: CodeReviewIssue[];
  summary: string;
  /* False when the local LLM was unreachable or returned unparseable output, so callers can tell "no issues found" apart from "review did not run". */
  reviewAvailable?: boolean;
  note?: string;
}

export async function queryCodeReview(
  files: { filename: string; content: string }[]
): Promise<CodeReviewResponse> {
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
    const completion = await callWithFallback('review', systemPrompt, userPrompt);
    const jsonString = extractJSON(completion.content);
    const parsed = JSON.parse(jsonString) as Partial<CodeReviewResponse>;
    const result: CodeReviewResponse = {
      hasIssues: typeof parsed.hasIssues === 'boolean' ? parsed.hasIssues : false,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      reviewAvailable: true
    };
    return attachLLMResultMetadata(result, completion);
  } catch (error: any) {
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

export interface CommandDigestResponse extends LLMResponseMetadata {
  summary: string;
  keyFindings: string[];
  digest: string;
  needsRawLogs: boolean;
}

/* Generic, intent-steered digest of any command's output. Unlike queryLocalLLM it does NOT decide pass/fail; the caller keeps the exit code authoritative. The model only describes what the output means for the stated intent. */
export async function queryCommandDigest(
  intent: string,
  commands: string[],
  exitCodes: Record<string, number>,
  trimmedLogs: string
): Promise<CommandDigestResponse> {
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
    const completion = await callWithFallback('digest', systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as CommandDigestResponse;
    const result: CommandDigestResponse = {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
      digest: typeof parsed.digest === 'string' ? parsed.digest : '',
      needsRawLogs: typeof parsed.needsRawLogs === 'boolean' ? parsed.needsRawLogs : false
    };
    return attachLLMResultMetadata(result, completion);
  } catch (error: any) {
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
export async function queryScout(goal: string, candidates: FileCandidate[]): Promise<ScoutResponse> {
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
    const completion = await callWithFallback('scout', systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as ScoutResponse;
    const result: ScoutResponse = {
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
  } catch (error: any) {
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

function isValidPointer(p: any): p is ScoutPointer {
  return p && typeof p.file === 'string' && typeof p.lineRange === 'string' && typeof p.why === 'string';
}

/* Answer a targeted question about a stored log so the caller never has to read the whole file. The log is supplied with 1-based line-number prefixes so the model can cite an exact lineRange. */
export async function queryLogQuestion(question: string, numberedLog: string): Promise<LogQueryResponse> {
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
    const completion = await callWithFallback('query', systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as LogQueryResponse;
    const result: LogQueryResponse = {
      answer: typeof parsed.answer === 'string' ? parsed.answer : '',
      relevantExcerpt: typeof parsed.relevantExcerpt === 'string' ? parsed.relevantExcerpt : '',
      lineRange: typeof parsed.lineRange === 'string' ? parsed.lineRange : '',
      available: true
    };
    return attachLLMResultMetadata(result, completion);
  } catch (error: any) {
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
