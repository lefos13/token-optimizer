"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPolicyHint = buildPolicyHint;
exports.buildExecutionMetadata = buildExecutionMetadata;
const command_policy_1 = require("./command-policy");
/* Blocked commands get a deterministic, copy-pasteable remedy. Only a profile
   rejection can be lifted by the user; deny-first rejections hold in every
   profile, so the hint says so instead of suggesting an allowlist entry that
   would never take effect. The agent must ask the user before running the
   allow command, because it widens the user's own security policy. */
function buildPolicyHint(command, reasonCode) {
    if (reasonCode === 'COMMAND_NOT_ALLOWED') {
        const allowPrefix = (0, command_policy_1.suggestAllowPrefix)(command);
        return {
            command, reasonCode, allowPrefix,
            allowCommand: `npx @softawarest/token-optimizer-installer allow "${allowPrefix}"`,
            fix: `Not permitted by the active execution profile. Ask the user whether to allow it; with consent they run the allowCommand (or choose another profile with \`npx @softawarest/token-optimizer-installer profile <safe|standard|unrestricted>\`).`,
        };
    }
    const fixes = {
        SHELL_METACHARACTER: 'Remove chaining, pipes, and redirection: output is already captured. Use testCommands for several checks and grep_log/query_log to filter output.',
        SENSITIVE_PATH: 'The command references a secret file, a home-directory secret store, or an environment variable. This is blocked in every profile.',
        WORKSPACE_ESCAPE: 'Use paths inside the workspace. Paths outside it are blocked in every profile.',
        NETWORK_EXFILTRATION: 'Network tools are blocked in every profile.',
        NESTED_SHELL: 'Nested shells and eval are blocked in every profile; pass the command directly.',
        DESTRUCTIVE_PATTERN: 'Destructive commands are blocked in every profile.',
    };
    return { command, reasonCode, fix: fixes[reasonCode] || 'Blocked by execution policy.' };
}
/* Shared response shaping seam keeps machine-readable execution fields testable without starting the stdio transport. */
function buildExecutionMetadata(results, trimmed, rawBytes, warnings = [], audit) {
    const executionStatus = results.some(r => r.executionStatus === 'blocked') ? 'blocked' : results.some(r => r.executionStatus === 'timed_out') ? 'timed_out' : results.some(r => r.executionStatus === 'spawn_failed') ? 'spawn_failed' : results.some(r => r.executionStatus === 'terminated') ? 'terminated' : 'completed';
    const policyDecision = results.find(r => r.policyReasonCode)?.policyReasonCode;
    const blocked = results.find(r => r.executionStatus === 'blocked' && r.policyReasonCode && r.command);
    const policyHint = blocked ? buildPolicyHint(blocked.command, blocked.policyReasonCode) : undefined;
    const signal = results.find(r => r.signal)?.signal || null;
    return {
        executionStatus,
        signal,
        ...(policyDecision ? { policyDecision } : {}),
        ...(policyHint ? { policyHint } : {}),
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
