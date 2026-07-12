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
exports.DEFAULT_LOG_POLICY = exports.LOG_DIR = void 0;
exports.ensureSafeRoot = ensureSafeRoot;
exports.atomicWriteJson = atomicWriteJson;
exports.ensureLogGitignore = ensureLogGitignore;
exports.createRunLog = createRunLog;
exports.pruneLogs = pruneLogs;
exports.purgeLogs = purgeLogs;
exports.getLogStatus = getLogStatus;
exports.finalizeRunLog = finalizeRunLog;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const redaction_1 = require("./redaction");
/* The log store is the single boundary for persisted run output: paths are confined
 * to the managed directory, redaction happens before writes, and lifecycle operations
 * operate only on ordinary run logs so registry and analytics metadata survive pruning. */
exports.LOG_DIR = '.codex-local-test-runs';
exports.DEFAULT_LOG_POLICY = { retentionDays: 7, maxDiskMb: 500, storageMode: 'raw-local' };
const defaultRunLogFs = {
    createWriteStream: fs.createWriteStream,
    rename: fs.promises.rename,
    markRetained: fs.promises.rename,
    unlink: fs.promises.unlink,
    fsync: (fd) => new Promise((resolve, reject) => fs.fsync(fd, (error) => error ? reject(error) : resolve())),
    close: (fd) => new Promise((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve())),
};
function canonicalDir(workspacePath) { return path.resolve(workspacePath, exports.LOG_DIR); }
function relativeToWorkspace(workspacePath, file) { return path.relative(fs.realpathSync(workspacePath), file); }
async function ensureSafeRoot(workspacePath) {
    const root = canonicalDir(workspacePath);
    await fs.promises.mkdir(root, { recursive: true });
    const st = await fs.promises.lstat(root);
    if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error('managed log directory must be a real directory');
    const realWorkspace = await fs.promises.realpath(workspacePath);
    const realRoot = await fs.promises.realpath(root);
    if (!(realRoot === realWorkspace || realRoot.startsWith(`${realWorkspace}${path.sep}`)))
        throw new Error('managed log directory escapes workspace');
    return realRoot;
}
function safePath(workspacePath, candidate) {
    const root = canonicalDir(workspacePath);
    const resolved = path.resolve(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
        throw new Error('log path escapes managed log directory');
    return resolved;
}
async function atomicWriteJson(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try {
        const st = await fs.promises.lstat(filePath);
        if (st.isSymbolicLink() || !st.isFile())
            throw new Error('managed metadata target must be a regular file');
    }
    catch (error) {
        if (error?.code !== 'ENOENT')
            throw error;
    }
    const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.promises.rename(temp, filePath);
}
async function ensureLogGitignore(workspacePath) {
    const file = path.join(workspacePath, '.gitignore');
    let text = '';
    try {
        text = await fs.promises.readFile(file, 'utf8');
    }
    catch { /* absent is fine */ }
    const lines = text.split(/\r?\n/);
    if (lines[lines.length - 1] === '')
        lines.pop();
    if (!lines.includes(`${exports.LOG_DIR}/`))
        lines.push(`${exports.LOG_DIR}/`);
    await fs.promises.writeFile(file, `${lines.join('\n')}\n`);
}
async function createRunLog(workspacePath, options = {}) {
    const dir = await ensureSafeRoot(workspacePath);
    const id = options.runId || `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const absolutePath = path.join(dir, `${id}.log`);
    const temporaryPath = path.join(dir, `.${id}.${process.pid}.${Date.now()}.active.tmp`);
    const retainedPath = path.join(dir, `.${id}.${process.pid}.${Date.now()}.retained.audit.tmp`);
    const leasePath = temporaryPath.replace(/\.active\.tmp$/, '.active.lease.json');
    const io = { ...defaultRunLogFs, ...options.fs };
    const stream = io.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600, autoClose: false });
    try {
        await fs.promises.writeFile(leasePath, JSON.stringify({ pid: options.ownerPid ?? process.pid, runId: id }), { mode: 0o600 });
    }
    catch (error) {
        stream.destroy();
        await defaultRunLogFs.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
    const mode = options.storageMode || exports.DEFAULT_LOG_POLICY.storageMode;
    let carry = '';
    const write = (chunk) => new Promise((resolve, reject) => {
        let value = chunk;
        if (mode === 'redacted-local') {
            const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString() : chunk);
            const cut = Math.max(0, text.length - 128);
            value = (0, redaction_1.redactText)(text.slice(0, cut)).text;
            carry = text.slice(cut);
        }
        stream.write(value, (error) => error ? reject(error) : resolve());
    });
    /* Finalization fsyncs the complete temporary evidence before the atomic rename. A
     * failed rename deliberately retains that temp file so the caller can report it. */
    let closePromise;
    const cleanupActive = async () => {
        let activeError;
        try {
            await io.unlink(temporaryPath);
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                activeError = error;
        }
        await io.unlink(leasePath).catch(() => defaultRunLogFs.unlink(leasePath).catch(() => undefined));
        if (!activeError)
            return { status: 'removed' };
        return { status: 'failed', orphanPath: temporaryPath, error: activeError instanceof Error ? activeError.message : String(activeError) };
    };
    const close = () => closePromise ||= new Promise((resolve, reject) => {
        let settled = false;
        const rejectOnce = (error) => { if (settled)
            return; settled = true; reject(error); };
        const onError = async (error) => {
            const fd = stream.fd;
            if (typeof fd === 'number')
                await defaultRunLogFs.close(fd).catch(() => undefined);
            const cleanup = await cleanupActive();
            rejectOnce(Object.assign(error, { auditStage: 'close', cleanupOutcome: cleanup.status, ...(cleanup.orphanPath ? { orphanPath: cleanup.orphanPath } : {}) }));
        };
        stream.once('error', onError);
        if (mode === 'redacted-local' && carry) {
            stream.write((0, redaction_1.redactText)(carry).text);
            carry = '';
        }
        stream.once('finish', async () => {
            const fd = stream.fd;
            const fail = async (stage, error, remove) => {
                if (typeof fd === 'number' && stage === 'fsync')
                    await io.close(fd).catch(() => defaultRunLogFs.close(fd).catch(() => undefined));
                if (typeof fd === 'number' && stage === 'close')
                    await defaultRunLogFs.close(fd).catch(() => undefined);
                const cleanup = remove ? await cleanupActive() : undefined;
                rejectOnce(Object.assign(error instanceof Error ? error : new Error(String(error)), { auditStage: stage, ...(cleanup ? { cleanupOutcome: cleanup.status, ...(cleanup.orphanPath ? { orphanPath: cleanup.orphanPath } : {}) } : {}) }));
            };
            if (typeof fd !== 'number') {
                await fail('fsync', new Error('audit log file descriptor unavailable'), true);
                return;
            }
            try {
                await io.fsync(fd);
            }
            catch (error) {
                await fail('fsync', error, true);
                return;
            }
            try {
                await io.close(fd);
            }
            catch (error) {
                await fail('close', error, true);
                return;
            }
            try {
                await io.rename(temporaryPath, absolutePath);
            }
            catch (error) {
                try {
                    await io.markRetained(temporaryPath, retainedPath);
                }
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
    const abort = async () => { if (!stream.destroyed)
        stream.destroy(); return cleanupActive(); };
    return { absolutePath, temporaryPath, retainedPath, leasePath, relativePath: path.relative(workspacePath, absolutePath), write, close, abort };
}
const STALE_ACTIVE_MS = 60 * 60 * 1000;
function ownerAlive(leasePath) {
    try {
        const pid = JSON.parse(fs.readFileSync(leasePath, 'utf8')).pid;
        if (!Number.isInteger(pid) || pid <= 0)
            return false;
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function entries(workspacePath) {
    const dir = await ensureSafeRoot(workspacePath);
    let names;
    try {
        names = await fs.promises.readdir(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        const file = path.join(dir, name);
        const st = await fs.promises.lstat(file);
        if (st.isSymbolicLink())
            continue;
        if (name.endsWith('.log') || name.endsWith('.retained.audit.tmp'))
            out.push({ file, bytes: st.size, mtimeMs: st.mtimeMs });
        else if (name.endsWith('.active.tmp') && Date.now() - st.mtimeMs >= STALE_ACTIVE_MS) {
            const leasePath = file.replace(/\.active\.tmp$/, '.active.lease.json');
            if (!ownerAlive(leasePath))
                out.push({ file, bytes: st.size, mtimeMs: st.mtimeMs, leasePath });
        }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
async function pruneLogs(workspacePath, policy = exports.DEFAULT_LOG_POLICY) {
    const retention = policy.retentionDays ?? 7, maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024, now = Date.now();
    const all = await entries(workspacePath);
    const removed = [];
    const keep = [];
    for (const e of all) {
        if ((now - e.mtimeMs) > retention * 86400000) {
            await fs.promises.unlink(e.file);
            if (e.leasePath)
                await fs.promises.unlink(e.leasePath).catch(() => undefined);
            removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'expired' });
        }
        else
            keep.push(e);
    }
    let total = keep.reduce((n, e) => n + e.bytes, 0);
    for (const e of keep) {
        if (total <= maxBytes)
            break;
        await fs.promises.unlink(e.file);
        if (e.leasePath)
            await fs.promises.unlink(e.leasePath).catch(() => undefined);
        total -= e.bytes;
        removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'quota' });
    }
    return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: total, maxBytes, overQuota: total > maxBytes } };
}
async function purgeLogs(workspacePath, options = {}) {
    const dir = await ensureSafeRoot(workspacePath);
    const all = await entries(workspacePath);
    const removed = [];
    for (const e of all) {
        await fs.promises.unlink(e.file);
        if (e.leasePath)
            await fs.promises.unlink(e.leasePath).catch(() => undefined);
        removed.push({ path: relativeToWorkspace(workspacePath, e.file), bytes: e.bytes, reason: 'purged' });
    }
    for (const name of [...(options.includeBaseline ? ['baseline.json'] : []), ...(options.includeAnalytics ? ['analytics.json', 'analytics-summary.json'] : [])]) {
        const file = path.join(dir, name);
        try {
            const st = await fs.promises.lstat(file);
            if (st.isSymbolicLink())
                continue;
            await fs.promises.unlink(file);
            removed.push({ path: path.relative(workspacePath, file), bytes: st.size, reason: 'purged' });
        }
        catch { /* absent */ }
    }
    const maxBytes = (exports.DEFAULT_LOG_POLICY.maxDiskMb || 500) * 1024 * 1024;
    return { removed, freedBytes: removed.reduce((n, e) => n + e.bytes, 0), warnings: [], quota: { bytes: 0, maxBytes, overQuota: false } };
}
async function getLogStatus(workspacePath, policy = exports.DEFAULT_LOG_POLICY) { const es = await entries(workspacePath); const maxBytes = (policy.maxDiskMb ?? 500) * 1024 * 1024; const bytes = es.reduce((n, e) => n + e.bytes, 0); return { removed: [], freedBytes: 0, warnings: [], quota: { bytes, maxBytes, overQuota: bytes > maxBytes } }; }
async function finalizeRunLog(log) { await log.close(); }
