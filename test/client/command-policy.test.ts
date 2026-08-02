import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateCommand } from '../../src/command-policy';
import { runCommand } from '../../src/runner';

test('safe allows configured validation commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const decision = await evaluateCommand({ command: 'npm test', workspacePath: root, profile: 'safe', allowedCommandPrefixes: ['npm test'] });
  assert.deepEqual(decision, { allowed: true, profile: 'safe', reasonCode: 'ALLOWLIST_MATCH' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('safe blocks sensitive paths and symlink escape', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'linked-outside'));
  const sensitive = await evaluateCommand({ command: 'cat ~/.ssh/id_rsa', workspacePath: root, profile: 'safe', allowedCommandPrefixes: ['cat'] });
  const escaped = await evaluateCommand({ command: 'cat linked-outside/secret', workspacePath: root, profile: 'safe', allowedCommandPrefixes: ['cat'] });
  assert.equal(sensitive.allowed, false);
  assert.equal(sensitive.reasonCode, 'SENSITIVE_PATH');
  assert.equal(escaped.allowed, false);
  assert.equal(escaped.reasonCode, 'WORKSPACE_ESCAPE');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('standard allows configured auto-detected commands while safe does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const input = { command: 'npm run lint', workspacePath: root, allowedCommandPrefixes: [], autoDetectedCommands: ['npm run lint'] };
  assert.equal((await evaluateCommand({ ...input, profile: 'safe' })).allowed, false);
  assert.deepEqual(await evaluateCommand({ ...input, profile: 'standard' }), { allowed: true, profile: 'standard', reasonCode: 'AUTO_DETECTED' });
  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * Standard is the practical installer default, so it recognizes targeted Node
 * tests and read-only Git diffs without requiring per-project allowlist entries.
 */
test('standard allows targeted Node tests and read-only Git diffs while safe does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-standard-'));
  const commands = [
    'node --test src/modules/organizations/organization.service.test.js',
    'git diff --cached --stat',
    'git diff --cached -- src/modules/organizations/organization.service.js prisma/schema.prisma',
  ];
  for (const command of commands) {
    assert.equal((await evaluateCommand({ command, workspacePath: root, profile: 'safe' })).allowed, false, command);
    assert.deepEqual(
      await evaluateCommand({ command, workspacePath: root, profile: 'standard' }),
      { allowed: true, profile: 'standard', reasonCode: 'STANDARD_PROFILE' },
      command,
    );
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('standard does not generalize targeted allowances to arbitrary Node or mutating Git commands', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-standard-deny-'));
  for (const command of [
    'node src/scripts/publish.js',
    'node --test --import=/tmp/outside-workspace.js',
    'node --test --require=/tmp/outside-workspace.js',
    'node --test --test-reporter-destination=review.log',
    'git add .',
    'git diff --output=review.patch',
    'git diff --ext-diff',
    'git diff --textconv',
  ]) {
    const decision = await evaluateCommand({ command, workspacePath: root, profile: 'standard' });
    assert.equal(decision.allowed, false, command);
    assert.equal(decision.reasonCode, 'COMMAND_NOT_ALLOWED', command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/*
 * Git enables textconv filters for normal diffs, so the runner must harden an
 * accepted standard-profile diff before a repository-configured helper runs.
 */
test('standard Git diff does not execute repository textconv helpers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-standard-textconv-'));
  const marker = path.join(root, 'textconv-executed');
  fs.writeFileSync(path.join(root, 'textconv.js'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.bin diff=probe\n');
  fs.writeFileSync(path.join(root, 'fixture.bin'), 'before\n');
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'diff.probe.textconv', 'node textconv.js'], { cwd: root });
  execFileSync('git', ['add', '.gitattributes', 'fixture.bin'], { cwd: root });
  fs.writeFileSync(path.join(root, 'fixture.bin'), 'after\n');

  const result = await runCommand('git diff -- fixture.bin', root, 5000, { profile: 'standard', allowedCommandPrefixes: [] });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unrestricted still observes deny-first safety checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const decision = await evaluateCommand({ command: 'curl https://example.com', workspacePath: root, profile: 'unrestricted' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'NETWORK_EXFILTRATION');
  fs.rmSync(root, { recursive: true, force: true });
});

test('redirection targets outside the workspace are denied', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  for (const command of ['npm test >/tmp/token-optimizer-policy-out', 'npm test>/tmp/token-optimizer-policy-out', 'npm test 2>/tmp/token-optimizer-policy-out', 'npm test>>/tmp/token-optimizer-policy-out', 'cat </tmp/token-optimizer-policy-in']) {
    const decision = await evaluateCommand({ command, workspacePath: root, profile: 'safe', allowedCommandPrefixes: ['npm test', 'cat'] });
    assert.equal(decision.allowed, false, command);
    assert.equal(decision.reasonCode, 'WORKSPACE_ESCAPE', command);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('rm recursive force flags are denied regardless of order', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  for (const command of ['rm -r -f target', 'rm -f -r target', 'rm -rf target']) {
    const decision = await evaluateCommand({ command, workspacePath: root, profile: 'safe', allowedCommandPrefixes: ['rm'] });
    assert.equal(decision.reasonCode, 'DESTRUCTIVE_PATTERN');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('runner rejects blocked commands before execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const marker = path.join(os.tmpdir(), `token-optimizer-policy-${process.pid}-should-not-exist`);
  const command = `printf blocked >${marker}`;
  const result = await runCommand(command, root, 1000, { profile: 'safe', allowedCommandPrefixes: ['printf blocked'] });
  assert.equal(result.policyReasonCode, 'WORKSPACE_ESCAPE');
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(root, { recursive: true, force: true });
});
