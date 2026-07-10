import * as fs from 'fs';
import * as path from 'path';

export interface RunRecord {
  runId: string;
  commands: string[];
  exitCodes: Record<string, number>;
  timestamp: string;
  rawLogPath: string; // relative to workspacePath
  lineCount: number;
}

const LOG_DIR = '.codex-local-test-runs';
const INDEX_FILE = 'index.json';
const MAX_RECORDS = 200;

function indexPath(workspacePath: string): string {
  return path.join(workspacePath, LOG_DIR, INDEX_FILE);
}

function writeIndexAtomic(file: string, records: RunRecord[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function readRecords(workspacePath: string): RunRecord[] {
  const file = indexPath(workspacePath);
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as RunRecord[]) : [];
  } catch {
    /* Corrupt index: treat as empty rather than throwing. The next write repairs it. */
    return [];
  }
}

/* Append a run to the per-workspace index so every stored log gets a stable, resolvable runId handle. Best-effort: callers must not let an index failure break the underlying run. */
export function appendRun(workspacePath: string, record: RunRecord): void {
  const records = readRecords(workspacePath);
  records.push(record);
  const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
  writeIndexAtomic(indexPath(workspacePath), trimmed);
}

export function loadRun(workspacePath: string, runId: string): RunRecord | null {
  const records = readRecords(workspacePath);
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].runId === runId) {
      return records[i];
    }
  }
  return null;
}

/* Resolve an absolute log path from either an explicit logPath (absolute or workspace-relative) or a runId looked up in the index. Returns null when neither resolves. */
export function resolveLogPath(workspacePath: string, opts: { runId?: string; logPath?: string }): string | null {
  try { const root = path.resolve(workspacePath, LOG_DIR); if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) return null; } catch { return null; }
  if (opts.logPath) {
    const candidate = path.isAbsolute(opts.logPath) ? path.resolve(opts.logPath) : path.resolve(workspacePath, opts.logPath);
    const root = path.resolve(workspacePath, LOG_DIR);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
    return candidate;
  }
  if (opts.runId) {
    const rec = loadRun(workspacePath, opts.runId);
    if (rec) {
      const candidate = path.resolve(workspacePath, rec.rawLogPath);
      const root = path.resolve(workspacePath, LOG_DIR);
      return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
    }
  }
  return null;
}

export interface GrepMatch {
  lineRange: string;
  excerpt: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
}

/* Deterministic, no-LLM search over a stored log. Returns matching line windows (match line +/- context) so the caller gets exact lines without spending a model call or reading the whole file. */
export function grepLog(absLogPath: string, pattern: string, context = 3, maxMatches = 20): GrepResult {
  const lines = fs.readFileSync(absLogPath, 'utf8').split('\n');

  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e: any) {
    throw new Error(`Invalid regex pattern: ${e.message || e}`);
  }

  const matchIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      matchIdx.push(i);
    }
  }

  const matches: GrepMatch[] = [];
  for (const idx of matchIdx.slice(0, maxMatches)) {
    const start = Math.max(0, idx - context);
    const end = Math.min(lines.length - 1, idx + context);
    const excerpt: string[] = [];
    for (let j = start; j <= end; j++) {
      excerpt.push(`${j + 1}: ${lines[j]}`);
    }
    matches.push({ lineRange: `${start + 1}-${end + 1}`, excerpt: excerpt.join('\n') });
  }

  return { matches, totalMatches: matchIdx.length };
}
