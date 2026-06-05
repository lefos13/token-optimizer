export interface FailureDetail {
  file: string | null;
  reason: string;
  suggestedFix: string | null;
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
  estimatedTokensSaved?: number;
}

export interface RunTestVerdictArgs {
  workspacePath: string;
  taskSummary: string;
  changedFiles?: string[];
  testCommand?: string;
  maxOutputLines?: number;
  timeoutMs?: number;
  parallel?: boolean;
}

export interface RunCommandDigestArgs {
  workspacePath: string;
  command: string | string[];
  intent: string;
  timeoutMs?: number;
  maxOutputLines?: number;
}
