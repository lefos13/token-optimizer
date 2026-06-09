"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyticsStoreRoot = analyticsStoreRoot;
exports.inferWorkspaceFromLogPath = inferWorkspaceFromLogPath;
exports.buildAnalyticsRecord = buildAnalyticsRecord;
exports.recordAnalytics = recordAnalytics;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const runner_1 = require("./runner");
const LOG_DIR = '.codex-local-test-runs';
const ANALYTICS_FILE = 'analytics.json';
const SUMMARY_FILE = 'analytics-summary.json';
const MAX_RECORDS = 200;
/* Analytics are stored inside the target workspace, alongside its raw run logs
   and baseline, so they travel with the project being validated (and remain
   readable/portable regardless of where the MCP server itself is installed —
   including from inside a bundled Claude Code plugin). */
function analyticsStoreRoot(targetWorkspacePath) {
    return targetWorkspacePath;
}
function analyticsDir(targetWorkspacePath) {
    return path.join(analyticsStoreRoot(targetWorkspacePath), LOG_DIR);
}
function readRecords(filePath) {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function summarize(records) {
    const summary = {
        updatedAt: new Date().toISOString(),
        totalCalls: records.length,
        callsByTool: {},
        callsByProvider: {},
        totalRawSourceTokens: 0,
        totalLocalLlmTokens: 0,
        totalReturnedToMainTokens: 0,
        totalEstimatedMainContextTokensSaved: 0,
        averageSavingsPercentage: 0
    };
    let savingsTotal = 0;
    for (const record of records) {
        summary.callsByTool[record.toolName] = (summary.callsByTool[record.toolName] || 0) + 1;
        const provider = record.llmProvider || 'none';
        summary.callsByProvider[provider] = (summary.callsByProvider[provider] || 0) + 1;
        summary.totalRawSourceTokens += record.rawSourceTokens;
        summary.totalLocalLlmTokens += record.localLlmTotalTokens;
        summary.totalReturnedToMainTokens += record.returnedToMainTokens;
        summary.totalEstimatedMainContextTokensSaved += record.estimatedTokensSaved;
        savingsTotal += record.savingsPercentage;
    }
    summary.averageSavingsPercentage = records.length > 0 ? Number((savingsTotal / records.length).toFixed(4)) : 0;
    return summary;
}
function inferWorkspaceFromLogPath(absLogPath) {
    const marker = `${path.sep}${LOG_DIR}${path.sep}`;
    const idx = absLogPath.indexOf(marker);
    if (idx >= 0) {
        return absLogPath.slice(0, idx);
    }
    return path.dirname(absLogPath);
}
function buildAnalyticsRecord(input) {
    const rawSourceTokens = (0, runner_1.estimateTokens)(input.rawSourceText);
    const returnedToMainTokens = (0, runner_1.estimateTokens)(input.responseText);
    const estimatedInputTokens = (0, runner_1.estimateTokens)(input.llmInputText || '');
    const usage = input.llmUsage;
    const localLlmInputTokens = usage?.promptTokens ?? estimatedInputTokens;
    const localLlmOutputTokens = usage?.completionTokens ?? 0;
    const localLlmTotalTokens = usage?.totalTokens ?? (localLlmInputTokens + localLlmOutputTokens);
    const estimatedTokensSaved = Math.max(0, rawSourceTokens - returnedToMainTokens);
    const savingsPercentage = rawSourceTokens > 0
        ? Number((estimatedTokensSaved / rawSourceTokens).toFixed(4))
        : 0;
    let measurementSource = 'estimated';
    if (usage?.source === 'api') {
        measurementSource = input.llmInputText ? 'mixed' : 'api_usage';
    }
    else if (usage?.source === 'estimated') {
        measurementSource = 'estimated';
    }
    return {
        toolName: input.toolName,
        timestamp: new Date().toISOString(),
        targetWorkspacePath: input.targetWorkspacePath,
        runId: input.runId,
        rawLogPath: input.rawLogPath,
        logPath: input.logPath,
        commands: input.commands,
        exitCodes: input.exitCodes,
        rawSourceTokens,
        localLlmInputTokens,
        localLlmOutputTokens,
        localLlmTotalTokens,
        returnedToMainTokens,
        estimatedTokensSaved,
        savingsPercentage,
        measurementSource,
        llmAvailable: input.llmMetadata?.llmAvailable,
        llmProvider: input.llmMetadata?.llmProvider,
        llmModel: input.llmMetadata?.llmModel,
        llmLatencyMs: input.llmMetadata?.llmLatencyMs,
        llmTaskType: input.llmMetadata?.llmTaskType,
        confidence: input.confidence,
        fallbackReason: input.llmMetadata?.fallbackReason,
        avoidedRawOutput: input.avoidedRawOutput
    };
}
/* Analytics are operational evidence, not part of the MCP contract. Each workspace
   keeps its own analytics under its .codex-local-test-runs/ directory (next to its
   raw logs and baseline), so they remain readable from the workspace itself and
   the analytics UI can be pointed at any number of workspaces to report on them. */
function recordAnalytics(targetWorkspacePath, record) {
    try {
        const dir = analyticsDir(targetWorkspacePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const analyticsPath = path.join(dir, ANALYTICS_FILE);
        const records = readRecords(analyticsPath);
        records.push(record);
        const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
        fs.writeFileSync(analyticsPath, JSON.stringify(trimmed, null, 2), 'utf8');
        fs.writeFileSync(path.join(dir, SUMMARY_FILE), JSON.stringify(summarize(trimmed), null, 2), 'utf8');
    }
    catch {
        /* ignore analytics write failures */
    }
}
