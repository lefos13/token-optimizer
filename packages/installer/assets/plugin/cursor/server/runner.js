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
exports.runCommand = runCommand;
exports.trimLog = trimLog;
exports.estimateTokens = estimateTokens;
exports.appendFileStream = appendFileStream;
exports.runSuite = runSuite;
exports.numberLines = numberLines;
exports.getGitDiff = getGitDiff;
exports.gatherCandidates = gatherCandidates;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const registry_1 = require("./registry");
const command_policy_1 = require("./command-policy");
const process_tree_1 = require("./process-tree");
const log_store_1 = require("./log-store");
const redaction_1 = require("./redaction");
const log_excerpt_1 = require("./log-excerpt");
/**
 * Runs a single shell command inside the workspacePath, capturing all stdout and stderr.
 */
function runCommand(command, workspacePath, timeoutMs = 300000, execution, logFilePath, storageMode = 'raw-local', commandLogFs = { createWriteStream: fs.createWriteStream }) {
    const startTime = Date.now();
    return new Promise(async (resolve) => {
        let settled = false;
        let timingOut = false;
        let timeout;
        if (logFilePath) {
            try {
                await (0, log_store_1.ensureSafeRoot)(workspacePath);
            }
            catch (error) {
                resolve({ command, exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startTime, error: 'Unsafe log directory', executionStatus: 'spawn_failed' });
                return;
            }
        }
        const autoDetected = Boolean(execution?.autoDetectedCommands?.includes(command));
        if (command.includes('__token_optimizer_spawn_failed__')) {
            resolve({ command, exitCode: -1, stdout: '', stderr: 'Unable to spawn command.', durationMs: Date.now() - startTime, error: 'Spawn failed', policyReasonCode: 'SPAWN_FAILED', autoDetected, signal: null, executionStatus: 'spawn_failed' });
            return;
        }
        const policy = await (0, command_policy_1.evaluateCommand)({
            command,
            workspacePath,
            profile: execution?.profile || 'unrestricted',
            allowedCommandPrefixes: execution?.allowedCommandPrefixes,
            autoDetectedCommands: execution?.autoDetectedCommands,
        });
        if (!policy.allowed) {
            resolve({ command, exitCode: -1, stdout: '', stderr: policy.message, durationMs: Date.now() - startTime, error: 'Command rejected by execution policy', policyReasonCode: policy.reasonCode, autoDetected, executionStatus: 'blocked', rawSourceBytes: Buffer.byteLength(policy.message) });
            return;
        }
        const child = (0, child_process_1.spawn)(command, { cwd: workspacePath, shell: true, detached: process.platform !== 'win32' });
        const outCollector = new log_excerpt_1.LogExcerptCollector();
        const errCollector = new log_excerpt_1.LogExcerptCollector();
        const interleavedCollector = new log_excerpt_1.LogExcerptCollector();
        let outBytes = 0, errBytes = 0;
        let fileStream;
        let fileCarry = '';
        let fileFailure;
        try {
            if (logFilePath) {
                fileStream = commandLogFs.createWriteStream(logFilePath, { flags: 'w', mode: 0o600 });
                fileStream.on('error', (error) => { fileFailure ||= error; });
            }
        }
        catch (error) {
            fileFailure = error;
        }
        const collect = (chunk, stream) => {
            const bytes = chunk.byteLength;
            if (stream === 'stdout')
                outBytes += bytes;
            else
                errBytes += bytes;
            if (fileStream && !fileFailure)
                fileStream.write(`[${stream}] `);
            if (fileStream && !fileFailure) {
                if (storageMode === 'redacted-local') {
                    const text = fileCarry + chunk.toString();
                    const cut = Math.max(0, text.length - 128);
                    fileStream.write((0, redaction_1.redactText)(text.slice(0, cut)).text);
                    fileCarry = text.slice(cut);
                }
                else
                    fileStream.write(chunk);
            }
            (stream === 'stdout' ? outCollector : errCollector).push(stream, chunk);
            interleavedCollector.push(stream, chunk);
        };
        child.stdout?.on('data', (c) => collect(c, 'stdout'));
        child.stderr?.on('data', (c) => collect(c, 'stderr'));
        const closeFile = async () => {
            const stream = fileStream;
            fileStream = undefined;
            if (!stream)
                return;
            if (storageMode === 'redacted-local' && fileCarry && !fileFailure)
                stream.write((0, redaction_1.redactText)(fileCarry).text);
            fileCarry = '';
            await new Promise((resolve) => {
                if (stream.destroyed) {
                    resolve();
                    return;
                }
                const done = () => { stream.removeListener('finish', done); stream.removeListener('close', done); resolve(); };
                stream.once('finish', done);
                stream.once('close', done);
                stream.end();
            });
        };
        const finish = async (result) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            await closeFile();
            if (fileFailure)
                result.commandLogFailure = { ...(fileFailure.code ? { code: fileFailure.code } : {}), message: fileFailure.message };
            result.stdout = result.stdout || outCollector.finish().text;
            result.stderr = result.stderr || errCollector.finish().text;
            result.interleaved = interleavedCollector.finish().text;
            result.rawSourceBytes = outBytes + errBytes;
            result.rawSourceTokens = Math.ceil((result.rawSourceBytes || 0) / 4);
            resolve(result);
        };
        child.once('error', (error) => finish({ command, exitCode: -1, stdout: '', stderr: error.message, durationMs: Date.now() - startTime, error: error.message, autoDetected, signal: null, policyReasonCode: 'SPAWN_FAILED', executionStatus: 'spawn_failed' }));
        child.once('close', (code, signal) => {
            if (timingOut)
                return;
            finish({ command, exitCode: code ?? (signal ? -1 : 1), stdout: '', stderr: '', durationMs: Date.now() - startTime, error: signal ? `Process terminated by ${signal}` : undefined, autoDetected, signal, executionStatus: signal ? 'terminated' : 'completed' });
        });
        // Handle timeout
        timeout = setTimeout(async () => {
            if (settled)
                return;
            timingOut = true;
            const termination = await (0, process_tree_1.terminateProcessTree)(child, process.platform, 250);
            finish({
                command,
                exitCode: -1,
                stdout: '',
                stderr: `Command timed out after ${timeoutMs / 1000}s.`,
                durationMs: Date.now() - startTime,
                error: 'Timeout',
                termination,
                autoDetected,
                signal: null,
                executionStatus: 'timed_out'
            });
        }, timeoutMs);
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
function trimLog(fullLog, maxStartLines = 100, maxEndLines = 200) {
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
    const ranges = [[0, headEnd]];
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
    const merged = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) {
            last[1] = Math.max(last[1], r[1]);
        }
        else {
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
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
function formatCommandLog(res) {
    let block = `========================================================\n`;
    block += `COMMAND: ${res.command}\n`;
    block += `========================================================\n\n`;
    block += `${res.interleaved || `--- STDOUT ---\n${res.stdout}\n${res.stderr ? `--- STDERR ---\n${res.stderr}\n` : ''}`}`;
    block += `\n--- EXIT CODE: ${res.exitCode} (Duration: ${res.durationMs}ms) ---\n\n`;
    return block;
}
async function appendFileStream(write, sourcePath, createReadStream = fs.createReadStream) {
    await new Promise((resolve, reject) => {
        const source = createReadStream(sourcePath);
        let settled = false;
        const cleanup = () => { source.removeListener('error', fail); source.removeListener('end', done); source.removeListener('data', onData); };
        const done = () => { if (settled)
            return; settled = true; cleanup(); resolve(); };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            const rejectClosed = () => reject(error);
            if (source.closed)
                rejectClosed();
            else {
                source.once('close', rejectClosed);
                source.destroy();
            }
        };
        const onData = (chunk) => {
            source.pause();
            write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(() => { if (!settled)
                source.resume(); }, fail);
        };
        source.on('error', fail);
        source.on('data', onData);
        source.on('end', done);
    });
}
/**
 * Runs multiple commands (sequentially by default, or concurrently when `parallel` is set). Creates a log
 * directory and saves the full logs, returning both full and trimmed representations. Log blocks are always
 * emitted in command order regardless of execution mode.
 */
async function runSuite(commands, workspacePath, options = {}) {
    const { maxOutputLines, timeoutMs, parallel, execution, storageMode = 'raw-local', retentionDays, maxDiskMb, logFs, commandLogFs } = options;
    const logDir = await (0, log_store_1.ensureSafeRoot)(workspacePath);
    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFileName = `${timestamp}.log`;
    const rawLogPath = path.join(logDir, logFileName);
    const tempDir = path.join(logDir, `.stream-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const runOne = (cmd, index) => timeoutMs ? runCommand(cmd, workspacePath, timeoutMs, execution, path.join(tempDir, `${index}.out`), storageMode, commandLogFs) : runCommand(cmd, workspacePath, 300000, execution, path.join(tempDir, `${index}.out`), storageMode, commandLogFs);
    let results;
    try {
        if (parallel) {
            results = await Promise.all(commands.map(runOne));
        }
        else {
            results = [];
            for (const cmd of commands) {
                results.push(await runOne(cmd, results.length));
            }
        }
    }
    catch (error) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw error;
    }
    const warnings = [];
    await (0, log_store_1.ensureLogGitignore)(workspacePath).catch((error) => warnings.push(`log gitignore update failed: ${error instanceof Error ? error.message : String(error)}`));
    let managedLog;
    let auditStatus = 'persisted';
    let auditFailure;
    let auditStage = 'create';
    try {
        const commandLogFailure = results.find((result) => result.commandLogFailure)?.commandLogFailure;
        if (commandLogFailure) {
            auditStage = 'write';
            throw Object.assign(new Error(`command output persistence failed: ${commandLogFailure.message}`), { code: commandLogFailure.code });
        }
        managedLog = await (0, log_store_1.createRunLog)(workspacePath, { runId: logFileName.replace(/\.log$/, ''), storageMode, fs: logFs });
        auditStage = 'write';
        for (let i = 0; i < results.length; i++) {
            const header = `========================================================\nCOMMAND: ${results[i].command}\n========================================================\n\n`;
            await managedLog.write(header);
            const commandOutputPath = path.join(tempDir, `${i}.out`);
            if (fs.existsSync(commandOutputPath))
                await appendFileStream((chunk) => managedLog.write(chunk), commandOutputPath);
            await managedLog.write(`\n--- EXIT CODE: ${results[i].exitCode} (Duration: ${results[i].durationMs}ms) ---\n\n`);
        }
        auditStage = 'fsync';
        await managedLog.close();
    }
    catch (error) {
        auditStatus = 'failed';
        const failureStage = typeof error === 'object' && error && 'auditStage' in error ? error.auditStage : auditStage;
        const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : undefined;
        const retainedPath = typeof error === 'object' && error && 'retainedPath' in error ? String(error.retainedPath) : undefined;
        let evidenceExists = Boolean(retainedPath && fs.existsSync(retainedPath));
        let tempCleanup = evidenceExists ? 'retained' : 'none';
        if (failureStage === 'write' && managedLog) {
            const cleanup = await managedLog.abort();
            tempCleanup = cleanup.status;
        }
        if ((failureStage === 'fsync' || failureStage === 'close') && !evidenceExists)
            tempCleanup = 'removed';
        if (typeof error === 'object' && error && 'cleanupOutcome' in error)
            tempCleanup = error.cleanupOutcome;
        const orphanPath = typeof error === 'object' && error && 'orphanPath' in error ? String(error.orphanPath) : undefined;
        auditFailure = {
            stage: failureStage,
            ...(code ? { code } : {}), message: error instanceof Error ? error.message : String(error),
            ...(evidenceExists ? { evidencePath: path.relative(workspacePath, retainedPath) } : {}),
            ...(orphanPath && path.resolve(orphanPath).startsWith(fs.realpathSync(path.resolve(workspacePath, '.codex-local-test-runs')) + path.sep) ? { orphanPath: path.relative(fs.realpathSync(workspacePath), orphanPath) } : {}),
            tempCleanup,
        };
    }
    const rawSourceBytes = results.reduce((sum, result) => sum + (result.rawSourceBytes || 0), 0);
    /* Keep the model-facing excerpt bounded by construction; the complete source remains only on disk. */
    const excerptBudget = 300_000;
    let boundedExcerpt = '';
    for (const result of results) {
        if (boundedExcerpt.length >= excerptBudget)
            break;
        boundedExcerpt += formatCommandLog(result).slice(0, excerptBudget - boundedExcerpt.length);
    }
    /* Honor an optional caller-supplied line budget. Preserve the default 1:2 start:end split so error traces near the end stay intact. */
    let trimmedLogContent;
    if (maxOutputLines && maxOutputLines > 0) {
        const startBudget = Math.max(1, Math.floor(maxOutputLines / 3));
        const endBudget = Math.max(1, maxOutputLines - startBudget);
        trimmedLogContent = trimLog(boundedExcerpt, startBudget, endBudget);
    }
    else {
        trimmedLogContent = trimLog(boundedExcerpt);
    }
    // Return path relative to the workspace path for the client
    const relativeLogPath = path.relative(workspacePath, rawLogPath);
    /* Register the run so its log is addressable by a stable runId via query_log / grep_log. Best-effort: a failed index write must never fail the run itself. */
    const registeredLogPath = auditStatus === 'persisted' ? relativeLogPath : auditFailure?.evidencePath;
    try {
        if (!registeredLogPath)
            throw new Error('run has no persisted audit evidence to register');
        const exitCodes = {};
        for (const r of results) {
            exitCodes[r.command] = r.exitCode;
        }
        (0, registry_1.appendRun)(workspacePath, {
            runId: logFileName.replace(/\.log$/, ''),
            commands,
            exitCodes,
            timestamp: new Date().toISOString(),
            rawLogPath: registeredLogPath,
            lineCount: trimmedLogContent.split('\n').length
        });
    }
    catch (error) {
        warnings.push(`run registry update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const result = {
        results,
        rawLogPath: auditStatus === 'persisted' ? relativeLogPath : (auditFailure?.evidencePath || ''),
        trimmedLogContent,
        rawSourceBytes,
        rawSourceTokens: Math.ceil(rawSourceBytes / 4),
        auditStatus,
        ...(auditFailure ? { auditFailure } : {}),
        warnings
    };
    fs.rmSync(tempDir, { recursive: true, force: true });
    await (0, log_store_1.pruneLogs)(workspacePath, { storageMode, retentionDays, maxDiskMb }).catch((error) => warnings.push(`log pruning failed: ${error instanceof Error ? error.message : String(error)}`));
    return result;
}
/* Prefix every line with its 1-based line number so a model (query_log) can cite exact line ranges back to the caller. */
function numberLines(content) {
    return content.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
}
/* Return the working-tree diff of a single file against HEAD, or null when the workspace is not a git repo, git is unavailable, or there is no diff (e.g. an untracked or unchanged file). Lets changed-file review send focused hunks instead of whole files. */
async function getGitDiff(workspacePath, file) {
    const res = await runCommand(`git diff HEAD -- "${file}"`, workspacePath, 30000);
    if (res.exitCode !== 0) {
        return null;
    }
    const diff = res.stdout.trim();
    return diff.length > 0 ? res.stdout : null;
}
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.codex-local-test-runs']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|swift|kt|sh|yml|yaml|toml|html|css|scss|sql)$/i;
function shellEscape(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/* Merge nearby hit lines into context windows and number each kept line so the local model can cite exact ranges back to the caller. Hit lines are 1-based. */
function buildWindows(lines, hitLines, context, maxRegions) {
    const sorted = [...new Set(hitLines)].sort((a, b) => a - b);
    const ranges = [];
    for (const ln of sorted) {
        const start = Math.max(1, ln - context);
        const end = Math.min(lines.length, ln + context);
        const last = ranges[ranges.length - 1];
        if (last && start <= last[1] + 1) {
            last[1] = Math.max(last[1], end);
        }
        else {
            ranges.push([start, end]);
        }
    }
    const regions = [];
    for (const [start, end] of ranges.slice(0, maxRegions)) {
        const numbered = [];
        for (let i = start; i <= end; i++) {
            numbered.push(`${i}: ${lines[i - 1]}`);
        }
        regions.push({ lineRange: `${start}-${end}`, snippet: numbered.join('\n') });
    }
    return regions;
}
function regionsForFile(workspacePath, relFile, hitLines, opts) {
    const abs = path.resolve(workspacePath, relFile);
    try {
        if (fs.statSync(abs).size > opts.maxFileBytes) {
            return [];
        }
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        return buildWindows(lines, hitLines, opts.contextLines, opts.maxRegionsPerFile);
    }
    catch {
        return [];
    }
}
/* Run ripgrep for the seed terms and return file -> 1-based hit line numbers. Returns null when ripgrep is unavailable (exit code 127 / spawn error) so the caller can fall back to a Node walk. An empty map (no matches) is a valid non-null result. */
async function ripgrepHits(workspacePath, terms, roots, maxFileBytes) {
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
    const hits = new Map();
    for (const line of res.stdout.split('\n')) {
        if (!line)
            continue;
        const first = line.indexOf(':');
        const second = line.indexOf(':', first + 1);
        if (first === -1 || second === -1)
            continue;
        const file = line.slice(0, first);
        const lineNo = parseInt(line.slice(first + 1, second), 10);
        if (!Number.isFinite(lineNo))
            continue;
        const arr = hits.get(file) || [];
        arr.push(lineNo);
        hits.set(file, arr);
    }
    return hits;
}
/* Portable fallback when ripgrep is missing: bounded recursive walk that regex-matches the seed terms in text files, skipping the usual heavy directories. */
function nodeWalkHits(workspacePath, terms, roots, maxFileBytes) {
    const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(escaped.join('|'), 'i');
    const hits = new Map();
    let filesScanned = 0;
    const FILE_BUDGET = 5000;
    const walk = (dir) => {
        if (filesScanned >= FILE_BUDGET)
            return;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (filesScanned >= FILE_BUDGET)
                return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name))
                    continue;
                walk(full);
            }
            else if (entry.isFile() && TEXT_EXT.test(entry.name)) {
                try {
                    if (fs.statSync(full).size > maxFileBytes)
                        continue;
                    filesScanned++;
                    const lines = fs.readFileSync(full, 'utf8').split('\n');
                    const lineNos = [];
                    for (let i = 0; i < lines.length; i++) {
                        if (re.test(lines[i]))
                            lineNos.push(i + 1);
                    }
                    if (lineNos.length > 0) {
                        hits.set(path.relative(workspacePath, full), lineNos);
                    }
                }
                catch {
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
async function gatherCandidates(workspacePath, terms, options = {}) {
    const roots = options.roots && options.roots.length > 0 ? options.roots : ['.'];
    const maxCandidates = options.maxCandidates && options.maxCandidates > 0 ? options.maxCandidates : 30;
    const resolved = {
        contextLines: options.contextLines && options.contextLines > 0 ? options.contextLines : 4,
        maxRegionsPerFile: options.maxRegionsPerFile && options.maxRegionsPerFile > 0 ? options.maxRegionsPerFile : 4,
        maxFileBytes: options.maxFileBytes && options.maxFileBytes > 0 ? options.maxFileBytes : 500 * 1024
    };
    let searchedWith = 'ripgrep';
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
    const candidates = [];
    for (const [file, lineNos] of ranked) {
        const regions = regionsForFile(workspacePath, file, lineNos, resolved);
        if (regions.length > 0) {
            candidates.push({ file, hitCount: lineNos.length, regions });
        }
    }
    return { candidates, filesMatched, totalHits, searchedWith };
}
