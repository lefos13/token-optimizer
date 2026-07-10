import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

export interface TerminationResult {
  terminated: boolean;
  guarantee?: boolean;
  method: 'already-exited' | 'sigterm-group' | 'sigkill-group' | 'taskkill-tree' | 'taskkill-force' | 'error';
  error?: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, graceMs: number, platform: NodeJS.Platform): Promise<boolean> {
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

function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/* Unix process groups and Windows taskkill are kept behind one result-bearing adapter so callers can preserve command outcomes. */
async function terminateUnixGroup(child: ChildProcess, graceMs: number, platform: NodeJS.Platform): Promise<TerminationResult> {
  const pid = child.pid as number;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (!isAlive(pid)) return { terminated: true, method: 'already-exited' };
    child.kill('SIGTERM');
    if (await waitForExit(pid, graceMs, platform)) return { terminated: true, guarantee: false, method: 'sigterm-group' };
    try {
      child.kill('SIGKILL');
      return { terminated: await waitForExit(pid, graceMs, platform), guarantee: false, method: 'sigkill-group' };
    } catch {
      return { terminated: false, method: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (await waitForExit(pid, graceMs, platform)) return { terminated: true, method: 'sigterm-group' };
  try {
    process.kill(-pid, 'SIGKILL');
    const terminated = await waitForExit(pid, graceMs, platform);
    return { terminated, method: 'sigkill-group' };
  } catch (error) {
    return { terminated: !isAlive(pid), method: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

function runTaskkill(args: string[]): Promise<{ code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    execFile('taskkill', args, (error) => resolve({ code: error?.code as number | null ?? 0, error: error ?? undefined }));
  });
}

async function terminateWindowsTree(pid: number, graceMs: number): Promise<TerminationResult> {
  const soft = await runTaskkill(['/PID', String(pid), '/T']);
  if (!soft.error || !isAlive(pid)) {
    if (await waitForExit(pid, graceMs, 'win32')) return { terminated: true, method: 'taskkill-tree' };
  }
  const forced = await runTaskkill(['/PID', String(pid), '/T', '/F']);
  if (await waitForExit(pid, graceMs, 'win32')) return { terminated: true, method: 'taskkill-force' };
  return { terminated: false, method: 'error', error: forced.error?.message ?? soft.error?.message ?? 'taskkill did not terminate process' };
}

export async function terminateProcessTree(child: ChildProcess, platform = process.platform, graceMs = 1000): Promise<TerminationResult> {
  if (!child.pid) return { terminated: true, method: 'already-exited' };
  if (platform === 'win32') return terminateWindowsTree(child.pid, graceMs);
  return terminateUnixGroup(child, graceMs, platform);
}
