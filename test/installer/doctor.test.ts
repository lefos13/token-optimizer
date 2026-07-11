import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { inspectInstallation } = require('../../../packages/installer/lib/doctor.js');

test('doctor is read-only and reports stale launcher version', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  fs.mkdirSync(path.join(home, '.codex-local-test-runs'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex-local-test-runs', 'run.log'), 'fixture');
  const before = JSON.stringify(fs.readdirSync(home, { recursive: true }).sort().map((entry: any) => String(entry)));
  const report = await inspectInstallation({ home, installedVersion: '1.12.1', expectedVersion: '2.0.0' });
  const after = JSON.stringify(fs.readdirSync(home, { recursive: true }).sort().map((entry: any) => String(entry)));
  assert.equal(after, before);
  assert.ok(report.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
});

test('doctor report redacts fixture credentials', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const report = await inspectInstallation({ home, env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', LLM_GATEWAY_TOKEN: 'fixture-secret' } });
  assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
  assert.equal(report.provider.credentialStore, 'environment');
});

test('doctor reports unavailable provider through injectable health probe', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const report = await inspectInstallation({ home, provider: 'gateway', env: { LLM_GATEWAY_TOKEN: 'token' }, healthProbe: async () => false });
  assert.ok(report.findings.some((item: any) => item.code === 'PROVIDER_UNREACHABLE'));
});

test('blank credential placeholders are not considered configured', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const report = await inspectInstallation({ home, provider: 'gateway-token', env: { LLM_GATEWAY_TOKEN: 'placeholder' } });
  assert.ok(report.findings.some((item: any) => item.code === 'CREDENTIAL_MISSING'));
});

test('doctor detects JSON credential references and redacts provider URL secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { env: { TOKEN_OPTIMIZER_CREDENTIAL_REF: JSON.stringify({ store: 'macos-keychain', account: 'alice' }), TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token' } } } }));
  const report = await inspectInstallation({ home, providerUrl: 'https://user:secret@example.test/v1?token=secret', healthProbe: async () => true });
  assert.equal(report.provider.credentialConfigured, true);
  assert.equal(report.provider.url, 'https://example.test/v1');
});

test('doctor distinguishes detected and expected versions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const report = await inspectInstallation({ home, detectedVersion: '1.0.0', expectedVersion: '2.0.0' });
  assert.equal(report.installedVersion, '1.0.0');
  assert.equal(report.installedVersionSource, 'detected');
});

test('doctor labels package-version fallback as assumed, not detected', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const report = await inspectInstallation({ home, expectedVersion: '2.0.0' });
  assert.equal(report.installedVersionSource, 'assumed');
});
