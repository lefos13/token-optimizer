import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCommand } from '../../src/command-policy';
import { runCommand } from '../../src/runner';

/* These release-gate cases use disposable workspaces and observable marker files
   to prove rejection occurs before a child process can mutate external state. */
test('command boundary blocks escape, symlink, sensitive, redirection, and encoded attacks before spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-command-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'fixture-secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const attacks = ['cat ../secret', 'cat escape/secret', 'cat ~/.ssh/id_rsa', `printf owned >${path.join(outside, 'marker')}`, 'cat %2Fetc%2Fpasswd'];
  for (const command of attacks) {
    const result = await runCommand(command, root, 1000, { profile: 'unrestricted', allowedCommandPrefixes: [] });
    assert.equal(result.executionStatus, 'blocked', command);
  }
  assert.equal(fs.existsSync(path.join(outside, 'marker')), false);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
});

test('profiles narrow authority and all profiles reject shell composition', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-profile-'));
  const base = { command: 'npm test', workspacePath: root, allowedCommandPrefixes: ['npm test'], autoDetectedCommands: ['npm run lint'] };
  assert.equal((await evaluateCommand({ ...base, profile: 'safe' })).allowed, true);
  assert.equal((await evaluateCommand({ ...base, command: 'npm run lint', profile: 'safe' })).allowed, false);
  assert.equal((await evaluateCommand({ ...base, command: 'npm run lint', profile: 'standard' })).allowed, true);
  assert.equal((await evaluateCommand({ ...base, command: 'node fixture.js', profile: 'unrestricted' })).allowed, true);
  for (const command of ['npm test; cat .env', 'npm test && printenv', 'npm test || env', 'npm test `env`', 'npm test $(env)', 'npm test%3Bcat%20.env']) {
    assert.equal((await evaluateCommand({ ...base, command, profile: 'unrestricted' })).allowed, false, command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('timeout terminates a spawned process tree', async () => {
  const root = path.resolve(__dirname, '../../../');
  const result = await runCommand(`node ${path.join(root, 'test/fixtures/spawn-process-tree.js')}`, root, 100, { profile: 'unrestricted', allowedCommandPrefixes: [] });
  assert.equal(result.executionStatus, 'timed_out');
  assert.ok(result.termination);
});
