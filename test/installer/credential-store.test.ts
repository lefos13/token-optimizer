import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { createCredentialStore } = require('../../../packages/installer/lib/credential-store.js');

test('native-store failure does not write plaintext fallback', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-'));
  const config = path.join(home, 'credentials.json');
  const store = createCredentialStore('native', { platform: 'unknown', path: config });
  assert.throws(() => store.set('sk-or-secret-value'), /choose env or config explicitly/i);
  assert.equal(fs.existsSync(config), false);
});

test('status exposes only a fingerprint', () => {
  const store = createCredentialStore('env', { env: {}, account: 'test' });
  const reference = store.set('sk-or-secret-value');
  assert.doesNotMatch(JSON.stringify(reference), /secret-value/);
  assert.match(reference.fingerprint, /^sha256:/);
});

test('injected macOS adapter uses argv and supports lifecycle', () => {
  const calls: unknown[][] = [];
  const store = createCredentialStore('native', { platform: 'darwin', available: true, account: 'alice', execFileSync: (bin: string, args: string[], options: object) => { calls.push([bin, args, options]); return ''; } });
  assert.equal(store.isAvailable(), true);
  store.set('secret'); store.get(); store.delete();
  assert.equal(calls[0][0], '/usr/bin/security');
  assert.deepEqual((calls[0][1] as string[]).slice(0, 2), ['add-generic-password', '-U']);
  assert.doesNotMatch(JSON.stringify(calls[0][1]), /secret/);
  assert.equal((calls[0][2] as { input: string }).input, 'secret');
});

test('linux native store fails closed when secret-tool is unavailable', () => {
  const store = createCredentialStore('native', { platform: 'linux', commandExists: () => false });
  assert.equal(store.isAvailable(), false);
  assert.throws(() => store.set('secret'), /choose env or config explicitly/i);
});

test('credential references survive change plans without secret values', () => {
  const { createChangePlan, credentialOperation } = require('../../../packages/installer/lib/change-plan.js');
  const reference = createCredentialStore('env', { env: {} }).set('sk-or-secret-value');
  const plan = createChangePlan({}, [credentialOperation('openrouter', reference)]);
  assert.doesNotMatch(JSON.stringify(plan), /secret-value/);
  assert.match(plan.operations[0].fingerprint, /^sha256:/);
});
