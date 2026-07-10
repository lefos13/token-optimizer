export type ExecutionStatus = 'completed' | 'timed_out' | 'blocked' | 'spawn_failed';

export interface ExecutionMetadataInput {
  executionStatus?: string;
  policyReasonCode?: string;
  autoDetected?: boolean;
  signal?: NodeJS.Signals | null;
}

/* Shared response shaping seam keeps machine-readable execution fields testable without starting the stdio transport. */
export function buildExecutionMetadata(results: ExecutionMetadataInput[], trimmed: string, rawBytes: number, warnings: string[] = []) {
  const executionStatus: ExecutionStatus = results.some(r => r.executionStatus === 'blocked') ? 'blocked' : results.some(r => r.executionStatus === 'timed_out') ? 'timed_out' : results.some(r => r.executionStatus === 'spawn_failed') ? 'spawn_failed' : 'completed';
  const policyDecision = results.find(r => r.policyReasonCode)?.policyReasonCode;
  const signal = results.find(r => r.signal)?.signal || null;
  return { executionStatus, signal, ...(policyDecision ? { policyDecision } : {}), autoDetected: results.some(r => r.autoDetected === true), logTruncated: rawBytes > Buffer.byteLength(trimmed), warnings };
}
