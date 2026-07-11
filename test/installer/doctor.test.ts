import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const doctor = require('../../../packages/installer/lib/doctor.js');
const inspectInstallation = (options: any) => doctor.inspectInstallation({ skipPluginCommands: true, ...options });

function write(file: string, value: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }
function server(home: string, name: string, version = '2.0.0-beta.5', complete = true) {
  const root = path.join(home, 'servers', name); const launcher = path.join(root, 'start.js');
  write(launcher, '#!/usr/bin/env node\n'); write(path.join(root, 'package.json'), JSON.stringify({ version }));
  if (complete) { write(path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}'); write(path.join(root, 'node_modules', 'zod', 'package.json'), '{}'); }
  return launcher;
}
function snapshot(root: string) {
  const rows: any[] = [];
  const walk = (dir: string) => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); const stat = fs.lstatSync(file); rows.push([path.relative(root, file), stat.mode, stat.size, stat.mtimeMs, stat.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]); if (stat.isDirectory()) walk(file); } };
  walk(root); return JSON.stringify(rows);
}

/* These fixtures mirror every supported client's real registration shape so
   doctor cannot regress to using the mere existence of client root folders. */
test('detects real registrations and installed metadata for all five clients', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const launchers = Object.fromEntries(['claude', 'codex', 'antigravity', 'opencode', 'cursor'].map((name) => [name, server(home, name)]));
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launchers.claude] } } }));
  write(path.join(home, '.codex', 'config.toml'), `[mcp_servers.token_optimizer]\ncommand = "node"\nargs = ["${launchers.codex}"]\n`);
  write(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launchers.antigravity] } } }));
  write(path.join(home, '.config', 'opencode', 'opencode.jsonc'), JSON.stringify({ mcp: { token_optimizer: { command: ['node', launchers.opencode] } } }));
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launchers.cursor] } } }));
  const report = await inspectInstallation({ home, provider: 'local', expectedVersion: '2.0.0-beta.5', performHealthProbe: false });
  assert.deepEqual(report.clients.configured.sort(), ['antigravity', 'claude', 'codex', 'cursor', 'opencode']);
  assert.equal(report.detectedVersions.length, 5); assert.equal(report.installedVersionSource, 'server-package');
});

test('status is byte-for-byte read-only and never calls provider', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor');
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher], env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', LLM_GATEWAY_TOKEN: 'fixture-secret' } } } }));
  const before = snapshot(home); let calls = 0;
  const report = await inspectInstallation({ home, performHealthProbe: false, healthProbe: async () => { calls++; return { ok: true }; } });
  assert.equal(snapshot(home), before); assert.equal(calls, 0); assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
});

test('doctor resolves credential reference and performs authenticated quota-free check', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor');
  const ref = { store: 'macos-keychain', service: 'token-optimizer', account: 'gateway-token', fingerprint: 'sha256:safe' };
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher], env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: JSON.stringify(ref) } } } }));
  let request: any;
  const report = await inspectInstallation({ home, platform: 'linux', performHealthProbe: true, createCredentialStore: () => ({ get: () => 'valid-fixture-token' }), healthProbe: async (value: any) => { request = value; return { ok: true, statusCode: 200 }; } });
  assert.equal(request.mode, 'gateway-token'); assert.equal(request.credential, 'valid-fixture-token'); assert.doesNotMatch(JSON.stringify(report), /valid-fixture-token/);
});

test('invalid nonblank placeholder and inaccessible native credential fail truthfully', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const invalid = await inspectInstallation({ home, provider: 'gateway-token', env: { LLM_GATEWAY_TOKEN: '${TOKEN}' }, performHealthProbe: true, healthProbe: async () => ({ ok: true }) });
  assert.ok(invalid.findings.some((item: any) => item.code === 'PROVIDER_AUTH_FAILED'));
  const inaccessible = await inspectInstallation({ home, provider: 'gateway-token', credentialRef: { store: 'linux-secret-service', account: 'x' }, createCredentialStore: () => ({ get: () => { throw new Error('locked'); } }), healthProbe: async () => ({ ok: true }) });
  assert.ok(inaccessible.findings.some((item: any) => item.code === 'CREDENTIAL_INACCESSIBLE'));
});

test('reports duplicate/stale registrations, version mismatch, and missing runtime dependencies', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const stale = path.join(home, 'missing', 'start.js'); const old = server(home, 'cursor', '1.9.0', false);
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [old] } } }));
  write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [stale] } } }));
  write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [stale] } } }));
  const report = await inspectInstallation({ home, provider: 'local', expectedVersion: '2.0.0-beta.5' });
  for (const code of ['DUPLICATE_REGISTRATION', 'STALE_REGISTRATION', 'VERSION_MISMATCH', 'MISSING_LAUNCHER', 'DEPENDENCY_CACHE_INCOMPLETE']) assert.ok(report.findings.some((item: any) => item.code === code), code);
});

test('marketplace probes expose stale installed version and duplicate direct registration', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const direct = server(home, 'codex', '2.0.0-beta.5');
  write(path.join(home, '.codex', 'config.toml'), `[mcp_servers.token_optimizer]\ncommand = "node"\nargs = ["${direct}"]\n`);
  const report = await inspectInstallation({ home, provider: 'local', expectedVersion: '2.0.0-beta.5', pluginListings: { claude: 'token-optimizer enabled v1.12.1', codex: 'token-optimizer enabled v1.12.1' } });
  assert.ok(report.detectedVersions.some((item: any) => item.source === 'client-plugin-list' && item.version === '1.12.1'));
  assert.ok(report.findings.some((item: any) => item.code === 'DUPLICATE_REGISTRATION' && item.client === 'codex'));
  assert.ok(report.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
});

test('reports bad manifest without repair source and macOS launchctl mismatch', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const managed = path.join(home, '.token-optimizer', 'managed.txt'); write(managed, 'changed');
  write(path.join(home, '.token-optimizer', 'manifest.json'), JSON.stringify({ schemaVersion: 2, roots: [path.join(home, '.token-optimizer')], assetRoots: [path.join(home, 'missing-cache')], files: [{ path: managed, sha256: 'bad', ownership: 'installer' }] }));
  write(path.join(home, 'Library', 'LaunchAgents', 'com.softawarest.token-optimizer.env.plist'), '<plist/>');
  const report = await inspectInstallation({ home, platform: 'darwin', provider: 'gateway-token', env: { LLM_GATEWAY_TOKEN: 'valid-token' }, launchctlLoaded: false, healthProbe: async () => ({ ok: true }) });
  for (const code of ['MANIFEST_HASH_MISMATCH', 'MANIFEST_SOURCE_UNAVAILABLE', 'LAUNCHCTL_MISMATCH']) assert.ok(report.findings.some((item: any) => item.code === code), code);
});

test('workspace log diagnostics enforce quota and reject symlink roots', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const workspace = path.join(home, 'workspace'); write(path.join(workspace, '.codex-local-test-runs', 'run.log'), '123456');
  const quota = await inspectInstallation({ home, workspace, provider: 'local', logQuotaBytes: 2 });
  assert.ok(quota.findings.some((item: any) => item.code === 'LOG_QUOTA_EXCEEDED'));
  fs.rmSync(path.join(workspace, '.codex-local-test-runs'), { recursive: true }); fs.symlinkSync(home, path.join(workspace, '.codex-local-test-runs'));
  const unsafe = await inspectInstallation({ home, workspace, provider: 'local' });
  assert.ok(unsafe.findings.some((item: any) => item.code === 'LOG_PATH_UNSAFE'));
});
