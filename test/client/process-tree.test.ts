import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { terminateProcessTree } from '../../src/process-tree';
import { runCommand } from '../../src/runner';

const fixturePath = path.resolve(__dirname, '../../../test/fixtures/spawn-process-tree.js');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readGrandchildPid(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const pid = Number.parseInt(output.trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        child.stdout?.off('data', onData);
        resolve(pid);
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('fixture exited before reporting grandchild pid')));
  });
}

test('termination removes the spawned grandchild', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, [fixturePath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const grandchildPid = await readGrandchildPid(child);
  const result = await terminateProcessTree(child, process.platform, 250);
  assert.equal(result.terminated, true);
  assert.ok(result.method === 'sigterm-group' || result.method === 'sigkill-group');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(grandchildPid), false);
});

test('termination escalates when a descendant ignores SIGTERM', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, [fixturePath], {
    detached: true,
    env: { ...process.env, IGNORE_TERM: '1' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const grandchildPid = await readGrandchildPid(child);
  const result = await terminateProcessTree(child, process.platform, 100);
  assert.equal(result.terminated, true);
  assert.equal(result.method, 'sigkill-group');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(grandchildPid), false);
});

test('missing pid is already terminated', async () => {
  const result = await terminateProcessTree({ pid: undefined } as ChildProcess, process.platform, 10);
  assert.deepEqual(result, { terminated: true, method: 'already-exited' });
});

test('runner timeout records process-tree termination', { skip: process.platform === 'win32' }, async () => {
  const result = await runCommand('sleep 1', process.cwd(), 50);
  assert.equal(result.exitCode, -1);
  assert.equal(result.error, 'Timeout');
  assert.equal(result.termination?.terminated, true);
});
