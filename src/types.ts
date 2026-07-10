export interface FailureDetail {
  file: string | null;
  reason: string;
  suggestedFix: string | null;
}

export interface LLMResponseMetadata {
  llmAvailable?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmLatencyMs?: number;
  llmTaskType?: string;
  fallbackReason?: string;
  redactionSummary?: { count: number; categories: string[] };
  validationErrors?: LLMValidationError[];
  providerWarnings?: string[];
}

export interface LogQueryResponse extends LLMResponseMetadata {
  answer: string;
  relevantExcerpt: string;
  lineRange: string;
  available?: boolean;
}

export interface VerdictResult extends LLMResponseMetadata {
  verdict: 'pass' | 'fail' | 'uncertain';
  confidence: number;
  commandsRun: string[];
  summary: string;
  failures: FailureDetail[];
  runId?: string;
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

export interface ScoutResponse extends LLMResponseMetadata {
  pointers: ScoutPointer[];
  suggestedNextSearches: string[];
  summary: string;
  /* True when the gathered candidates look insufficient to satisfy the goal, so the main model should widen the search itself. The orientation analogue of needsRawLogs. */
  needsDeeperLook: boolean;
  /* False when the local LLM was unreachable or returned unparseable output, so callers can tell "no strong pointers" apart from "ranking did not run". */
  scoutAvailable?: boolean;
  note?: string;
}

export type LLMResponseTask = 'verdict' | 'triage' | 'review' | 'digest' | 'scout' | 'query';

export interface LLMValidationError {
  path: (string | number)[];
  message: string;
}

export interface RunScoutArgs {
  workspacePath: string;
  goal: string;
  seedTerms?: string[];
  roots?: string[];
  maxCandidates?: number;
  contextLines?: number;
}

export type ProviderMode = 'local' | 'gateway-token' | 'gateway-byok' | 'openrouter-direct';
export type ExecutionProfile = 'safe' | 'standard' | 'unrestricted';

export interface TokenOptimizerConfig {
  provider?: Partial<{
    mode: ProviderMode;
    apiUrl: string;
    model: string;
  }>;
  execution?: Partial<{
    profile: ExecutionProfile;
    allowedCommandPrefixes: string[];
  }>;
  logs?: Partial<{
    retentionDays: number;
    maxDiskMb: number;
    storageMode: 'raw-local' | 'redacted-local';
  }>;
}

export interface ConfigLayers {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  user?: TokenOptimizerConfig;
  project?: TokenOptimizerConfig;
  tool?: TokenOptimizerConfig;
  workspacePath?: string;
}

export interface EffectiveConfig {
  provider: { mode: ProviderMode; apiUrl: string; model: string; credentialEnv?: string };
  execution: { profile: ExecutionProfile; allowedCommandPrefixes: string[] };
  logs: { retentionDays: number; maxDiskMb: number; storageMode: 'raw-local' | 'redacted-local' };
  warnings: string[];
}
