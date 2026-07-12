import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCommand } from '../../src/command-policy';
import { runCommand } from '../../src/runner';

/* These release-gate cases use disposable workspaces and observable marker files
   to prove rejection occurs before a child process can mutate external state. */
test('command boundary blocks escape, symlink, sensitive, and redirection attacks before spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-command-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'fixture-secret');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const attacks = ['cat ../secret', 'cat escape/secret', 'cat ~/.ssh/id_rsa', `printf owned >${path.join(outside, 'marker')}`];
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
  for (const command of ['npm test; cat .env', 'npm test && printenv', 'npm test || env', 'npm test | env', 'npm test & env', 'npm test\nenv', 'npm test\renv', 'npm test `env`', 'npm test $(env)', 'npm test > result']) {
    assert.equal((await evaluateCommand({ ...base, command, profile: 'unrestricted' })).allowed, false, command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanner follows POSIX quote and escape rules and fails closed on unmatched quotes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-quotes-'));
  const execution = { profile: 'unrestricted' as const, allowedCommandPrefixes: [] };
  const singleQuoteAttack = await runCommand(`printf 'x\\'; touch marker`, root, 1000, execution);
  assert.equal(singleQuoteAttack.executionStatus, 'blocked'); assert.equal(fs.existsSync(path.join(root, 'marker')), false);
  const escapedPipe = await runCommand(`printf x \\| tee marker`, root, 1000, execution);
  assert.equal(escapedPipe.exitCode, 0); assert.equal(fs.existsSync(path.join(root, 'marker')), false);
  for (const command of [`printf 'unterminated`, `printf "unterminated`]) {
    assert.equal((await runCommand(command, root, 1000, execution)).executionStatus, 'blocked');
  }
  for (const command of [`printf "x;|&>"`, `printf "C:\\Program Files\\A&B"`, `printf '%3B'`]) {
    assert.equal((await evaluateCommand({ command, workspacePath: root, profile: 'unrestricted' })).allowed, true, command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('double quotes block active command substitution but allow escaped literals', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-double-substitution-'));
  const execution = { profile: 'unrestricted' as const, allowedCommandPrefixes: [] };
  for (const command of [`printf "$(touch marker)"`, 'printf "`touch marker`"']) {
    const result = await runCommand(command, root, 1000, execution);
    assert.equal(result.executionStatus, 'blocked', command);
    assert.equal(fs.existsSync(path.join(root, 'marker')), false, command);
  }
  for (const command of [`printf "\\$(touch marker)"`, 'printf "\\`touch marker\\`"']) {
    const result = await runCommand(command, root, 1000, execution);
    assert.equal(result.exitCode, 0, command);
    assert.equal(fs.existsSync(path.join(root, 'marker')), false, command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('pipe and line-break composition cannot create a marker before spawn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-compose-'));
  for (const suffix of ['| tee marker', '\nprintf owned > marker', '\rprintf owned > marker']) {
    const result = await runCommand(`printf fixture ${suffix}`, root, 1000, { profile: 'unrestricted', allowedCommandPrefixes: [] });
    assert.equal(result.executionStatus, 'blocked', JSON.stringify(suffix));
    assert.equal(fs.existsSync(path.join(root, 'marker')), false, JSON.stringify(suffix));
  }
  const quoted = await runCommand(`node -e "process.stdout.write('a|b')"`, root, 1000, { profile: 'unrestricted', allowedCommandPrefixes: [] });
  assert.equal(quoted.exitCode, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('timeout terminates a spawned process tree', async () => {
  const root = path.resolve(__dirname, '../../../');
  const result = await runCommand(`node ${path.join(root, 'test/fixtures/spawn-process-tree.js')}`, root, 100, { profile: 'unrestricted', allowedCommandPrefixes: [] });
  assert.equal(result.executionStatus, 'timed_out');
  assert.ok(result.termination);
});
