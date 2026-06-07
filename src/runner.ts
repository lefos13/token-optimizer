import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { appendRun } from './registry';

export interface RunCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

export interface ExecutedSuiteResult {
  results: RunCommandResult[];
  rawLogPath: string;
  rawLogContent: string;
  trimmedLogContent: string;
}

/**
 * Runs a single shell command inside the workspacePath, capturing all stdout and stderr.
 */
export function runCommand(command: string, workspacePath: string, timeoutMs: number = 300000): Promise<RunCommandResult> {
  const startTime = Date.now();
  return new Promise((resolve) => {
    const child = exec(command, {
      cwd: workspacePath,
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer to prevent overflow
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      const exitCode = error ? (error.code ?? 1) : 0;
      
      resolve({
        command,
        exitCode,
        stdout,
        stderr,
        durationMs,
        error: error ? error.message : undefined
      });
    });

    // Handle timeout
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      const durationMs = Date.now() - startTime;
      resolve({
        command,
        exitCode: -1,
        stdout: '',
        stderr: `Command timed out after ${timeoutMs / 1000}s.`,
        durationMs,
        error: 'Timeout'
      });
    }, timeoutMs);

    child.on('exit', () => {
      clearTimeout(timeout);
    });
  });
}

const FAILURE_MARKER = /(?:^|\b)(error|errors|failed|failure|exception|traceback|panic|assert(?:ion)?|✕|✗|FAIL)\b/i;

/**
 * Truncates logs intelligently to avoid overloading LLM contexts while preserving failure trace context.
 *
 * Beyond keeping the head and tail, this scans the omitted middle for failure markers and keeps a small
 * window around each one, so the real error is not lost when it sits between the head and tail. Falls back
 * to plain head/tail truncation when no markers are found.
 */
export function trimLog(fullLog: string, maxStartLines = 100, maxEndLines = 200): string {
  const lines = fullLog.split('\n');
  const len = lines.length;
  if (len <= maxStartLines + maxEndLines) {
    return fullLog;
  }

  const headEnd = maxStartLines;
  const tailStart = len - maxEndLines;
  const ctx = 4;
  const maxWindows = 5;

  /* Kept index ranges as [start, end) half-open. Always keep head and tail; add windows around markers in the middle. */
  const ranges: Array<[number, number]> = [[0, headEnd]];
  let windows = 0;
  for (let i = headEnd; i < tailStart && windows < maxWindows; i++) {
    if (FAILURE_MARKER.test(lines[i])) {
      ranges.push([Math.max(headEnd, i - ctx), Math.min(tailStart, i + ctx + 1)]);
      windows++;
      i += ctx; // skip past this window to avoid stacking overlapping windows on adjacent marker lines
    }
  }
  ranges.push([tailStart, len]);

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  let out = '';
  for (let k = 0; k < merged.length; k++) {
    const [s, e] = merged[k];
    out += lines.slice(s, e).join('\n');
    if (k < merged.length - 1) {
      const omitted = merged[k + 1][0] - e;
      out += `\n\n... [TRUNCATED - ${omitted} LINES OMITTED] ...\n\n`;
    }
  }
  return out;
}

/* Rough token estimate (~4 chars/token) used only to report how much context a compact result saved versus the full log. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RunSuiteOptions {
  maxOutputLines?: number;
  timeoutMs?: number;
  /* When true, independent commands run concurrently; logs are still assembled in the original command order so the output stays deterministic. */
  parallel?: boolean;
}

function formatCommandLog(res: RunCommandResult): string {
  let block = `========================================================\n`;
  block += `COMMAND: ${res.command}\n`;
  block += `========================================================\n\n`;
  block += `--- STDOUT ---\n${res.stdout}\n`;
  if (res.stderr) {
    block += `--- STDERR ---\n${res.stderr}\n`;
  }
  block += `\n--- EXIT CODE: ${res.exitCode} (Duration: ${res.durationMs}ms) ---\n\n`;
  return block;
}

/**
 * Runs multiple commands (sequentially by default, or concurrently when `parallel` is set). Creates a log
 * directory and saves the full logs, returning both full and trimmed representations. Log blocks are always
 * emitted in command order regardless of execution mode.
 */
export async function runSuite(commands: string[], workspacePath: string, options: RunSuiteOptions = {}): Promise<ExecutedSuiteResult> {
  const { maxOutputLines, timeoutMs, parallel } = options;
  const logDir = path.join(workspacePath, '.codex-local-test-runs');

  // Ensure log directory exists
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFileName = `${timestamp}.log`;
  const rawLogPath = path.join(logDir, logFileName);

  const runOne = (cmd: string) =>
    timeoutMs ? runCommand(cmd, workspacePath, timeoutMs) : runCommand(cmd, workspacePath);

  let results: RunCommandResult[];
  if (parallel) {
    results = await Promise.all(commands.map(runOne));
  } else {
    results = [];
    for (const cmd of commands) {
      results.push(await runOne(cmd));
    }
  }

  const fullLogAccumulator = results.map(formatCommandLog).join('');

  // Write log to workspace file
  fs.writeFileSync(rawLogPath, fullLogAccumulator, 'utf8');

  /* Honor an optional caller-supplied line budget. Preserve the default 1:2 start:end split so error traces near the end stay intact. */
  let trimmedLogContent: string;
  if (maxOutputLines && maxOutputLines > 0) {
    const startBudget = Math.max(1, Math.floor(maxOutputLines / 3));
    const endBudget = Math.max(1, maxOutputLines - startBudget);
    trimmedLogContent = trimLog(fullLogAccumulator, startBudget, endBudget);
  } else {
    trimmedLogContent = trimLog(fullLogAccumulator);
  }

  // Return path relative to the workspace path for the client
  const relativeLogPath = path.relative(workspacePath, rawLogPath);

  /* Register the run so its log is addressable by a stable runId via query_log / grep_log. Best-effort: a failed index write must never fail the run itself. */
  try {
    const exitCodes: Record<string, number> = {};
    for (const r of results) {
      exitCodes[r.command] = r.exitCode;
    }
    appendRun(workspacePath, {
      runId: logFileName.replace(/\.log$/, ''),
      commands,
      exitCodes,
      timestamp: new Date().toISOString(),
      rawLogPath: relativeLogPath,
      lineCount: fullLogAccumulator.split('\n').length
    });
  } catch {
    /* ignore registry write failures */
  }

  return {
    results,
    rawLogPath: relativeLogPath,
    rawLogContent: fullLogAccumulator,
    trimmedLogContent
  };
}

/* Prefix every line with its 1-based line number so a model (query_log) can cite exact line ranges back to the caller. */
export function numberLines(content: string): string {
  return content.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
}

/* Return the working-tree diff of a single file against HEAD, or null when the workspace is not a git repo, git is unavailable, or there is no diff (e.g. an untracked or unchanged file). Lets changed-file review send focused hunks instead of whole files. */
export async function getGitDiff(workspacePath: string, file: string): Promise<string | null> {
  const res = await runCommand(`git diff HEAD -- "${file}"`, workspacePath, 30000);
  if (res.exitCode !== 0) {
    return null;
  }
  const diff = res.stdout.trim();
  return diff.length > 0 ? res.stdout : null;
}

export interface CandidateRegion {
  lineRange: string;
  snippet: string;
}

export interface FileCandidate {
  file: string; // relative to workspacePath
  hitCount: number;
  regions: CandidateRegion[];
}

export interface CandidateGatherResult {
  candidates: FileCandidate[];
  filesMatched: number; // total files with at least one hit, before the maxCandidates cap
  totalHits: number;
  searchedWith: 'ripgrep' | 'node-walk';
}

export interface GatherOptions {
  roots?: string[];
  maxCandidates?: number;
  contextLines?: number;
  maxRegionsPerFile?: number;
  maxFileBytes?: number;
}

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.codex-local-test-runs']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|swift|kt|sh|yml|yaml|toml|html|css|scss|sql)$/i;

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/* Merge nearby hit lines into context windows and number each kept line so the local model can cite exact ranges back to the caller. Hit lines are 1-based. */
function buildWindows(lines: string[], hitLines: number[], context: number, maxRegions: number): CandidateRegion[] {
  const sorted = [...new Set(hitLines)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const ln of sorted) {
    const start = Math.max(1, ln - context);
    const end = Math.min(lines.length, ln + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  const regions: CandidateRegion[] = [];
  for (const [start, end] of ranges.slice(0, maxRegions)) {
    const numbered: string[] = [];
    for (let i = start; i <= end; i++) {
      numbered.push(`${i}: ${lines[i - 1]}`);
    }
    regions.push({ lineRange: `${start}-${end}`, snippet: numbered.join('\n') });
  }
  return regions;
}

function regionsForFile(workspacePath: string, relFile: string, hitLines: number[], opts: Required<Pick<GatherOptions, 'contextLines' | 'maxRegionsPerFile' | 'maxFileBytes'>>): CandidateRegion[] {
  const abs = path.resolve(workspacePath, relFile);
  try {
    if (fs.statSync(abs).size > opts.maxFileBytes) {
      return [];
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    return buildWindows(lines, hitLines, opts.contextLines, opts.maxRegionsPerFile);
  } catch {
    return [];
  }
}

/* Run ripgrep for the seed terms and return file -> 1-based hit line numbers. Returns null when ripgrep is unavailable (exit code 127 / spawn error) so the caller can fall back to a Node walk. An empty map (no matches) is a valid non-null result. */
async function ripgrepHits(workspacePath: string, terms: string[], roots: string[], maxFileBytes: number): Promise<Map<string, number[]> | null> {
  const termArgs = terms.map((t) => `-e ${shellEscape(t)}`).join(' ');
  const rootArgs = roots.map(shellEscape).join(' ');
  const ignoreArgs = [...IGNORE_DIRS].map((d) => `-g ${shellEscape(`!${d}`)}`).join(' ');
  const cmd = `rg --line-number --no-heading --color never --fixed-strings --ignore-case --max-filesize ${maxFileBytes} ${ignoreArgs} ${termArgs} -- ${rootArgs}`;
  const res = await runCommand(cmd, workspacePath, 30000);

  /* rg exits 0 with matches, 1 with no matches (both fine); 127 means it is not installed, anything else is a real error. */
  if (res.exitCode === 127 || /not found|ENOENT/i.test(res.error || '')) {
    return null;
  }
  if (res.exitCode !== 0 && res.exitCode !== 1) {
    return null;
  }

  const hits = new Map<string, number[]>();
  for (const line of res.stdout.split('\n')) {
    if (!line) continue;
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first === -1 || second === -1) continue;
    const file = line.slice(0, first);
    const lineNo = parseInt(line.slice(first + 1, second), 10);
    if (!Number.isFinite(lineNo)) continue;
    const arr = hits.get(file) || [];
    arr.push(lineNo);
    hits.set(file, arr);
  }
  return hits;
}

/* Portable fallback when ripgrep is missing: bounded recursive walk that regex-matches the seed terms in text files, skipping the usual heavy directories. */
function nodeWalkHits(workspacePath: string, terms: string[], roots: string[], maxFileBytes: number): Map<string, number[]> {
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(escaped.join('|'), 'i');
  const hits = new Map<string, number[]>();
  let filesScanned = 0;
  const FILE_BUDGET = 5000;

  const walk = (dir: string) => {
    if (filesScanned >= FILE_BUDGET) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesScanned >= FILE_BUDGET) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && TEXT_EXT.test(entry.name)) {
        try {
          if (fs.statSync(full).size > maxFileBytes) continue;
          filesScanned++;
          const lines = fs.readFileSync(full, 'utf8').split('\n');
          const lineNos: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) lineNos.push(i + 1);
          }
          if (lineNos.length > 0) {
            hits.set(path.relative(workspacePath, full), lineNos);
          }
        } catch {
          /* unreadable/binary file: skip */
        }
      }
    }
  };

  for (const root of roots) {
    walk(path.resolve(workspacePath, root));
  }
  return hits;
}

/* Deterministic breadth for the scout flow: find files matching the seed terms, then build numbered context windows around the densest hits. No LLM is involved here; this is the candidate set the local model later ranks. Prefers ripgrep (respects .gitignore, fast) and falls back to a Node walk when rg is absent. */
export async function gatherCandidates(workspacePath: string, terms: string[], options: GatherOptions = {}): Promise<CandidateGatherResult> {
  const roots = options.roots && options.roots.length > 0 ? options.roots : ['.'];
  const maxCandidates = options.maxCandidates && options.maxCandidates > 0 ? options.maxCandidates : 30;
  const resolved = {
    contextLines: options.contextLines && options.contextLines > 0 ? options.contextLines : 4,
    maxRegionsPerFile: options.maxRegionsPerFile && options.maxRegionsPerFile > 0 ? options.maxRegionsPerFile : 4,
    maxFileBytes: options.maxFileBytes && options.maxFileBytes > 0 ? options.maxFileBytes : 500 * 1024
  };

  let searchedWith: 'ripgrep' | 'node-walk' = 'ripgrep';
  let hits = await ripgrepHits(workspacePath, terms, roots, resolved.maxFileBytes);
  if (hits === null) {
    searchedWith = 'node-walk';
    hits = nodeWalkHits(workspacePath, terms, roots, resolved.maxFileBytes);
  }

  let totalHits = 0;
  for (const arr of hits.values()) {
    totalHits += arr.length;
  }
  const filesMatched = hits.size;

  /* Densest files first: the file with the most term hits is the strongest lead. */
  const ranked = [...hits.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, maxCandidates);

  const candidates: FileCandidate[] = [];
  for (const [file, lineNos] of ranked) {
    const regions = regionsForFile(workspacePath, file, lineNos, resolved);
    if (regions.length > 0) {
      candidates.push({ file, hitCount: lineNos.length, regions });
    }
  }

  return { candidates, filesMatched, totalHits, searchedWith };
}
