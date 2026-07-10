import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateCommand } from '../../src/command-policy';

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

test('unrestricted still observes deny-first safety checks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  const decision = await evaluateCommand({ command: 'curl https://example.com', workspacePath: root, profile: 'unrestricted' });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'NETWORK_EXFILTRATION');
  fs.rmSync(root, { recursive: true, force: true });
});

