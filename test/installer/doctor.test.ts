import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';

const doctor = require('../../../packages/installer/lib/doctor.js');
const inspectInstallation = (options: any) => doctor.inspectInstallation(options);

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

test('canonical registration provider overrides stale ambient process mode', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor');
  const ref = { store: 'macos-keychain', service: 'token-optimizer', account: 'gateway-token', fingerprint: 'sha256:safe' };
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher], env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: JSON.stringify(ref), LLM_GATEWAY_URL: 'https://gateway.example/v1' } } } }));
  let request: any;
  const report = await inspectInstallation({ home, env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'local' }, performHealthProbe: true, createCredentialStore: () => ({ get: () => 'valid-fixture-token' }), healthProbe: async (value: any) => { request = value; return { ok: true }; } });
  assert.equal(report.provider.mode, 'gateway-token');
  assert.equal(request.mode, 'gateway-token');
});

test('canonical local registration clears ambient gateway URL and credential reference', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor');
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher], env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'local', LOCAL_LLM_API_URL: 'http://127.0.0.1:8080/v1', LOCAL_LLM_MODEL: 'fixture-model' } } } }));
  const report = await inspectInstallation({ home, env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: JSON.stringify({ store: 'native', service: 'stale', account: 'stale' }), LLM_GATEWAY_URL: 'https://stale.invalid/v1' }, performHealthProbe: false });
  assert.equal(report.provider.mode, 'local');
  assert.equal(report.provider.url, 'http://127.0.0.1:8080/v1');
  assert.equal(report.provider.credentialStore, 'none');
  assert.equal(report.provider.credentialReference, undefined);
});

test('antigravity plugin descriptor pointing at the global launcher is one logical registration', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'antigravity');
  const registration = { mcpServers: { token_optimizer: { command: 'node', args: [launcher] } } };
  write(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(registration));
  write(path.join(home, '.gemini', 'config', 'plugins', 'token-optimizer', 'mcp_config.json'), JSON.stringify(registration));
  const report = await inspectInstallation({ home, provider: 'local' });
  assert.equal(report.clients.registrations.filter((item: any) => item.client === 'antigravity').length, 1);
  assert.ok(!report.findings.some((item: any) => item.code === 'DUPLICATE_REGISTRATION' && item.client === 'antigravity'));
});

test('inactive codex marketplace cache is metadata and is not runtime-validated beside direct canonical registration', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'codex');
  write(path.join(home, '.codex', 'config.toml'), `[mcp_servers.token_optimizer]\ncommand = "node"\nargs = ["${launcher}"]\n`);
  const cache = path.join(home, '.codex', 'plugins', 'cache', 'Softaware-marketplace', 'token-optimizer', '2.0.2');
  write(path.join(cache, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'token-optimizer', version: '2.0.2' }));
  write(path.join(cache, 'server', 'start.js'), '');
  const report = await inspectInstallation({ home, provider: 'local', expectedVersion: '2.0.2' });
  assert.ok(!report.findings.some((item: any) => item.code === 'DEPENDENCY_CACHE_INCOMPLETE' && item.path?.startsWith(cache)));
});

test('local doctor performs quota-free GET /v1/models and reports a dead endpoint', async () => {
  let requested = '';
  const server = createServer((req, res) => { requested = req.url || ''; res.writeHead(200).end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address: any = server.address();
  try {
    const live = await inspectInstallation({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')), provider: 'local', providerUrl: `http://127.0.0.1:${address.port}/v1`, performHealthProbe: true });
    assert.equal(requested, '/v1/models'); assert.ok(!live.findings.some((item: any) => item.code === 'PROVIDER_UNREACHABLE'));
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  const dead = await inspectInstallation({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')), provider: 'local', providerUrl: 'http://127.0.0.1:1/v1', healthProbeTimeoutMs: 20, performHealthProbe: true });
  assert.ok(dead.findings.some((item: any) => item.code === 'PROVIDER_UNREACHABLE'));
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
  for (const code of ['STALE_REGISTRATION', 'VERSION_MISMATCH', 'MISSING_LAUNCHER', 'DEPENDENCY_CACHE_INCOMPLETE']) assert.ok(report.findings.some((item: any) => item.code === code), code);
  assert.ok(!report.findings.some((item: any) => item.code === 'DUPLICATE_REGISTRATION'), 'identical launcher identities collapse to one registration');
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
  const report = await inspectInstallation({ home, platform: 'darwin', provider: 'gateway-token', env: { LLM_GATEWAY_TOKEN: 'valid-token' }, execFileSync: () => { throw new Error('not loaded'); }, healthProbe: async () => ({ ok: true }) });
  for (const code of ['MANIFEST_HASH_MISMATCH', 'MANIFEST_SOURCE_UNAVAILABLE', 'LAUNCHCTL_MISMATCH']) assert.ok(report.findings.some((item: any) => item.code === code), code);
});

test('filesystem marketplace caches are discovered without executing client processes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const root = path.join(home, '.claude', 'plugins', 'cache', 'token-optimizer-marketplace', 'token-optimizer', '1.12.1');
  write(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'token-optimizer', version: '1.12.1' })); write(path.join(root, 'server', 'start.js'), '');
  let commands = 0; const report = await inspectInstallation({ home, provider: 'local', commandProbe: () => { commands++; throw new Error('must not run'); } });
  assert.equal(commands, 0); assert.ok(report.detectedVersions.some((item: any) => item.version === '1.12.1' && item.source === 'client-plugin-list'));
});

test('runtime validation resolves SDK server entrypoint and zod/v3 from launcher cache', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor'); write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher] } } }));
  const seen: string[] = []; const report = await inspectInstallation({ home, provider: 'local', resolveModule: (id: string, options: any) => { seen.push(id); return path.join(options.paths[0], id); } });
  assert.deepEqual(seen, ['@modelcontextprotocol/sdk/server/index.js', 'zod/v3']); assert.ok(!report.findings.some((item: any) => item.code === 'DEPENDENCY_CACHE_INCOMPLETE'));
});

test('manifest reports path escapes, symlinks, and non-files as stable findings', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const root = path.join(home, '.token-optimizer'); const outside = path.join(home, 'outside'); write(outside, 'x'); fs.mkdirSync(path.join(root, 'directory'), { recursive: true }); fs.symlinkSync(outside, path.join(root, 'link'));
  write(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, roots: [root], files: [{ path: outside, sha256: 'x', ownership: 'installer' }, { path: path.join(root, 'link'), sha256: 'x', ownership: 'installer' }, { path: path.join(root, 'directory'), sha256: 'x', ownership: 'installer' }] }));
  const report = await inspectInstallation({ home, provider: 'local' }); const codes = report.findings.map((item: any) => item.code);
  assert.ok(codes.includes('MANIFEST_PATH_ESCAPE')); assert.ok(codes.includes('MANIFEST_ENTRY_SYMLINK')); assert.ok(codes.includes('MANIFEST_ENTRY_NOT_FILE'));
});

test('manifest rejects declared filesystem roots and bounds entries before hashing', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const root = path.join(home, '.token-optimizer');
  write(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, roots: ['/'], files: [{ path: '/etc/hosts', sha256: 'x', ownership: 'installer' }] }));
  const tampered = await inspectInstallation({ home, provider: 'local' });
  assert.ok(tampered.findings.some((item: any) => item.code === 'MANIFEST_ROOT_UNTRUSTED'));
  assert.ok(tampered.findings.some((item: any) => item.code === 'MANIFEST_PATH_ESCAPE'));

  write(path.join(root, 'large'), '12345');
  write(path.join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 2, roots: [root], files: [{ path: path.join(root, 'large'), sha256: 'x', ownership: 'installer' }] }));
  const oversized = await inspectInstallation({ home, provider: 'local', manifestMaxFileBytes: 4 });
  assert.ok(oversized.findings.some((item: any) => item.code === 'MANIFEST_ENTRY_TOO_LARGE'));
});

test('explicit installed and detected versions take precedence without registrations', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-'));
  const installed = await inspectInstallation({ home, provider: 'local', installedVersion: '1.9.0', expectedVersion: '2.0.0-beta.5' });
  assert.equal(installed.installedVersion, '1.9.0'); assert.equal(installed.installedVersionSource, 'option-installed-version');
  assert.ok(installed.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
  const detected = await inspectInstallation({ home, provider: 'local', detectedVersion: '1.8.0', expectedVersion: '2.0.0-beta.5' });
  assert.equal(detected.installedVersion, '1.8.0'); assert.equal(detected.installedVersionSource, 'option-detected-version');
});

test('explicit installed version alone controls mismatch while discoveries remain metadata', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const launcher = server(home, 'cursor', '1.8.0');
  write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher] } } }));
  const expected = await inspectInstallation({ home, provider: 'local', installedVersion: '2.0.0-beta.5', expectedVersion: '2.0.0-beta.5' });
  assert.ok(expected.detectedVersions.some((item: any) => item.version === '1.8.0'));
  assert.ok(!expected.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
  const old = await inspectInstallation({ home, provider: 'local', installedVersion: '1.9.0', expectedVersion: '2.0.0-beta.5' });
  assert.ok(old.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
});

test('launchctl read diagnostics compare loaded service and exact managed values', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); write(path.join(home, 'Library', 'LaunchAgents', 'com.softawarest.token-optimizer.env.plist'), '<plist/>'); const launcher = server(home, 'cursor'); const ref = JSON.stringify({ store: 'macos-keychain', account: 'x' }); write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [launcher], env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: ref } } } }));
  const calls: string[][] = []; const exec = (_command: string, args: string[]) => { calls.push(args); if (args[0] === 'print') return 'loaded'; if (args[1] === 'TOKEN_OPTIMIZER_PROVIDER_MODE') return 'gateway-token\n'; return 'wrong\n'; };
  const report = await inspectInstallation({ home, platform: 'darwin', createCredentialStore: () => ({ get: () => 'token' }), execFileSync: exec });
  assert.ok(calls.some((args) => args[0] === 'print')); assert.ok(calls.some((args) => args[0] === 'getenv')); assert.ok(report.findings.some((item: any) => item.code === 'LAUNCHCTL_ENV_MISMATCH'));
});

test('workspace log diagnostics enforce quota and reject symlink roots', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-doctor-')); const workspace = path.join(home, 'workspace'); write(path.join(workspace, '.codex-local-test-runs', 'run.log'), '123456');
  const quota = await inspectInstallation({ home, workspace, provider: 'local', logQuotaBytes: 2 });
  assert.ok(quota.findings.some((item: any) => item.code === 'LOG_QUOTA_EXCEEDED'));
  fs.rmSync(path.join(workspace, '.codex-local-test-runs'), { recursive: true }); fs.symlinkSync(home, path.join(workspace, '.codex-local-test-runs'));
  const unsafe = await inspectInstallation({ home, workspace, provider: 'local' });
  assert.ok(unsafe.findings.some((item: any) => item.code === 'LOG_PATH_UNSAFE'));
});
