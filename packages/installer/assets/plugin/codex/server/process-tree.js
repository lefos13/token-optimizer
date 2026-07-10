"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.terminateProcessTree = terminateProcessTree;
const node_child_process_1 = require("node:child_process");
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function waitForExit(pid, graceMs, platform) {
    return new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
            const alive = platform === 'win32' ? isAlive(pid) : isAlive(pid) || isGroupAlive(pid);
            if (!alive) {
                resolve(true);
                return;
            }
            if (Date.now() - started >= graceMs) {
                resolve(false);
                return;
            }
            setTimeout(poll, Math.min(25, Math.max(1, graceMs)));
        };
        poll();
    });
}
function isGroupAlive(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/* Unix process groups and Windows taskkill are kept behind one result-bearing adapter so callers can preserve command outcomes. */
async function terminateUnixGroup(child, graceMs, platform) {
    const pid = child.pid;
    try {
        process.kill(-pid, 'SIGTERM');
    }
    catch (error) {
        if (!isAlive(pid))
            return { terminated: true, method: 'already-exited' };
        child.kill('SIGTERM');
        if (await waitForExit(pid, graceMs, platform))
            return { terminated: true, guarantee: false, method: 'sigterm-group' };
        try {
            child.kill('SIGKILL');
            return { terminated: await waitForExit(pid, graceMs, platform), guarantee: false, method: 'sigkill-group' };
        }
        catch {
            return { terminated: false, method: 'error', error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (await waitForExit(pid, graceMs, platform))
        return { terminated: true, method: 'sigterm-group' };
    try {
        process.kill(-pid, 'SIGKILL');
        const terminated = await waitForExit(pid, graceMs, platform);
        return { terminated, method: 'sigkill-group' };
    }
    catch (error) {
        return { terminated: !isAlive(pid), method: 'error', error: error instanceof Error ? error.message : String(error) };
    }
}
function runTaskkill(args) {
    return new Promise((resolve) => {
        (0, node_child_process_1.execFile)('taskkill', args, (error) => resolve({ code: error?.code ?? 0, error: error ?? undefined }));
    });
}
async function terminateWindowsTree(pid, graceMs) {
    const soft = await runTaskkill(['/PID', String(pid), '/T']);
    if (!soft.error || !isAlive(pid)) {
        if (await waitForExit(pid, graceMs, 'win32'))
            return { terminated: true, method: 'taskkill-tree' };
    }
    const forced = await runTaskkill(['/PID', String(pid), '/T', '/F']);
    if (await waitForExit(pid, graceMs, 'win32'))
        return { terminated: true, method: 'taskkill-force' };
    return { terminated: false, method: 'error', error: forced.error?.message ?? soft.error?.message ?? 'taskkill did not terminate process' };
}
async function terminateProcessTree(child, platform = process.platform, graceMs = 1000) {
    if (!child.pid)
        return { terminated: true, method: 'already-exited' };
    if (platform === 'win32')
        return terminateWindowsTree(child.pid, graceMs);
    return terminateUnixGroup(child, graceMs, platform);
}
