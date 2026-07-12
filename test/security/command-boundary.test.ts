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
  /* Backslash-escaping a shell metacharacter is a POSIX-only allowance (see the win32 test
   * below) -- cmd.exe has no backslash escape, so the same command is correctly denied there. */
  const escapedPipe = await runCommand(`printf x \\| tee marker`, root, 1000, execution);
  if (process.platform === 'win32') assert.equal(escapedPipe.executionStatus, 'blocked');
  else assert.equal(escapedPipe.exitCode, 0);
  assert.equal(fs.existsSync(path.join(root, 'marker')), false);
  for (const command of [`printf 'unterminated`, `printf "unterminated`]) {
    assert.equal((await runCommand(command, root, 1000, execution)).executionStatus, 'blocked');
  }
  for (const command of [`printf "x;|&>"`, `printf "C:\\Program Files\\A&B"`, `printf '%3B'`]) {
    assert.equal((await evaluateCommand({ command, workspacePath: root, profile: 'unrestricted' })).allowed, true, command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/* runner.ts spawns with shell:true, which resolves to cmd.exe on win32 -- unlike POSIX sh,
 * cmd.exe has no backslash escape and does not group text with single quotes at all, so
 * POSIX-only allowances that are genuinely inert on POSIX must be denied on win32 instead,
 * since the metacharacters they "hide" are still live once cmd.exe parses the command line. */
test('win32 scanning denies POSIX-only escapes and single-quote grouping that cmd.exe would not honor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'to-security-win32-quotes-'));
  for (const command of [`printf x \\| tee marker`, `printf 'x & del marker'`, `printf 'x; del marker'`]) {
    /* Force a concrete POSIX platform rather than relying on the ambient process.platform --
     * this test itself may be running on a real win32 host, which would otherwise make the
     * "POSIX allows this" half of the comparison contradict itself. */
    const posix = await evaluateCommand({ command, workspacePath: root, profile: 'unrestricted', platform: 'linux' });
    assert.equal(posix.allowed, true, `expected POSIX to allow: ${command}`);
    const win32 = await evaluateCommand({ command, workspacePath: root, profile: 'unrestricted', platform: 'win32' });
    assert.equal(win32.allowed, false, `expected win32 to deny: ${command}`);
    assert.equal(win32.allowed === false ? win32.reasonCode : undefined, 'SHELL_METACHARACTER');
  }
  /* Regression: disabling single-quote grouping on win32 (above) must not also disable
   * "unmatched quote" detection. A stray single quote never leaves `quote` open on win32
   * (grouping is disabled), so unmatchedQuote must be tracked by parity instead, or an odd
   * number of single quotes silently passes through as allowed. */
  for (const command of [`printf 'unterminated`, `printf 'a' 'b`]) {
    const win32 = await evaluateCommand({ command, workspacePath: root, profile: 'unrestricted', platform: 'win32' });
    assert.equal(win32.allowed, false, `expected win32 to deny an odd count of single quotes: ${command}`);
  }
  const balanced = await evaluateCommand({ command: `printf '%3B'`, workspacePath: root, profile: 'unrestricted', platform: 'win32' });
  assert.equal(balanced.allowed, true, 'a balanced (even-count) single-quote pair with no metacharacters must still be allowed on win32');
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
  /* Backslash-escaping `$(` / backtick inside double quotes is a POSIX-only allowance --
   * cmd.exe has no backslash escape, so the same commands are correctly denied there. */
  for (const command of [`printf "\\$(touch marker)"`, 'printf "\\`touch marker\\`"']) {
    const result = await runCommand(command, root, 1000, execution);
    if (process.platform === 'win32') assert.equal(result.executionStatus, 'blocked', command);
    else assert.equal(result.exitCode, 0, command);
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
