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
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const detector_1 = require("./detector");
const runner_1 = require("./runner");
const llm_1 = require("./llm");
const registry_1 = require("./registry");
const analytics_1 = require("./analytics");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const server = new index_js_1.Server({
    name: 'local-tester-mcp',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
function jsonText(value) {
    return JSON.stringify(value, null, 2);
}
/* Tool handlers build the exact MCP response text first, then persist separate analytics from that text and the local source material. */
function recordToolAnalytics(workspacePath, input) {
    (0, analytics_1.recordAnalytics)(workspacePath, (0, analytics_1.buildAnalyticsRecord)({
        toolName: input.toolName,
        rawSourceText: input.rawSourceText,
        llmInputText: input.llmInputText,
        responseText: input.responseText,
        llmUsage: (0, llm_1.getLLMUsage)(input.llmResult),
        llmMetadata: input.llmMetadata || (0, llm_1.getLLMMetadata)(input.llmResult),
        confidence: input.confidence,
        avoidedRawOutput: input.avoidedRawOutput,
        targetWorkspacePath: workspacePath,
        runId: input.runId,
        rawLogPath: input.rawLogPath,
        logPath: input.logPath,
        commands: input.commands,
        exitCodes: input.exitCodes
    }));
}
server.setRequestHandler(types_js_1.ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: 'check_local_llm_health',
                description: 'Checks the configured local OpenAI-compatible LLM endpoint with a tiny JSON-only request and returns provider/model availability metadata without exposing prompts, raw responses, or secrets.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'run_test_verdict',
                description: 'Runs build/lint/tests in the workspace and triages results using a local LLM to output a compact verdict.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: {
                            type: 'string',
                            description: 'Absolute path to the project workspace directory.'
                        },
                        taskSummary: {
                            type: 'string',
                            description: 'Summary of the task or code modifications Codex is performing.'
                        },
                        changedFiles: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional list of files changed during this session.'
                        },
                        testCommand: {
                            type: 'string',
                            description: 'Optional manual shell command override (e.g. "npm test" or "npm run lint && npm test").'
                        },
                        maxOutputLines: {
                            type: 'number',
                            description: 'Optional cap on how many log lines are sent to the local model.'
                        },
                        timeoutMs: {
                            type: 'number',
                            description: 'Optional per-command timeout in milliseconds. Defaults to 300000 (5 minutes).'
                        },
                        parallel: {
                            type: 'boolean',
                            description: 'Run detected commands concurrently instead of sequentially. Logs are still assembled in command order. Use only when the commands are independent.'
                        },
                        autoTriage: {
                            type: 'boolean',
                            description: 'Optional. When true, automatically triage failures/uncertainties internally and attach the results.'
                        }
                    },
                    required: ['workspacePath', 'taskSummary']
                }
            },
            {
                name: 'run_failure_triage',
                description: 'Analyzes a log file to determine failure cause and suggest a fix.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        logPath: { type: 'string', description: 'Path to log file.' }
                    },
                    required: ['logPath']
                }
            },
            {
                name: 'run_changed_files_review',
                description: 'Reviews modified files for basic regressions or errors before running test suite.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: { type: 'string' },
                        changedFiles: { type: 'array', items: { type: 'string' } },
                        useDiff: {
                            type: 'boolean',
                            description: 'Review the git working-tree diff vs HEAD for each file instead of the whole file. Cheaper and more focused; falls back to whole-file content when a file has no diff or the workspace is not a git repository.'
                        }
                    },
                    required: ['workspacePath', 'changedFiles']
                }
            },
            {
                name: 'run_regression_check',
                description: 'Compares test behavior against a baseline output to find newly introduced failures.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: { type: 'string' }
                    },
                    required: ['workspacePath']
                }
            },
            {
                name: 'run_command_digest',
                description: 'Runs an arbitrary shell command (or short sequence) in the workspace, stores the full log, and returns a compact local-LLM digest steered by your intent. Use for any noisy command whose raw output would flood context (installs, builds, migrations, large greps/finds, git history, codegen). Exit codes are reported verbatim; the digest only describes output, it does not decide pass/fail.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: {
                            type: 'string',
                            description: 'Absolute path to the project workspace directory.'
                        },
                        command: {
                            oneOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ],
                            description: 'A single shell command, or an ordered list of commands to run sequentially.'
                        },
                        intent: {
                            type: 'string',
                            description: 'What you are trying to learn from the output. Steers the digest (e.g. "did the install add any deprecated packages?" or "summarize the migration result").'
                        },
                        timeoutMs: {
                            type: 'number',
                            description: 'Optional per-command timeout in milliseconds. Defaults to 300000 (5 minutes).'
                        },
                        maxOutputLines: {
                            type: 'number',
                            description: 'Optional cap on how many log lines are sent to the local model.'
                        }
                    },
                    required: ['workspacePath', 'command', 'intent']
                }
            },
            {
                name: 'query_log',
                description: 'Asks a targeted natural-language question against a stored run log (by runId or path) and returns a compact answer plus only the relevant excerpt. Use this instead of reading a full rawLogPath after a fail/uncertain verdict, so the large log stays on disk.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: {
                            type: 'string',
                            description: 'Absolute path to the project workspace directory (used to resolve runId and relative log paths).'
                        },
                        runId: {
                            type: 'string',
                            description: 'Stable run handle returned by run_test_verdict/run_command_digest/run_regression_check. Provide this or logPath.'
                        },
                        logPath: {
                            type: 'string',
                            description: 'Absolute or workspace-relative path to a stored log file. Provide this or runId.'
                        },
                        question: {
                            type: 'string',
                            description: 'The specific question to answer from the log (e.g. "which test failed and on what assertion?").'
                        },
                        maxLines: {
                            type: 'number',
                            description: 'Optional cap on how many log lines are sent to the local model. Defaults to 1200.'
                        }
                    },
                    required: ['workspacePath', 'question']
                }
            },
            {
                name: 'scout_codebase',
                description: 'Subagent recon for the main model: instead of scanning the whole tree yourself, hand off a navigation goal and let the local LLM point you at the few relevant code regions. The server greps the workspace for seed terms (deterministically), then the local model ranks the matches into pointers (file + lineRange + why + confidence). Returns both the LLM-ranked pointers AND the raw grep-derived candidateFiles, so it stays useful even if the local model is offline. Pointers are hints to verify, not authority. Use before a broad exploration to narrow where to read.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: {
                            type: 'string',
                            description: 'Absolute path to the project workspace directory.'
                        },
                        goal: {
                            type: 'string',
                            description: 'What you are trying to locate or understand (e.g. "where is auth token refresh handled?").'
                        },
                        seedTerms: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional literal terms/symbols to grep for. If omitted, terms are derived from the goal. Providing precise symbols greatly improves results.'
                        },
                        roots: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Optional workspace-relative directories to scope the search (e.g. ["src"]). Defaults to the whole workspace.'
                        },
                        maxCandidates: {
                            type: 'number',
                            description: 'Optional cap on how many matching files are considered. Defaults to 30.'
                        },
                        contextLines: {
                            type: 'number',
                            description: 'Optional number of source lines kept around each grep hit. Defaults to 4.'
                        }
                    },
                    required: ['workspacePath', 'goal']
                }
            },
            {
                name: 'grep_log',
                description: 'Deterministic, no-LLM regex search over a stored run log (by runId or path). Returns matching line windows with surrounding context. Use when you know the token/symbol you are looking for and want exact lines without spending a model call.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        workspacePath: {
                            type: 'string',
                            description: 'Absolute path to the project workspace directory (used to resolve runId and relative log paths).'
                        },
                        runId: {
                            type: 'string',
                            description: 'Stable run handle. Provide this or logPath.'
                        },
                        logPath: {
                            type: 'string',
                            description: 'Absolute or workspace-relative path to a stored log file. Provide this or runId.'
                        },
                        pattern: {
                            type: 'string',
                            description: 'Case-insensitive regular expression to search for.'
                        },
                        context: {
                            type: 'number',
                            description: 'Number of lines of context to include before and after each match. Defaults to 3.'
                        },
                        maxMatches: {
                            type: 'number',
                            description: 'Maximum number of match windows to return. Defaults to 20.'
                        }
                    },
                    required: ['workspacePath', 'pattern']
                }
            }
        ]
    };
});
server.setRequestHandler(types_js_1.CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'check_local_llm_health') {
        try {
            const health = await (0, llm_1.checkLocalLLMHealth)();
            const text = jsonText(health);
            recordToolAnalytics(process.cwd(), {
                toolName: 'check_local_llm_health',
                rawSourceText: '',
                responseText: text,
                llmResult: health,
                llmMetadata: health,
                avoidedRawOutput: false
            });
            return {
                content: [{ type: 'text', text }]
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error executing check_local_llm_health: ${err.message || err}` }],
                isError: true
            };
        }
    }
    if (name === 'run_test_verdict') {
        const { workspacePath, taskSummary, changedFiles = [], testCommand, maxOutputLines, timeoutMs, parallel, autoTriage } = args;
        try {
            // 1. Determine commands to execute
            let commandsToRun = [];
            if (testCommand) {
                commandsToRun = [testCommand];
            }
            else {
                commandsToRun = await (0, detector_1.detectCommands)(workspacePath);
            }
            if (commandsToRun.length === 0) {
                const output = {
                    verdict: 'uncertain',
                    confidence: 0.5,
                    commandsRun: [],
                    summary: 'No tests or build tools detected in workspace directory.',
                    failures: [],
                    rawLogPath: ''
                };
                const text = jsonText(output);
                recordToolAnalytics(workspacePath, {
                    toolName: 'run_test_verdict',
                    rawSourceText: '',
                    responseText: text,
                    commands: [],
                    avoidedRawOutput: false
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text
                        }
                    ]
                };
            }
            // 2. Run commands
            const suiteResult = await (0, runner_1.runSuite)(commandsToRun, workspacePath, { maxOutputLines, timeoutMs, parallel });
            // Create a dictionary of command -> exitCode for easy triaging
            const exitCodes = {};
            let absoluteFail = false;
            for (const res of suiteResult.results) {
                exitCodes[res.command] = res.exitCode;
                if (res.exitCode !== 0) {
                    absoluteFail = true;
                }
            }
            // 3. Call local LLM
            const triage = await (0, llm_1.queryLocalLLM)(taskSummary, commandsToRun, exitCodes, changedFiles, suiteResult.trimmedLogContent);
            // Map local LLM verdict to overall result
            // Keep safety: command exit codes are authoritative and the local LLM cannot override them.
            let finalVerdict = triage.verdict;
            if (absoluteFail) {
                finalVerdict = 'fail'; // Override faulty or unavailable LLM intuition
            }
            else if (!absoluteFail && finalVerdict === 'fail') {
                finalVerdict = 'pass'; // Override if everything exited with 0
            }
            // Auto-triage failure or uncertainty if requested
            let triageResult = undefined;
            if (autoTriage && (finalVerdict === 'fail' || finalVerdict === 'uncertain')) {
                const question = "which tests failed, on which lines, and what is the error message?";
                const numbered = (0, runner_1.numberLines)(suiteResult.rawLogContent);
                // Default log query budget is 1200 lines
                const budget = 1200;
                const startBudget = Math.max(1, Math.floor(budget / 3));
                const bounded = (0, runner_1.trimLog)(numbered, startBudget, budget - startBudget);
                try {
                    triageResult = await (0, llm_1.queryLogQuestion)(question, bounded);
                }
                catch (triageErr) {
                    triageResult = {
                        answer: `Failed to query log internally: ${triageErr.message || triageErr}`,
                        relevantExcerpt: '',
                        lineRange: '',
                        available: false
                    };
                }
            }
            // Combine LLM usage metrics if we ran auto-triage
            if (triageResult) {
                const primaryUsage = (0, llm_1.getLLMUsage)(triage);
                const secondaryUsage = (0, llm_1.getLLMUsage)(triageResult);
                const combinedUsage = (0, llm_1.combineLLMUsage)(primaryUsage, secondaryUsage);
                if (combinedUsage) {
                    (0, llm_1.attachLLMUsage)(triage, combinedUsage);
                }
            }
            const runId = path.basename(suiteResult.rawLogPath).replace(/\.log$/, '');
            const output = {
                verdict: finalVerdict,
                confidence: triage.confidence,
                commandsRun: commandsToRun,
                summary: triage.summary,
                failures: finalVerdict === 'pass' ? [] : triage.failures,
                runId,
                rawLogPath: suiteResult.rawLogPath,
                needsRawLogs: triage.needsRawLogs,
                likelyRelevantToRecentChanges: triage.likelyRelevantToRecentChanges,
                ...(0, llm_1.getLLMMetadata)(triage)
            };
            if (triageResult) {
                output.triage = triageResult;
            }
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'run_test_verdict',
                rawSourceText: suiteResult.rawLogContent,
                llmInputText: suiteResult.trimmedLogContent,
                responseText: text,
                llmResult: triage,
                confidence: triage.confidence,
                avoidedRawOutput: true,
                runId,
                rawLogPath: suiteResult.rawLogPath,
                commands: commandsToRun,
                exitCodes
            });
            return {
                content: [
                    {
                        type: 'text',
                        text
                    }
                ]
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing run_test_verdict: ${err.message || err}`
                    }
                ],
                isError: true
            };
        }
    }
    // Implement actual tool handlers
    if (name === 'run_failure_triage') {
        const { logPath } = args;
        try {
            const resolvedPath = path.resolve(logPath);
            if (!fs.existsSync(resolvedPath)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: Log file not found at ${resolvedPath}`
                        }
                    ],
                    isError: true
                };
            }
            const logContent = fs.readFileSync(resolvedPath, 'utf8');
            const trimmed = (0, runner_1.trimLog)(logContent);
            const triage = await (0, llm_1.queryLocalLLM)("Triage request for log file", [], {}, [], trimmed, 'triage');
            const workspaceForAnalytics = (0, analytics_1.inferWorkspaceFromLogPath)(resolvedPath);
            const output = {
                verdict: triage.verdict,
                confidence: triage.confidence,
                summary: triage.summary,
                failures: triage.failures,
                needsRawLogs: triage.needsRawLogs,
                ...(0, llm_1.getLLMMetadata)(triage)
            };
            const text = jsonText(output);
            recordToolAnalytics(workspaceForAnalytics, {
                toolName: 'run_failure_triage',
                rawSourceText: logContent,
                llmInputText: trimmed,
                responseText: text,
                llmResult: triage,
                confidence: triage.confidence,
                avoidedRawOutput: true,
                logPath: path.relative(workspaceForAnalytics, resolvedPath)
            });
            return {
                content: [
                    {
                        type: 'text',
                        text
                    }
                ]
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing run_failure_triage: ${err.message || err}`
                    }
                ],
                isError: true
            };
        }
    }
    if (name === 'run_changed_files_review') {
        const { workspacePath, changedFiles, useDiff } = args;
        try {
            /* Track files we could not read so the caller knows the review was partial instead of silently incomplete. */
            const filesToReview = [];
            const skipped = [];
            for (const file of changedFiles) {
                const fullPath = path.resolve(workspacePath, file);
                if (!fs.existsSync(fullPath)) {
                    skipped.push({ file, reason: 'not found' });
                    continue;
                }
                const stat = fs.statSync(fullPath);
                if (!stat.isFile()) {
                    skipped.push({ file, reason: 'not a file' });
                    continue;
                }
                if (stat.size >= 500 * 1024) { // Only read files under 500KB
                    skipped.push({ file, reason: 'exceeds 500KB size limit' });
                    continue;
                }
                /* When useDiff is set, review only the working-tree diff vs HEAD (far fewer tokens, sharper focus). Fall back to whole-file content when there is no diff or the workspace is not a git repo. */
                if (useDiff) {
                    const diff = await (0, runner_1.getGitDiff)(workspacePath, file);
                    if (diff) {
                        filesToReview.push({ filename: `${file} (diff vs HEAD)`, content: diff });
                        continue;
                    }
                }
                const content = fs.readFileSync(fullPath, 'utf8');
                filesToReview.push({ filename: file, content });
            }
            if (filesToReview.length === 0) {
                const output = {
                    hasIssues: false,
                    issues: [],
                    summary: 'No changed files could be read for review.',
                    skipped
                };
                const text = jsonText(output);
                recordToolAnalytics(workspacePath, {
                    toolName: 'run_changed_files_review',
                    rawSourceText: '',
                    responseText: text,
                    avoidedRawOutput: false
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text
                        }
                    ]
                };
            }
            const review = await (0, llm_1.queryCodeReview)(filesToReview);
            const rawSourceText = filesToReview.map((f) => f.content).join('\n');
            const output = { ...review, skipped };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'run_changed_files_review',
                rawSourceText,
                llmInputText: rawSourceText,
                responseText: text,
                llmResult: review,
                avoidedRawOutput: true
            });
            return {
                content: [
                    {
                        type: 'text',
                        text
                    }
                ]
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing run_changed_files_review: ${err.message || err}`
                    }
                ],
                isError: true
            };
        }
    }
    if (name === 'run_regression_check') {
        const { workspacePath } = args;
        try {
            const commandsToRun = await (0, detector_1.detectCommands)(workspacePath);
            if (commandsToRun.length === 0) {
                const output = {
                    status: 'uncertain',
                    message: 'No test commands detected.'
                };
                const text = jsonText(output);
                recordToolAnalytics(workspacePath, {
                    toolName: 'run_regression_check',
                    rawSourceText: '',
                    responseText: text,
                    commands: [],
                    avoidedRawOutput: false
                });
                return {
                    content: [
                        {
                            type: 'text',
                            text
                        }
                    ]
                };
            }
            const suiteResult = await (0, runner_1.runSuite)(commandsToRun, workspacePath, {});
            const exitCodes = {};
            let hasFailures = false;
            for (const res of suiteResult.results) {
                exitCodes[res.command] = res.exitCode;
                if (res.exitCode !== 0) {
                    hasFailures = true;
                }
            }
            const baselinePath = path.join(workspacePath, '.codex-local-test-runs', 'baseline.json');
            let comparison = 'No baseline found. Saving current run as baseline.';
            let isRegression = false;
            const currentRunData = {
                exitCodes,
                timestamp: new Date().toISOString(),
                success: !hasFailures
            };
            if (fs.existsSync(baselinePath)) {
                try {
                    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
                    isRegression = hasFailures && baseline.success;
                    comparison = `Baseline success state: ${baseline.success}. Current success state: ${!hasFailures}. Regression detected: ${isRegression}`;
                }
                catch (e) {
                    comparison = `Error reading baseline: ${e.message || e}. Overwriting with current run.`;
                }
            }
            // Save current run as baseline for future checks
            fs.writeFileSync(baselinePath, JSON.stringify(currentRunData, null, 2), 'utf8');
            const runId = path.basename(suiteResult.rawLogPath).replace(/\.log$/, '');
            const output = {
                isRegression,
                comparison,
                currentRun: currentRunData,
                rawLogPath: suiteResult.rawLogPath
            };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'run_regression_check',
                rawSourceText: suiteResult.rawLogContent,
                responseText: text,
                runId,
                rawLogPath: suiteResult.rawLogPath,
                commands: commandsToRun,
                exitCodes,
                avoidedRawOutput: true
            });
            return {
                content: [
                    {
                        type: 'text',
                        text
                    }
                ]
            };
        }
        catch (err) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error executing run_regression_check: ${err.message || err}`
                    }
                ],
                isError: true
            };
        }
    }
    if (name === 'run_command_digest') {
        const { workspacePath, command, intent, timeoutMs, maxOutputLines } = args;
        try {
            const commandsToRun = Array.isArray(command) ? command : [command];
            if (commandsToRun.length === 0 || commandsToRun.some((c) => typeof c !== 'string' || c.trim() === '')) {
                return {
                    content: [{ type: 'text', text: 'Error: "command" must be a non-empty string or array of non-empty strings.' }],
                    isError: true
                };
            }
            const suiteResult = await (0, runner_1.runSuite)(commandsToRun, workspacePath, { maxOutputLines, timeoutMs });
            /* Exit codes stay authoritative: report them verbatim and derive an effective code (non-zero if any command failed). The LLM only describes the output. */
            const exitCodes = {};
            let effectiveExitCode = 0;
            for (const res of suiteResult.results) {
                exitCodes[res.command] = res.exitCode;
                if (res.exitCode !== 0 && effectiveExitCode === 0) {
                    effectiveExitCode = res.exitCode;
                }
            }
            const digest = await (0, llm_1.queryCommandDigest)(intent, commandsToRun, exitCodes, suiteResult.trimmedLogContent);
            const runId = path.basename(suiteResult.rawLogPath).replace(/\.log$/, '');
            const output = {
                exitCode: effectiveExitCode,
                exitCodes,
                summary: digest.summary,
                keyFindings: digest.keyFindings,
                digest: digest.digest,
                runId,
                rawLogPath: suiteResult.rawLogPath,
                needsRawLogs: digest.needsRawLogs,
                ...(0, llm_1.getLLMMetadata)(digest)
            };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'run_command_digest',
                rawSourceText: suiteResult.rawLogContent,
                llmInputText: suiteResult.trimmedLogContent,
                responseText: text,
                llmResult: digest,
                avoidedRawOutput: true,
                runId,
                rawLogPath: suiteResult.rawLogPath,
                commands: commandsToRun,
                exitCodes
            });
            return {
                content: [{ type: 'text', text }]
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error executing run_command_digest: ${err.message || err}` }],
                isError: true
            };
        }
    }
    if (name === 'query_log') {
        const { workspacePath, runId, logPath, question, maxLines } = args;
        try {
            if (!runId && !logPath) {
                return {
                    content: [{ type: 'text', text: 'Error: provide either "runId" or "logPath".' }],
                    isError: true
                };
            }
            const absLog = (0, registry_1.resolveLogPath)(workspacePath, { runId, logPath });
            if (!absLog || !fs.existsSync(absLog)) {
                return {
                    content: [{ type: 'text', text: `Error: could not resolve a log for runId=${runId ?? ''} logPath=${logPath ?? ''}` }],
                    isError: true
                };
            }
            /* Number lines first so the model can cite exact ranges, then bound the payload while preserving those prefixes. */
            const numbered = (0, runner_1.numberLines)(fs.readFileSync(absLog, 'utf8'));
            const budget = maxLines && maxLines > 0 ? maxLines : 1200;
            const startBudget = Math.max(1, Math.floor(budget / 3));
            const bounded = (0, runner_1.trimLog)(numbered, startBudget, budget - startBudget);
            const res = await (0, llm_1.queryLogQuestion)(question, bounded);
            const output = { ...res, rawLogPath: path.relative(workspacePath, absLog) };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'query_log',
                rawSourceText: fs.readFileSync(absLog, 'utf8'),
                llmInputText: bounded,
                responseText: text,
                llmResult: res,
                avoidedRawOutput: true,
                runId,
                rawLogPath: path.relative(workspacePath, absLog)
            });
            return {
                content: [{ type: 'text', text }]
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error executing query_log: ${err.message || err}` }],
                isError: true
            };
        }
    }
    if (name === 'grep_log') {
        const { workspacePath, runId, logPath, pattern, context, maxMatches } = args;
        try {
            if (!runId && !logPath) {
                return {
                    content: [{ type: 'text', text: 'Error: provide either "runId" or "logPath".' }],
                    isError: true
                };
            }
            const absLog = (0, registry_1.resolveLogPath)(workspacePath, { runId, logPath });
            if (!absLog || !fs.existsSync(absLog)) {
                return {
                    content: [{ type: 'text', text: `Error: could not resolve a log for runId=${runId ?? ''} logPath=${logPath ?? ''}` }],
                    isError: true
                };
            }
            const logContent = fs.readFileSync(absLog, 'utf8');
            const result = (0, registry_1.grepLog)(absLog, pattern, context, maxMatches);
            const output = { ...result, rawLogPath: path.relative(workspacePath, absLog) };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'grep_log',
                rawSourceText: logContent,
                responseText: text,
                avoidedRawOutput: true,
                runId,
                rawLogPath: path.relative(workspacePath, absLog)
            });
            return {
                content: [{ type: 'text', text }]
            };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error executing grep_log: ${err.message || err}` }],
                isError: true
            };
        }
    }
    if (name === 'scout_codebase') {
        const { workspacePath, goal, seedTerms, roots, maxCandidates, contextLines } = args;
        try {
            /* Seed terms drive the deterministic grep. When the caller does not supply them, derive coarse tokens from the goal (drop short/stop words). Caller-provided symbols are always far better, hence the schema nudge. */
            const terms = (seedTerms && seedTerms.length > 0)
                ? seedTerms
                : deriveSeedTerms(goal);
            if (terms.length === 0) {
                const output = {
                    goal,
                    candidateFiles: [],
                    pointers: [],
                    summary: 'No usable seed terms could be derived from the goal. Provide seedTerms explicitly.',
                    needsDeeperLook: true,
                    scoutAvailable: false
                };
                const text = jsonText(output);
                recordToolAnalytics(workspacePath, { toolName: 'scout_codebase', rawSourceText: '', responseText: text, avoidedRawOutput: false });
                return { content: [{ type: 'text', text }] };
            }
            const gathered = await (0, runner_1.gatherCandidates)(workspacePath, terms, { roots, maxCandidates, contextLines });
            const candidateFiles = gathered.candidates.map((c) => c.file);
            if (gathered.candidates.length === 0) {
                const output = {
                    goal,
                    searchedWith: gathered.searchedWith,
                    seedTerms: terms,
                    filesMatched: gathered.filesMatched,
                    candidateFiles: [],
                    pointers: [],
                    suggestedNextSearches: [],
                    summary: `No candidate regions matched the seed terms ${JSON.stringify(terms)}. Try different seedTerms or roots.`,
                    needsDeeperLook: true,
                    scoutAvailable: false
                };
                const text = jsonText(output);
                recordToolAnalytics(workspacePath, { toolName: 'scout_codebase', rawSourceText: '', responseText: text, avoidedRawOutput: false });
                return { content: [{ type: 'text', text }] };
            }
            const scout = await (0, llm_1.queryScout)(goal, gathered.candidates);
            const rawSourceText = gathered.candidates
                .map((c) => `${c.file}\n${c.regions.map((r) => r.snippet).join('\n')}`)
                .join('\n');
            const output = {
                goal,
                searchedWith: gathered.searchedWith,
                seedTerms: terms,
                filesMatched: gathered.filesMatched,
                candidateFiles,
                pointers: scout.pointers,
                suggestedNextSearches: scout.suggestedNextSearches,
                summary: scout.summary,
                needsDeeperLook: scout.needsDeeperLook,
                scoutAvailable: scout.scoutAvailable,
                ...(0, llm_1.getLLMMetadata)(scout),
                ...(scout.note ? { note: scout.note } : {})
            };
            const text = jsonText(output);
            recordToolAnalytics(workspacePath, {
                toolName: 'scout_codebase',
                rawSourceText,
                llmInputText: rawSourceText,
                responseText: text,
                llmResult: scout,
                avoidedRawOutput: true
            });
            return { content: [{ type: 'text', text }] };
        }
        catch (err) {
            return {
                content: [{ type: 'text', text: `Error executing scout_codebase: ${err.message || err}` }],
                isError: true
            };
        }
    }
    throw new Error(`Unknown tool: ${name}`);
});
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'where', 'what', 'which', 'how', 'does', 'this', 'that',
    'from', 'into', 'when', 'who', 'whom', 'are', 'was', 'were', 'has', 'have', 'had',
    'find', 'locate', 'show', 'handle', 'handled', 'handling', 'code', 'file', 'files',
    'function', 'functions', 'where\'s', 'about', 'used', 'using', 'use'
]);
/* Coarse fallback when the caller gives no seedTerms: keep distinctive words from the goal (length > 3, not a stop word, deduped). Caller-supplied symbols are preferred; this just keeps the tool usable without them. */
function deriveSeedTerms(goal) {
    const tokens = goal.toLowerCase().match(/[a-z0-9_]+/gi) || [];
    const seen = new Set();
    const terms = [];
    for (const t of tokens) {
        if (t.length <= 3 || STOP_WORDS.has(t) || seen.has(t))
            continue;
        seen.add(t);
        terms.push(t);
    }
    return terms.slice(0, 8);
}
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error('Server execution error:', error);
    process.exit(1);
});
