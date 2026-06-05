import { FailureDetail } from './types';

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

/* Shared transport for every local-LLM call: builds the OpenAI-compatible request and returns the raw message content, or throws so each caller can apply its own conservative fallback. */
async function callChatCompletion(systemPrompt: string, userPrompt: string): Promise<string> {
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
  return rawContent;
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
    const rawContent = await callChatCompletion(systemPrompt, userPrompt);
    const jsonString = extractJSON(rawContent);
    const result = JSON.parse(jsonString) as LLMVerdictResponse;

    // Validate verdict values
    if (!['pass', 'fail', 'uncertain'].includes(result.verdict)) {
      result.verdict = 'uncertain';
    }

    return result;
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
    const rawContent = await callChatCompletion(systemPrompt, userPrompt);
    const jsonString = extractJSON(rawContent);
    const parsed = JSON.parse(jsonString) as CodeReviewResponse;
    if (typeof parsed.summary !== 'string') {
      parsed.summary = '';
    }
    parsed.reviewAvailable = true;
    return parsed;
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
    const rawContent = await callChatCompletion(systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(rawContent)) as CommandDigestResponse;
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
    return parsed;
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

export interface LogQueryResponse {
  answer: string;
  relevantExcerpt: string;
  lineRange: string;
  available?: boolean;
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
    const rawContent = await callChatCompletion(systemPrompt, userPrompt);
    const parsed = JSON.parse(extractJSON(rawContent)) as LogQueryResponse;
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
    return parsed;
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
