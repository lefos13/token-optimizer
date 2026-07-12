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
export interface CleanupResult { status: 'removed' | 'failed'; orphanPath?: string; error?: string }
export interface RunLog { absolutePath: string; temporaryPath: string; retainedPath: string; leasePath: string; relativePath: string; write(chunk: string | Buffer): Promise<void>; close(): Promise<void>; abort(): Promise<CleanupResult> }
export interface RunLogFs {
  createWriteStream: typeof fs.createWriteStream;
  rename(from: string, to: string): Promise<void>;
  markRetained(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  fsync(fd: number): Promise<void>;
  close(fd: number): Promise<void>;
}
export type AuditFinalizeStage = 'fsync' | 'close' | 'rename';

const defaultRunLogFs: RunLogFs = {
  createWriteStream: fs.createWriteStream,
  rename: fs.promises.rename,
  markRetained: fs.promises.rename,
  unlink: fs.promises.unlink,
  fsync: (fd) => new Promise<void>((resolve, reject) => fs.fsync(fd, (error) => error ? reject(error) : resolve())),
  close: (fd) => new Promise<void>((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve())),
};

function canonicalDir(workspacePath: string): string { return path.resolve(workspacePath, LOG_DIR); }
function relativeToWorkspace(workspacePath: string, file: string): string { return path.relative(fs.realpathSync(workspacePath), file); }
export async function ensureSafeRoot(workspacePath: string): Promise<string> {
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
  try { const st = await fs.promises.lstat(filePath); if (st.isSymbolicLink() || !st.isFile()) throw new Error('managed metadata target must be a regular file'); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
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
export async function createRunLog(workspacePath: string, options: { storageMode?: 'raw-local' | 'redacted-local'; runId?: string; ownerPid?: number; fs?: Partial<RunLogFs> } = {}): Promise<RunLog> {
  const dir = await ensureSafeRoot(workspacePath);
  const id = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const absolutePath = path.join(dir, `${id}.log`);
  const temporaryPath = path.join(dir, `.${id}.${process.pid}.${Date.now()}.active.tmp`);
  const retainedPath = path.join(dir, `.${id}.${process.pid}.${Date.now()}.retained.audit.tmp`);
  const leasePath = temporaryPath.replace(/\.active\.tmp$/, '.active.lease.json');
  const io = { ...defaultRunLogFs, ...options.fs };
  const stream = io.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600, autoClose: false });
  try { await fs.promises.writeFile(leasePath, JSON.stringify({ pid: options.ownerPid ?? process.pid, runId: id }), { mode: 0o600 }); }
  catch (error) { stream.destroy(); await defaultRunLogFs.unlink(temporaryPath).catch(() => undefined); throw error; }
  const mode = options.storageMode || DEFAULT_LOG_POLICY.storageMode; let carry = '';
  const write = (chunk: string | Buffer) => new Promise<void>((resolve, reject) => {
    let value: string | Buffer = chunk;
    if (mode === 'redacted-local') { const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString() : chunk); const cut = Math.max(0, text.length - 128); value = redactText(text.slice(0, cut)).text; carry = text.slice(cut); }
    stream.write(value, (error) => error ? reject(error) : resolve());
  });
  /* Finalization fsyncs the complete temporary evidence before the atomic rename. A
   * failed rename deliberately retains that temp file so the caller can report it. */
  let closePromise: Promise<void> | undefined;
  const cleanupActive = async (): Promise<CleanupResult> => {
    let activeError: unknown;
    try { await io.unlink(temporaryPath); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') activeError = error; }
    await io.unlink(leasePath).catch(() => defaultRunLogFs.unlink(leasePath).catch(() => undefined));
    if (!activeError) return { status: 'removed' };
    return { status: 'failed', orphanPath: temporaryPath, error: activeError instanceof Error ? activeError.message : String(activeError) };
  };
  const close = () => closePromise ||= new Promise<void>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error) => { if (settled) return; settled = true; reject(error); };
    const onError = async (error: Error) => {
      const fd = (stream as fs.WriteStream & { fd?: number }).fd;
      if (typeof fd === 'number') await defaultRunLogFs.close(fd).catch(() => undefined);
      const cleanup = await cleanupActive();
      rejectOnce(Object.assign(error, { auditStage: 'close', cleanupOutcome: cleanup.status, ...(cleanup.orphanPath ? { orphanPath: cleanup.orphanPath } : {}) }));
    };
    stream.once('error', onError);
    if (mode === 'redacted-local' && carry) { stream.write(redactText(carry).text); carry = ''; }
    stream.once('finish', async () => {
      const fd = (stream as fs.WriteStream & { fd?: number }).fd;
      const fail = async (stage: AuditFinalizeStage, error: unknown, remove: boolean) => {
        if (typeof fd === 'number' && stage === 'fsync') await io.close(fd).catch(() => defaultRunLogFs.close(fd).catch(() => undefined));
        if (typeof fd === 'number' && stage === 'close') await defaultRunLogFs.close(fd).catch(() => undefined);
        const cleanup = remove ? await cleanupActive() : undefined;
        rejectOnce(Object.assign(error instanceof Error ? error : new Error(String(error)), { auditStage: stage, ...(cleanup ? { cleanupOutcome: cleanup.status, ...(cleanup.orphanPath ? { orphanPath: cleanup.orphanPath } : {}) } : {}) }));
      };
      if (typeof fd !== 'number') { await fail('fsync', new Error('audit log file descriptor unavailable'), true); return; }
      try { await io.fsync(fd); } catch (error) { await fail('fsync', error, true); return; }
      try { await io.close(fd); } catch (error) { await fail('close', error, true); return; }
      try { await io.rename(temporaryPath, absolutePath); }
      catch (error) {
        try { await io.markRetained(temporaryPath, retainedPath); }
        catch {
          const cleanup = await cleanupActive();
          rejectOnce(Object.assign(error instanceof Error ? error : new Error(String(error)), { auditStage: 'rename', retentionFailed: true, cleanupOutcome: cleanup.status, ...(cleanup.orphanPath ? { orphanPath: cleanup.orphanPath } : {}) }));
          return;
        }
        await io.unlink(leasePath).catch(() => undefined);
        rejectOnce(Object.assign(error instanceof Error ? error : new Error(String(error)), { auditStage: 'rename', retainedPath }));
        return;
      }
      stream.removeListener('error', onError);
      await io.unlink(leasePath).catch(() => undefined);
      settled = true;
      resolve();
    });
    stream.end();
  });
  const abort = async () => { if (!stream.destroyed) stream.destroy(); return cleanupActive(); };
  return { absolutePath, temporaryPath, retainedPath, leasePath, relativePath: path.relative(workspacePath, absolutePath), write, close, abort };
}
interface Entry { file: string; bytes: number; mtimeMs: number; leasePath?: string }
const STALE_ACTIVE_MS = 60 * 60 * 1000;
function ownerAlive(leasePath: string): boolean {
  try {
    const pid = JSON.parse(fs.readFileSync(leasePath, 'utf8')).pid;
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0); return true;
  } catch { return false; }
}
async function entries(workspacePath: string): Promise<Entry[]> {
  const dir = await ensureSafeRoot(workspacePath); let names: string[]; try { names = await fs.promises.readdir(dir); } catch { return []; }
  const out: Entry[] = []; for (const name of names) {
    const file = path.join(dir, name); const st = await fs.promises.lstat(file); if (st.isSymbolicLink()) continue;
    if (name.endsWith('.log') || name.endsWith('.retained.audit.tmp')) out.push({ file, bytes: st.size, mtimeMs: st.mtimeMs });
    else if (name.endsWith('.active.tmp') && Date.now() - st.mtimeMs >= STALE_ACTIVE_MS) {
      const leasePath = file.replace(/\.active\.tmp$/, '.active.lease.json');
      if (!ownerAlive(leasePath)) out.push({ file, bytes: st.size, mtimeMs: st.mtimeMs, leasePath });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
export async function pruneLogs(workspacePath: string, policy: LogPolicy = DEFAULT_LOG_POLICY): Promise<LogLifecycleResult> {
  const retention = policy.retentionDays ?? 7, maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024, now = Date.now();
  const all = await entries(workspacePath); const removed: RemovedLog[] = []; const keep: Entry[] = [];
  for (const e of all) { if ((now - e.mtimeMs) > retention * 86400000) { await fs.promises.unlink(e.file); if (e.leasePath) await fs.promises.unlink(e.leasePath).catch(() => undefined); removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'expired' }); } else keep.push(e); }
  let total = keep.reduce((n, e) => n + e.bytes, 0); for (const e of keep) { if (total <= maxBytes) break; await fs.promises.unlink(e.file); if (e.leasePath) await fs.promises.unlink(e.leasePath).catch(() => undefined); total -= e.bytes; removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'quota' }); }
  return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: total, maxBytes, overQuota: total > maxBytes } };
}
export async function purgeLogs(workspacePath: string, options: { includeBaseline?: boolean; includeAnalytics?: boolean } = {}): Promise<LogLifecycleResult> {
  const dir = await ensureSafeRoot(workspacePath); const all = await entries(workspacePath); const removed: RemovedLog[] = [];
  for (const e of all) { await fs.promises.unlink(e.file); if (e.leasePath) await fs.promises.unlink(e.leasePath).catch(() => undefined); removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'purged' }); }
  for (const name of [...(options.includeBaseline ? ['baseline.json'] : []), ...(options.includeAnalytics ? ['analytics.json', 'analytics-summary.json'] : [])]) { const file = path.join(dir, name); try { const st = await fs.promises.lstat(file); if (st.isSymbolicLink()) continue; await fs.promises.unlink(file); removed.push({ path: path.relative(workspacePath, file), bytes: st.size, reason: 'purged' }); } catch { /* absent */ } }
  const maxBytes = (DEFAULT_LOG_POLICY.maxDiskMb || 500) * 1024 * 1024; return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: 0, maxBytes, overQuota: false } };
}
export async function getLogStatus(workspacePath: string, policy: LogPolicy = DEFAULT_LOG_POLICY): Promise<LogLifecycleResult> { const es = await entries(workspacePath); const maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024; const bytes = es.reduce((n, e) => n + e.bytes, 0); return { removed: [], freedBytes: 0, warnings: [], quota: { bytes, maxBytes, overQuota: bytes > maxBytes } }; }
export async function finalizeRunLog(log: RunLog): Promise<void> { await log.close(); }
