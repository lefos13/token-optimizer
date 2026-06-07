export interface FailureDetail {
  file: string | null;
  reason: string;
  suggestedFix: string | null;
}

export interface LogQueryResponse {
  answer: string;
  relevantExcerpt: string;
  lineRange: string;
  available?: boolean;
}

export interface VerdictResult {
  verdict: 'pass' | 'fail' | 'uncertain';
  confidence: number;
  commandsRun: string[];
  summary: string;
  failures: FailureDetail[];
  rawLogPath: string;
  needsRawLogs?: boolean;
  likelyRelevantToRecentChanges?: boolean;
  triage?: LogQueryResponse;
}

export interface RunTestVerdictArgs {
  workspacePath: string;
  taskSummary: string;
  changedFiles?: string[];
  testCommand?: string;
  maxOutputLines?: number;
  timeoutMs?: number;
  parallel?: boolean;
  autoTriage?: boolean;
}

export interface RunCommandDigestArgs {
  workspacePath: string;
  command: string | string[];
  intent: string;
  timeoutMs?: number;
  maxOutputLines?: number;
}

export interface ScoutPointer {
  file: string;
  lineRange: string;
  why: string;
  confidence: number;
}

export interface ScoutResponse {
  pointers: ScoutPointer[];
  suggestedNextSearches: string[];
  summary: string;
  /* True when the gathered candidates look insufficient to satisfy the goal, so the main model should widen the search itself. The orientation analogue of needsRawLogs. */
  needsDeeperLook: boolean;
  /* False when the local LLM was unreachable or returned unparseable output, so callers can tell "no strong pointers" apart from "ranking did not run". */
  scoutAvailable?: boolean;
  note?: string;
}

export interface RunScoutArgs {
  workspacePath: string;
  goal: string;
  seedTerms?: string[];
  roots?: string[];
  maxCandidates?: number;
  contextLines?: number;
}

