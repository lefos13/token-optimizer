"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExecutionMetadata = buildExecutionMetadata;
/* Shared response shaping seam keeps machine-readable execution fields testable without starting the stdio transport. */
function buildExecutionMetadata(results, trimmed, rawBytes, warnings = [], audit) {
    const executionStatus = results.some(r => r.executionStatus === 'blocked') ? 'blocked' : results.some(r => r.executionStatus === 'timed_out') ? 'timed_out' : results.some(r => r.executionStatus === 'spawn_failed') ? 'spawn_failed' : results.some(r => r.executionStatus === 'terminated') ? 'terminated' : 'completed';
    const policyDecision = results.find(r => r.policyReasonCode)?.policyReasonCode;
    const signal = results.find(r => r.signal)?.signal || null;
    return {
        executionStatus,
        signal,
        ...(policyDecision ? { policyDecision } : {}),
        autoDetected: results.some(r => r.autoDetected === true),
        logTruncated: rawBytes > Buffer.byteLength(trimmed),
        rawSourceBytes: rawBytes,
        rawSourceTokens: Math.ceil(rawBytes / 4),
        warnings,
        ...(audit ? {
            auditStatus: audit.auditStatus,
            ...(audit.auditFailure ? { auditFailure: audit.auditFailure } : {})
        } : {})
    };
}
