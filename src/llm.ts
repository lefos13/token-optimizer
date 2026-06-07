import { FailureDetail, LogQueryResponse, ScoutResponse, ScoutPointer } from './types';
import { FileCandidate } from './runner';

/* Token usage is attached to parsed local-LLM results as non-enumerable metadata so handlers can persist analytics without leaking those fields into MCP JSON responses. */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: 'api' | 'estimated';
}

interface ChatCompletionResult {
  content: string;
  usage?: LLMUsage;
}

const LLM_USAGE = Symbol('llmUsage');

export function getLLMUsage(value: unknown): LLMUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return (value as any)[LLM_USAGE] as LLMUsage | undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function attachLLMUsage<T extends object>(value: T, usage: LLMUsage | undefined): T {
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

export interface LLMVerdictResponse {
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

/* Shared transport for every local-LLM call: builds the OpenAI-compatible request and returns raw message content plus private token accounting, or throws so each caller can apply its own conservative fallback. */
async function callChatCompletion(systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
  const apiUrl = process.env.LOCAL_LLM_API_URL || 'http://localhost:8080/v1';
  const modelName = process.env.LOCAL_LLM_MODEL || 'local-model';

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
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

  const data = (await response.json()) as any;
  const rawContent = data.choices?.[0]?.message?.content || '';
  if (!rawContent) {
    throw new Error('Empty response from local LLM');
  }
  return {
    content: rawContent,
    usage: normalizeUsage(data, systemPrompt, userPrompt, rawContent)
  };
}

export async function queryLocalLLM(
  taskSummary: string,
  commandsRun: string[],
  exitCodes: Record<string, number>,
  changedFiles: string[],
  trimmedLogs: string
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

  try {
    const completion = await callChatCompletion(systemPrompt, userPrompt);
    const jsonString = extractJSON(completion.content);
    const result = JSON.parse(jsonString) as LLMVerdictResponse;

    // Validate verdict values
    if (!['pass', 'fail', 'uncertain'].includes(result.verdict)) {
      result.verdict = 'uncertain';
    }

    return attachLLMUsage(result, completion.usage);
  } catch (error: any) {
    // If the local model is offline, fails to respond, or output is unparseable
    return {
      verdict: 'uncertain',
      confidence: 0.0,
      summary: `Failed to triage using local LLM: ${error.message || error}`,
      likelyRelevantToRecentChanges: false,
      failures: [],
      needsRawLogs: true,
    };
  }
}

export interface CodeReviewIssue {
  file: string;
  line?: number;
  severity: 'error' | 'warning';
  description: string;
  suggestedFix: string | null;
}

export interface CodeReviewResponse {
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

  try {
    const completion = await callChatCompletion(systemPrompt, userPrompt);
    const jsonString = extractJSON(completion.content);
    const parsed = JSON.parse(jsonString) as CodeReviewResponse;
    if (typeof parsed.summary !== 'string') {
      parsed.summary = '';
    }
    parsed.reviewAvailable = true;
    return attachLLMUsage(parsed, completion.usage);
  } catch (error: any) {
    /* The local LLM is offline or returned unparseable output. Stay conservative: report no issues rather than a phantom warning, and flag that the review did not actually run. */
    return {
      hasIssues: false,
      issues: [],
      summary: 'Code review did not run.',
      reviewAvailable: false,
      note: `Failed to review code using local LLM: ${error.message || error}`
    };
  }
}

export interface CommandDigestResponse {
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

  try {
    const completion = await callChatCompletion(systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as CommandDigestResponse;
    if (typeof parsed.summary !== 'string') {
      parsed.summary = '';
    }
    if (!Array.isArray(parsed.keyFindings)) {
      parsed.keyFindings = [];
    }
    if (typeof parsed.digest !== 'string') {
      parsed.digest = '';
    }
    if (typeof parsed.needsRawLogs !== 'boolean') {
      parsed.needsRawLogs = false;
    }
    return attachLLMUsage(parsed, completion.usage);
  } catch (error: any) {
    /* Local model offline or unparseable output: stay conservative and tell the caller to fall back to the raw log rather than inventing a digest. */
    return {
      summary: `Failed to digest command output using local LLM: ${error.message || error}`,
      keyFindings: [],
      digest: '',
      needsRawLogs: true,
    };
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

  try {
    const completion = await callChatCompletion(systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as ScoutResponse;
    parsed.pointers = Array.isArray(parsed.pointers) ? parsed.pointers.filter(isValidPointer) : [];
    if (!Array.isArray(parsed.suggestedNextSearches)) {
      parsed.suggestedNextSearches = [];
    }
    if (typeof parsed.summary !== 'string') {
      parsed.summary = '';
    }
    if (typeof parsed.needsDeeperLook !== 'boolean') {
      parsed.needsDeeperLook = parsed.pointers.length === 0;
    }
    parsed.scoutAvailable = true;
    return attachLLMUsage(parsed, completion.usage);
  } catch (error: any) {
    /* Model offline or unparseable: stay conservative. Return no ranked pointers and flag that ranking did not run, so the caller falls back to the deterministic candidate list the server already gathered. */
    return {
      pointers: [],
      suggestedNextSearches: [],
      summary: 'Candidate ranking did not run.',
      needsDeeperLook: true,
      scoutAvailable: false,
      note: `Failed to rank candidates using local LLM: ${error.message || error}`
    };
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

  try {
    const completion = await callChatCompletion(systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(completion.content)) as LogQueryResponse;
    if (typeof parsed.answer !== 'string') {
      parsed.answer = '';
    }
    if (typeof parsed.relevantExcerpt !== 'string') {
      parsed.relevantExcerpt = '';
    }
    if (typeof parsed.lineRange !== 'string') {
      parsed.lineRange = '';
    }
    parsed.available = true;
    return attachLLMUsage(parsed, completion.usage);
  } catch (error: any) {
    /* Model offline or unparseable: signal unavailability so the caller can fall back to grep_log or a raw-log slice. */
    return {
      answer: `Failed to query log using local LLM: ${error.message || error}`,
      relevantExcerpt: '',
      lineRange: '',
      available: false,
    };
  }
}
