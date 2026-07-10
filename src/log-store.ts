import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactText } from './redaction';

/* The log store is the single boundary for persisted run output: paths are confined
 * to the managed directory, redaction happens before writes, and lifecycle operations
 * operate only on ordinary run logs so registry and analytics metadata survive pruning. */
export const LOG_DIR = '.codex-local-test-runs';
export const DEFAULT_LOG_POLICY: LogPolicy = { retentionDays: 7, maxDiskMb: 500, storageMode: 'raw-local' };
export interface LogPolicy { retentionDays?: number; maxDiskMb?: number; storageMode?: 'raw-local' | 'redacted-local' }
export interface RemovedLog { path: string; bytes: number; reason: 'expired' | 'quota' | 'purged' }
export interface LogLifecycleResult { removed: RemovedLog[]; freedBytes: number; warnings: string[]; quota: { bytes: number; maxBytes: number; overQuota: boolean } }
export interface RunLog { absolutePath: string; relativePath: string; write(chunk: string | Buffer): Promise<void>; close(): Promise<void> }

function canonicalDir(workspacePath: string): string { return path.resolve(workspacePath, LOG_DIR); }
async function ensureSafeRoot(workspacePath: string): Promise<string> {
  const root = canonicalDir(workspacePath);
  await fs.promises.mkdir(root, { recursive: true });
  const st = await fs.promises.lstat(root);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('managed log directory must be a real directory');
  const realWorkspace = await fs.promises.realpath(workspacePath);
  const realRoot = await fs.promises.realpath(root);
  if (!(realRoot === realWorkspace || realRoot.startsWith(`${realWorkspace}${path.sep}`))) throw new Error('managed log directory escapes workspace');
  return realRoot;
}
function safePath(workspacePath: string, candidate: string): string {
  const root = canonicalDir(workspacePath); const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('log path escapes managed log directory');
  return resolved;
}
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.promises.rename(temp, filePath);
}
export async function ensureLogGitignore(workspacePath: string): Promise<void> {
  const file = path.join(workspacePath, '.gitignore');
  let text = ''; try { text = await fs.promises.readFile(file, 'utf8'); } catch { /* absent is fine */ }
  const lines = text.split(/\r?\n/); if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.includes(`${LOG_DIR}/`)) lines.push(`${LOG_DIR}/`);
  await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
}
export async function createRunLog(workspacePath: string, options: { storageMode?: 'raw-local' | 'redacted-local'; runId?: string } = {}): Promise<RunLog> {
  const dir = await ensureSafeRoot(workspacePath);
  const id = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const absolutePath = path.join(dir, `${id}.log`);
  const stream = fs.createWriteStream(absolutePath, { flags: 'w', mode: 0o600 });
  const mode = options.storageMode || DEFAULT_LOG_POLICY.storageMode; let carry = '';
  const write = (chunk: string | Buffer) => new Promise<void>((resolve, reject) => {
    let value: string | Buffer = chunk;
    if (mode === 'redacted-local') { const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString() : chunk); const cut = Math.max(0, text.length - 128); value = redactText(text.slice(0, cut)).text; carry = text.slice(cut); }
    if (!stream.write(value)) stream.once('drain', resolve); else resolve();
    stream.once('error', reject);
  });
  const close = () => new Promise<void>((resolve, reject) => { stream.once('error', reject); if (mode === 'redacted-local' && carry) { stream.write(redactText(carry).text); carry = ''; } stream.end(resolve); });
  return { absolutePath, relativePath: path.relative(workspacePath, absolutePath), write, close };
}
interface Entry { file: string; bytes: number; mtimeMs: number }
async function entries(workspacePath: string): Promise<Entry[]> {
  const dir = await ensureSafeRoot(workspacePath); let names: string[]; try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out: Entry[] = []; for (const name of names) { if (!name.endsWith('.log')) continue; const file = path.join(dir, name); const st = await fs.promises.lstat(file); if (st.isSymbolicLink()) continue; out.push({ file, bytes: st.size, mtimeMs: st.mtimeMs }); }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
export async function pruneLogs(workspacePath: string, policy: LogPolicy = DEFAULT_LOG_POLICY): Promise<LogLifecycleResult> {
  const retention = policy.retentionDays ?? 7, maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024, now = Date.now();
  const all = await entries(workspacePath); const removed: RemovedLog[] = []; const keep: Entry[] = [];
  for (const e of all) { if ((now - e.mtimeMs) > retention * 86400000) { await fs.promises.unlink(e.file); removed.push({ path: path.relative(workspacePath, e.file), bytes: e.bytes, reason: 'expired' }); } else keep.push(e); }
  let total = keep.reduce((n, e) => n + e.bytes, 0); for (const e of keep) { if (total <= maxBytes) break; await fs.promises.unlink(e.file); total -= e.bytes; removed.push({ path: path.relative(workspacePath, e.file), bytes: e.bytes, reason: 'quota' }); }
  return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: total, maxBytes, overQuota: total > maxBytes } };
}
export async function purgeLogs(workspacePath: string, options: { includeBaseline?: boolean; includeAnalytics?: boolean } = {}): Promise<LogLifecycleResult> {
  const dir = await ensureSafeRoot(workspacePath); const all = await entries(workspacePath); const removed: RemovedLog[] = [];
  for (const e of all) { await fs.promises.unlink(e.file); removed.push({ path: path.relative(workspacePath, e.file), bytes: e.bytes, reason: 'purged' }); }
  for (const name of [...(options.includeBaseline ? ['baseline.json'] : []), ...(options.includeAnalytics ? ['analytics.json', 'analytics-summary.json'] : [])]) { const file = path.join(dir, name); try { const st = await fs.promises.lstat(file); if (st.isSymbolicLink()) continue; await fs.promises.unlink(file); removed.push({ path: path.relative(workspacePath, file), bytes: st.size, reason: 'purged' }); } catch { /* absent */ } }
  const maxBytes = (DEFAULT_LOG_POLICY.maxDiskMb || 500) * 1024 * 1024; return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: 0, maxBytes, overQuota: false } };
}
export async function getLogStatus(workspacePath: string, policy: LogPolicy = DEFAULT_LOG_POLICY): Promise<LogLifecycleResult> { const es = await entries(workspacePath); const maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024; const bytes = es.reduce((n, e) => n + e.bytes, 0); return { removed: [], freedBytes: 0, warnings: [], quota: { bytes, maxBytes, overQuota: bytes > maxBytes } }; }
export async function finalizeRunLog(log: RunLog): Promise<void> { await log.close(); }
