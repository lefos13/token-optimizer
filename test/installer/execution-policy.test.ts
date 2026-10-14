import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const policy = require('../../../packages/installer/lib/execution-policy.js');
const bin = path.resolve(__dirname, '..', '..', '..', 'packages', 'installer', 'bin', 'token-optimizer.js');

function run(home: string, ...args: string[]) {
  return spawnSync(process.execPath, [bin, ...args, '--home', home], { encoding: 'utf8' });
}

test('allow, list, and remove manage the private user allowlist', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-allow-'));
  assert.equal(run(home, 'allow', 'npm install').status, 0);
  assert.equal(run(home, 'allow', 'npm install').status, 0);
  const file = path.join(home, '.config', 'token-optimizer', 'config.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config.execution.allowedCommandPrefixes, ['npm install']);
  assert.equal(config.execution.profile, 'standard');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(run(home, 'allow', '--list').stdout, /allow: npm install/);
  assert.equal(run(home, 'allow', '--remove', 'npm install').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).execution.allowedCommandPrefixes, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test('allow refuses prefixes the server would reject in every profile', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-allow-deny-'));
  for (const prefix of ['curl', 'bash -c', 'npm test && rm', 'cat $HOME']) {
    const result = run(home, 'allow', prefix);
    assert.notEqual(result.status, 0, prefix);
  }
  assert.equal(fs.existsSync(path.join(home, '.config', 'token-optimizer', 'config.json')), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('profile command sets an explicit profile and preserves other keys', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-profile-'));
  const file = path.join(home, '.config', 'token-optimizer', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ logs: { retentionDays: 3 }, execution: { allowedCommandPrefixes: ['make test'] } }));
  assert.equal(run(home, 'profile', 'unrestricted').status, 0);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(config, { logs: { retentionDays: 3 }, execution: { allowedCommandPrefixes: ['make test'], profile: 'unrestricted' } });
  assert.notEqual(run(home, 'profile', 'yolo').status, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('interactive profile prompt defaults to standard and requires typed confirmation for unrestricted', async () => {
  const choose = (answers: string[]) => { const queue = [...answers]; return policy.promptForProfile(async () => queue.shift(), () => {}); };
  assert.equal(await choose(['']), 'standard');
  assert.equal(await choose(['9', '2']), 'safe');
  assert.equal(await choose(['3', '', '1']), 'standard');
  assert.equal(await choose(['3', 'unrestricted']), 'unrestricted');
});
