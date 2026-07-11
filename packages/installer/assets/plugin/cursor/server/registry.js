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
exports.appendRun = appendRun;
exports.loadRun = loadRun;
exports.resolveLogPath = resolveLogPath;
exports.grepLog = grepLog;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const LOG_DIR = '.codex-local-test-runs';
const INDEX_FILE = 'index.json';
const MAX_RECORDS = 200;
function indexPath(workspacePath) {
    return path.join(workspacePath, LOG_DIR, INDEX_FILE);
}
function writeIndexAtomic(file, records) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(records, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
}
function readRecords(workspacePath) {
    const file = indexPath(workspacePath);
    if (!fs.existsSync(file)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        /* Corrupt index: treat as empty rather than throwing. The next write repairs it. */
        return [];
    }
}
/* Append a run to the per-workspace index so every stored log gets a stable, resolvable runId handle. Best-effort: callers must not let an index failure break the underlying run. */
function appendRun(workspacePath, record) {
    const lock = `${indexPath(workspacePath)}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            fs.mkdirSync(lock);
            break;
        }
        catch {
            Atomics.wait(wait, 0, 0, 5);
        }
    }
    try {
        const records = readRecords(workspacePath);
        records.push(record);
        const trimmed = records.length > MAX_RECORDS ? records.slice(records.length - MAX_RECORDS) : records;
        writeIndexAtomic(indexPath(workspacePath), trimmed);
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
function loadRun(workspacePath, runId) {
    const records = readRecords(workspacePath);
    for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].runId === runId) {
            return records[i];
        }
    }
    return null;
}
/* Resolve an absolute log path from either an explicit logPath (absolute or workspace-relative) or a runId looked up in the index. Returns null when neither resolves. */
function resolveLogPath(workspacePath, opts) {
    try {
        const root = path.resolve(workspacePath, LOG_DIR);
        if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink())
            return null;
    }
    catch {
        return null;
    }
    if (opts.logPath) {
        const candidate = path.isAbsolute(opts.logPath) ? path.resolve(opts.logPath) : path.resolve(workspacePath, opts.logPath);
        const root = path.resolve(workspacePath, LOG_DIR);
        if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`))
            return null;
        try {
            const real = fs.realpathSync(candidate);
            const canonicalRoot = fs.realpathSync(root);
            return real === canonicalRoot || real.startsWith(`${canonicalRoot}${path.sep}`) ? real : null;
        }
        catch {
            return null;
        }
    }
    if (opts.runId) {
        const rec = loadRun(workspacePath, opts.runId);
        if (rec) {
            const candidate = path.resolve(workspacePath, rec.rawLogPath);
            const root = path.resolve(workspacePath, LOG_DIR);
            try {
                const real = fs.realpathSync(candidate);
                const canonicalRoot = fs.realpathSync(root);
                return real === canonicalRoot || real.startsWith(`${canonicalRoot}${path.sep}`) ? real : null;
            }
            catch {
                return null;
            }
        }
    }
    return null;
}
/* Deterministic, no-LLM search over a stored log. Returns matching line windows (match line +/- context) so the caller gets exact lines without spending a model call or reading the whole file. */
function grepLog(absLogPath, pattern, context = 3, maxMatches = 20) {
    const lines = fs.readFileSync(absLogPath, 'utf8').split('\n');
    let re;
    try {
        re = new RegExp(pattern, 'i');
    }
    catch (e) {
        throw new Error(`Invalid regex pattern: ${e.message || e}`);
    }
    const matchIdx = [];
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
            matchIdx.push(i);
        }
    }
    const matches = [];
    for (const idx of matchIdx.slice(0, maxMatches)) {
        const start = Math.max(0, idx - context);
        const end = Math.min(lines.length - 1, idx + context);
        const excerpt = [];
        for (let j = start; j <= end; j++) {
            excerpt.push(`${j + 1}: ${lines[j]}`);
        }
        matches.push({ lineRange: `${start + 1}-${end + 1}`, excerpt: excerpt.join('\n') });
    }
    return { matches, totalMatches: matchIdx.length };
}
