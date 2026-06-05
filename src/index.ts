import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { detectCommands } from './detector';
import { runSuite, trimLog, numberLines, getGitDiff, estimateTokens } from './runner';
import { queryLocalLLM, queryCodeReview, queryCommandDigest, queryLogQuestion } from './llm';
import { resolveLogPath, grepLog } from './registry';
import { RunTestVerdictArgs, RunCommandDigestArgs } from './types';
import * as fs from 'fs';
import * as path from 'path';

const server = new Server(
  {
    name: 'local-tester-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'run_test_verdict') {
    const {
      workspacePath,
      taskSummary,
      changedFiles = [],
      testCommand,
      maxOutputLines,
      timeoutMs,
      parallel
    } = args as unknown as RunTestVerdictArgs;

    try {
      // 1. Determine commands to execute
      let commandsToRun: string[] = [];
      if (testCommand) {
        commandsToRun = [testCommand];
      } else {
        commandsToRun = await detectCommands(workspacePath);
      }

      if (commandsToRun.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                verdict: 'uncertain',
                confidence: 0.5,
                commandsRun: [],
                summary: 'No tests or build tools detected in workspace directory.',
                failures: [],
                rawLogPath: ''
              }, null, 2)
            }
          ]
        };
      }

      // 2. Run commands
      const suiteResult = await runSuite(commandsToRun, workspacePath, { maxOutputLines, timeoutMs, parallel });

      // Create a dictionary of command -> exitCode for easy triaging
      const exitCodes: Record<string, number> = {};
      let absoluteFail = false;
      for (const res of suiteResult.results) {
        exitCodes[res.command] = res.exitCode;
        if (res.exitCode !== 0) {
          absoluteFail = true;
        }
      }

      // 3. Call local LLM
      const triage = await queryLocalLLM(
        taskSummary,
        commandsToRun,
        exitCodes,
        changedFiles,
        suiteResult.trimmedLogContent
      );

      // Map local LLM verdict to overall result
      // Keep safety: if any command returned non-zero code, verdict must be 'fail' (or 'uncertain' if LLM failed)
      let finalVerdict: 'pass' | 'fail' | 'uncertain' = triage.verdict;
      if (absoluteFail && finalVerdict === 'pass') {
        finalVerdict = 'fail'; // Override faulty LLM intuition
      } else if (!absoluteFail && finalVerdict === 'fail') {
        finalVerdict = 'pass'; // Override if everything exited with 0
      }

      /* Estimate how much context this compact verdict saved versus pasting the full log, so the agent can judge the trade-off. */
      const compactPayload = triage.summary + JSON.stringify(triage.failures);
      const estimatedTokensSaved = Math.max(0, estimateTokens(suiteResult.rawLogContent) - estimateTokens(compactPayload));

      const output = {
        verdict: finalVerdict,
        confidence: triage.confidence,
        commandsRun: commandsToRun,
        summary: triage.summary,
        failures: triage.failures,
        rawLogPath: suiteResult.rawLogPath,
        needsRawLogs: triage.needsRawLogs,
        likelyRelevantToRecentChanges: triage.likelyRelevantToRecentChanges,
        estimatedTokensSaved
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(output, null, 2)
          }
        ]
      };

    } catch (err: any) {
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
    const { logPath } = args as { logPath: string };
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
      const trimmed = trimLog(logContent);

      const triage = await queryLocalLLM(
        "Triage request for log file",
        [],
        {},
        [],
        trimmed
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              verdict: triage.verdict,
              confidence: triage.confidence,
              summary: triage.summary,
              failures: triage.failures,
              needsRawLogs: triage.needsRawLogs
            }, null, 2)
          }
        ]
      };
    } catch (err: any) {
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
    const { workspacePath, changedFiles, useDiff } = args as { workspacePath: string; changedFiles: string[]; useDiff?: boolean };
    try {
      /* Track files we could not read so the caller knows the review was partial instead of silently incomplete. */
      const filesToReview: { filename: string; content: string }[] = [];
      const skipped: { file: string; reason: string }[] = [];
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
          const diff = await getGitDiff(workspacePath, file);
          if (diff) {
            filesToReview.push({ filename: `${file} (diff vs HEAD)`, content: diff });
            continue;
          }
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        filesToReview.push({ filename: file, content });
      }

      if (filesToReview.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                hasIssues: false,
                issues: [],
                summary: 'No changed files could be read for review.',
                skipped
              }, null, 2)
            }
          ]
        };
      }

      const review = await queryCodeReview(filesToReview);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...review, skipped }, null, 2)
          }
        ]
      };
    } catch (err: any) {
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
    const { workspacePath } = args as { workspacePath: string };
    try {
      const commandsToRun = await detectCommands(workspacePath);
      if (commandsToRun.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'uncertain',
                message: 'No test commands detected.'
              }, null, 2)
            }
          ]
        };
      }

      const suiteResult = await runSuite(commandsToRun, workspacePath, {});
      const exitCodes: Record<string, number> = {};
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
        } catch (e: any) {
          comparison = `Error reading baseline: ${e.message || e}. Overwriting with current run.`;
        }
      }

      // Save current run as baseline for future checks
      fs.writeFileSync(baselinePath, JSON.stringify(currentRunData, null, 2), 'utf8');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              isRegression,
              comparison,
              currentRun: currentRunData,
              rawLogPath: suiteResult.rawLogPath
            }, null, 2)
          }
        ]
      };
    } catch (err: any) {
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
    const { workspacePath, command, intent, timeoutMs, maxOutputLines } = args as unknown as RunCommandDigestArgs;
    try {
      const commandsToRun = Array.isArray(command) ? command : [command];
      if (commandsToRun.length === 0 || commandsToRun.some((c) => typeof c !== 'string' || c.trim() === '')) {
        return {
          content: [{ type: 'text', text: 'Error: "command" must be a non-empty string or array of non-empty strings.' }],
          isError: true
        };
      }

      const suiteResult = await runSuite(commandsToRun, workspacePath, { maxOutputLines, timeoutMs });

      /* Exit codes stay authoritative: report them verbatim and derive an effective code (non-zero if any command failed). The LLM only describes the output. */
      const exitCodes: Record<string, number> = {};
      let effectiveExitCode = 0;
      for (const res of suiteResult.results) {
        exitCodes[res.command] = res.exitCode;
        if (res.exitCode !== 0 && effectiveExitCode === 0) {
          effectiveExitCode = res.exitCode;
        }
      }

      const digest = await queryCommandDigest(
        intent,
        commandsToRun,
        exitCodes,
        suiteResult.trimmedLogContent
      );

      const runId = path.basename(suiteResult.rawLogPath).replace(/\.log$/, '');

      /* Estimate context saved versus pasting the full command output. */
      const compactPayload = digest.summary + digest.keyFindings.join('\n') + digest.digest;
      const estimatedTokensSaved = Math.max(0, estimateTokens(suiteResult.rawLogContent) - estimateTokens(compactPayload));

      const output = {
        exitCode: effectiveExitCode,
        exitCodes,
        summary: digest.summary,
        keyFindings: digest.keyFindings,
        digest: digest.digest,
        runId,
        rawLogPath: suiteResult.rawLogPath,
        needsRawLogs: digest.needsRawLogs,
        estimatedTokensSaved
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing run_command_digest: ${err.message || err}` }],
        isError: true
      };
    }
  }

  if (name === 'query_log') {
    const { workspacePath, runId, logPath, question, maxLines } = args as {
      workspacePath: string;
      runId?: string;
      logPath?: string;
      question: string;
      maxLines?: number;
    };
    try {
      if (!runId && !logPath) {
        return {
          content: [{ type: 'text', text: 'Error: provide either "runId" or "logPath".' }],
          isError: true
        };
      }
      const absLog = resolveLogPath(workspacePath, { runId, logPath });
      if (!absLog || !fs.existsSync(absLog)) {
        return {
          content: [{ type: 'text', text: `Error: could not resolve a log for runId=${runId ?? ''} logPath=${logPath ?? ''}` }],
          isError: true
        };
      }

      /* Number lines first so the model can cite exact ranges, then bound the payload while preserving those prefixes. */
      const numbered = numberLines(fs.readFileSync(absLog, 'utf8'));
      const budget = maxLines && maxLines > 0 ? maxLines : 1200;
      const startBudget = Math.max(1, Math.floor(budget / 3));
      const bounded = trimLog(numbered, startBudget, budget - startBudget);

      const res = await queryLogQuestion(question, bounded);

      return {
        content: [{ type: 'text', text: JSON.stringify({ ...res, rawLogPath: path.relative(workspacePath, absLog) }, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing query_log: ${err.message || err}` }],
        isError: true
      };
    }
  }

  if (name === 'grep_log') {
    const { workspacePath, runId, logPath, pattern, context, maxMatches } = args as {
      workspacePath: string;
      runId?: string;
      logPath?: string;
      pattern: string;
      context?: number;
      maxMatches?: number;
    };
    try {
      if (!runId && !logPath) {
        return {
          content: [{ type: 'text', text: 'Error: provide either "runId" or "logPath".' }],
          isError: true
        };
      }
      const absLog = resolveLogPath(workspacePath, { runId, logPath });
      if (!absLog || !fs.existsSync(absLog)) {
        return {
          content: [{ type: 'text', text: `Error: could not resolve a log for runId=${runId ?? ''} logPath=${logPath ?? ''}` }],
          isError: true
        };
      }

      const result = grepLog(absLog, pattern, context, maxMatches);

      return {
        content: [{ type: 'text', text: JSON.stringify({ ...result, rawLogPath: path.relative(workspacePath, absLog) }, null, 2) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing grep_log: ${err.message || err}` }],
        isError: true
      };
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Server execution error:', error);
  process.exit(1);
});
