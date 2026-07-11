import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../packages/installer/lib/install-core.js');
const migration = require('../../../packages/installer/lib/migration.js');

const clients = ['claude', 'codex', 'antigravity', 'opencode', 'cursor'];
const v1Layouts: Record<string, [string, string]> = {
  claude: ['.claude/settings.json', JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } })],
  codex: ['.codex/config.toml', '[mcp_servers.token_optimizer.env]\nLOCAL_LLM_API_URL = "http://localhost:8080/v1"\n'],
  antigravity: ['.gemini/config/mcp_config.json', JSON.stringify({ mcpServers: { token_optimizer: { env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } } } })],
  opencode: ['.config/opencode/opencode.jsonc', JSON.stringify({ mcp: { token_optimizer: { environment: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } } } })],
  cursor: ['.cursor/mcp.json', JSON.stringify({ mcpServers: { token_optimizer: { env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } } } })],
};

for (const client of clients) {
  test(`detectV1State and migrateInstallation exercise the real ${client} v1 layout`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `migration-real-${client}-`));
    const [relative, contents] = v1Layouts[client];
    const legacy = path.join(home, relative);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, contents);
    const detected = migration.detectV1State({ home, clients: ['detected'] });
    assert.deepEqual(detected.clients, [client]);
    assert.equal(detected.env.LOCAL_LLM_API_URL, 'http://localhost:8080/v1');
    const result = await migration.migrateInstallation({ home, clients: ['detected'], provider: 'local', skipClientCommands: true, skipLaunchctl: true });
    assert.equal(result.status, 'migrated');
    assert.deepEqual(result.plan.clients, [client]);
  });
}

for (const client of clients) {
  test(`migration v1 BYOK preserves destination and applies idempotently for ${client}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `migration-${client}-`));
    const plan = installer.planMigration({ env: { LLM_GATEWAY_URL: 'https://legacy.example/v1', OPENROUTER_BYOK_KEY: 'secret' }, client }, {});
    assert.equal(plan.effectiveProvider.mode, 'gateway-byok');
    assert.equal(plan.effectiveProvider.apiUrl, 'https://legacy.example/v1');
    assert.match(plan.warnings.join('\n'), /gateway/i);
    const options = { home, clients: [client], provider: 'gateway-byok', gatewayUrl: 'https://legacy.example/v1', byokKey: 'secret', credentialRef: { store: 'config', service: 'token-optimizer', account: client }, skipLaunchctl: true };
    installer.applyGatewayConfig(options);
    const list = () => fs.readdirSync(home, { recursive: true }).filter((f: any) => !String(f).startsWith('.token-optimizer-mcp')).sort();
    const snapshot = JSON.stringify(list().map((f: any) => [f, fs.statSync(path.join(home, f)).isFile() ? fs.readFileSync(path.join(home, f), 'utf8') : '']));
    installer.applyGatewayConfig(options);
    const second = JSON.stringify(list().map((f: any) => [f, fs.statSync(path.join(home, f)).isFile() ? fs.readFileSync(path.join(home, f), 'utf8') : '']));
    assert.equal(second, snapshot);
    const files = fs.readdirSync(home, { recursive: true }).filter((f: any) => /settings\.json|config\.toml|mcp_config|opencode\.jsonc|mcp\.json/.test(f));
    assert.ok(files.length > 0 || client === 'codex', `expected a ${client} config destination`);
    assert.equal(installer.planMigration({ env: { LLM_GATEWAY_URL: 'https://legacy.example/v1', OPENROUTER_BYOK_KEY: 'secret' }, client }, {}).effectiveProvider.apiUrl, 'https://legacy.example/v1');
  });
}

test('migration emits explicit cleanup and never stores a raw credential', () => {
  const plan = installer.planMigration({ LLM_GATEWAY_URL: 'https://g/v1', OPENROUTER_BYOK_KEY: 'secret' }, { credentialRef: { store: 'config', service: 'token-optimizer', account: 'tester' } });
  assert.ok(plan.operations.some((op: any) => op.id === 'cleanup:legacy-provider-env'));
  assert.doesNotMatch(JSON.stringify(plan), /secret/);
});

test('invalid explicit provider fails closed even when credentials are present', () => {
  assert.throws(() => installer.buildProviderValues({ provider: 'invalid', gatewayToken: 'secret' }), /Unsupported provider mode/);
});

test('migration dry-run matches apply plan and leaves fixture state untouched', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-dry-run-'));
  const legacy = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ mcp: { token_optimizer: { environment: { LLM_GATEWAY_URL: 'https://legacy.example/v1', OPENROUTER_BYOK_KEY: 'fixture-secret' } } } }));
  const before = fs.readFileSync(legacy, 'utf8');
  const preview = migration.planMigrationFromHome({ home, clients: ['opencode'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true });
  assert.doesNotMatch(JSON.stringify(preview), /fixture-secret/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  const result = await migration.migrateInstallation({ home, clients: ['opencode'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, healthProbe: async () => ({ ok: true }) });
  assert.deepEqual(result.plan.operations.map((operation: any) => operation.id), preview.operations.map((operation: any) => operation.id));
  assert.deepEqual(result.appliedOperationIds, preview.operations.map((operation: any) => operation.id));
  assert.equal(result.status, 'migrated');
  assert.equal(fs.statSync(result.backup.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.backup.manifestPath).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  assert.doesNotMatch(fs.readFileSync(legacy, 'utf8'), /fixture-secret/);
  assert.deepEqual(result.appliedOperationIds.slice(-2), ['migrate:manifest', 'migrate:completion-marker']);
});

test('JSONC and quoted TOML cleanup preserve comments, formatting, unrelated text, and file modes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-preserve-'));
  const jsonc = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  const toml = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(jsonc), { recursive: true });
  fs.mkdirSync(path.dirname(toml), { recursive: true });
  fs.writeFileSync(jsonc, '{\n  // keep this comment\n  "note": "fixture-secret stays",\n  "mcp": { "token_optimizer": { "environment": { "OPENROUTER_BYOK_KEY": "fixture-secret", "LLM_GATEWAY_URL": "https://legacy.example/v1" } } },\n}\n', { mode: 0o640 });
  fs.writeFileSync(toml, '# keep toml comment\n"LLM_GATEWAY_TOKEN" = "fixture-secret"\nLOCAL_LLM_MODEL = "custom"\n', { mode: 0o640 });
  await migration.migrateInstallation({ home, clients: ['opencode', 'codex'], provider: 'gateway-byok', credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, healthProbe: async () => ({ ok: true }) });
  const jsoncAfter = fs.readFileSync(jsonc, 'utf8');
  const tomlAfter = fs.readFileSync(toml, 'utf8');
  assert.match(jsoncAfter, /keep this comment/);
  assert.match(jsoncAfter, /fixture-secret stays/);
  assert.doesNotMatch(jsoncAfter, /OPENROUTER_BYOK_KEY\s*:/);
  assert.match(tomlAfter, /keep toml comment/);
  assert.match(tomlAfter, /LOCAL_LLM_MODEL = "custom"/);
  assert.doesNotMatch(tomlAfter, /LLM_GATEWAY_TOKEN/);
  assert.equal(fs.statSync(jsonc).mode & 0o777, 0o640);
  assert.equal(fs.statSync(toml).mode & 0o777, 0o640);
});

test('registration transaction registers its inverse before mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-registration-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
  const events: string[] = [];
  await assert.rejects(() => migration.migrateInstallation({
    home, clients: ['claude'], provider: 'local', skipLaunchctl: true,
    clientRegistrationAdapter: { prepare: () => ({ apply: () => { events.push('apply'); throw new Error('registration failure'); }, rollback: () => { events.push('rollback'); } }) },
  }), /registration failure/);
  assert.deepEqual(events, ['apply', 'rollback']);
  assert.equal(fs.readFileSync(legacy, 'utf8'), JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
});

for (const failedId of ['cleanup:legacy-provider-env', 'migrate:manifest']) {
  test(`${failedId} failure restores cursor legacy state`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-late-failure-'));
    const legacy = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: { LLM_GATEWAY_TOKEN: 'fixture-secret' } } } }));
    const before = fs.readFileSync(legacy, 'utf8');
    await assert.rejects(() => migration.migrateInstallation({
      home, clients: ['cursor'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true,
      healthProbe: async () => ({ ok: true }),
      beforeOperation: (operation: any) => { if (operation.id === failedId) throw new Error(`simulated ${failedId}`); },
    }), new RegExp(failedId));
    assert.equal(fs.readFileSync(legacy, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(home, '.token-optimizer', 'migration-v2.json')), false);
  });
}

test('service transaction captures rollback before a partial apply failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-service-'));
  const legacy = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } } } }));
  const events: string[] = [];
  await assert.rejects(() => migration.migrateInstallation({
    home, clients: ['cursor'], provider: 'local', skipClientCommands: true,
    serviceTransactionAdapter: { prepare: () => ({ apply: () => { events.push('partial-apply'); throw new Error('service failure'); }, rollback: () => { events.push('restore-exact-state'); } }) },
  }), /service failure/);
  assert.deepEqual(events, ['partial-apply', 'restore-exact-state']);
});

test('missing Claude registration adapter fails preflight before backup or mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-registration-preflight-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LLM_GATEWAY_TOKEN: 'fixture-preflight-secret' } }));
  const before = fs.readFileSync(legacy, 'utf8');
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['claude'], credentialStore: 'config', skipLaunchctl: true }), /skip-client-commands/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, '.token-optimizer-mcp', 'backups')), false);
  assert.equal(fs.existsSync(path.join(home, '.token-optimizer', 'credentials.json')), false);
});

test('missing Darwin service adapter fails preflight before backup or mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-service-preflight-'));
  const legacy = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } } } }));
  const before = fs.readFileSync(legacy, 'utf8');
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['cursor'], provider: 'local', platform: 'darwin', skipClientCommands: true }), /skip-launchctl/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, '.token-optimizer-mcp', 'backups')), false);
});

test('migration result and rejection redact provider and authorization secrets', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-error-redaction-'));
  const legacy = path.join(home, '.cursor', 'mcp.json');
  const secret = 'sk-or-v1-fixture-redaction';
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: { LLM_GATEWAY_URL: 'https://gateway.test/v1', LLM_GATEWAY_TOKEN: secret } } } }));
  const failWithSecret = (operation: any) => { if (operation.id === 'migrate:doctor') throw new Error(`Authorization: Bearer ${secret}; raw=${secret}`); };
  const plan = migration.planMigrationFromHome({ home, clients: ['cursor'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, beforeOperation: failWithSecret });
  const direct = await installer.applyChangePlan(plan);
  assert.ok(direct.error);
  assert.doesNotMatch(direct.error.message, new RegExp(secret));
  assert.match(direct.error.message, /REDACTED/);
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['cursor'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, beforeOperation: failWithSecret }), (error: any) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

for (const fixture of [
  { mode: 'gateway-token', env: { LLM_GATEWAY_URL: 'https://gateway.test/v1', LLM_GATEWAY_TOKEN: 'secret' }, header: 'Authorization' },
  { mode: 'gateway-byok', env: { LLM_GATEWAY_URL: 'https://gateway.test/v1', OPENROUTER_BYOK_KEY: 'secret' }, header: 'X-OpenRouter-Key' },
  { mode: 'openrouter-direct', env: { OPENROUTER_API_KEY: 'secret' }, header: 'Authorization' },
  { mode: 'local', env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } },
  { mode: 'skip', env: {} },
]) {
  test(`provider apply matrix migrates ${fixture.mode}`, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `migration-provider-${fixture.mode}-`));
    const legacy = path.join(home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: fixture.env } } }));
    let request: any;
    const result = await migration.migrateInstallation({ home, clients: ['cursor'], provider: fixture.mode, credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, healthProbe: async (_url: string, details: any) => { request = details; return { ok: true }; } });
    assert.equal(result.status, 'migrated');
    assert.equal(result.plan.effectiveProvider.mode, fixture.mode);
    if (fixture.header) assert.ok(request.headers[fixture.header]);
    else assert.equal(request, undefined);
  });
}

test('the exact preview plan is executable and authenticates the migrated credential', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-exact-plan-'));
  const legacy = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({
    note: 'fixture-secret remains ordinary user content',
    mcpServers: { token_optimizer: { env: { LLM_GATEWAY_URL: 'https://legacy.example/v1', LLM_GATEWAY_TOKEN: 'fixture-secret' } } },
  }));
  let probe: any;
  const plan = migration.planMigrationFromHome({
    home,
    clients: ['cursor'],
    credentialStore: 'config',
    skipClientCommands: true,
    skipLaunchctl: true,
    healthProbe: async (url: string, request: any) => { probe = { url, request }; return { ok: true }; },
  });
  const result = await installer.applyChangePlan(plan);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.applied.map((operation: any) => operation.id), plan.operations.map((operation: any) => operation.id));
  assert.equal(probe.request.mode, 'gateway-token');
  assert.equal(probe.request.headers.Authorization, 'Bearer fixture-secret');
  const migrated = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  assert.equal(migrated.note, 'fixture-secret remains ordinary user content');
  assert.equal(migrated.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, undefined);
  assert.equal(migrated.mcpServers.token_optimizer.env.LLM_GATEWAY_URL, 'https://legacy.example/v1');
});

test('failed post-migration doctor restores legacy files and credential state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-rollback-'));
  const legacy = path.join(home, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ mcpServers: { token_optimizer: { env: { LLM_GATEWAY_TOKEN: 'fixture-secret' } } } }));
  const before = fs.readFileSync(legacy, 'utf8');
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['cursor'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, healthProbe: async () => ({ ok: false }) }), /doctor/i);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  const credentialFile = path.join(home, '.token-optimizer', 'credentials.json');
  assert.equal(fs.existsSync(credentialFile) ? fs.readFileSync(credentialFile, 'utf8').includes('fixture-secret') : false, false);
});

test('repeated migration is idempotent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-repeat-'));
  const legacy = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '[mcp_servers.token_optimizer.env]\nLOCAL_LLM_API_URL = "http://localhost:8080/v1"\n');
  const options = { home, clients: ['codex'], credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, healthProbe: async () => ({ ok: true }) };
  assert.equal((await migration.migrateInstallation(options)).status, 'migrated');
  assert.equal((await migration.migrateInstallation(options)).status, 'already-migrated');
});

test('native-store failure rolls back without exposing or deleting the legacy secret', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-native-failure-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LLM_GATEWAY_TOKEN: 'fixture-secret' } }));
  const before = fs.readFileSync(legacy, 'utf8');
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['claude'], credentialStore: 'native', credentialStoreOptions: { platform: 'unsupported' }, skipClientCommands: true, skipLaunchctl: true }), /rolled back/i);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
});

test('detection and cleanup never inspect unrelated files below a client root', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-allowlist-'));
  const config = path.join(home, '.claude', 'settings.json');
  const conversation = path.join(home, '.claude', 'conversation.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
  fs.writeFileSync(conversation, '{"message":"LLM_GATEWAY_TOKEN = conversation-secret"}\n');
  const before = fs.readFileSync(conversation);
  const state = migration.detectV1State({ home, clients: ['claude'] });
  assert.deepEqual(state.files, [config]);
  await migration.migrateInstallation({ home, clients: ['claude'], provider: 'local', skipClientCommands: true, skipLaunchctl: true });
  assert.deepEqual(fs.readFileSync(conversation), before);
});

test('async adapter preparation is awaited and validated before apply', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-async-prepare-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
  const events: string[] = [];
  const result = await migration.migrateInstallation({ home, clients: ['claude'], provider: 'local', skipLaunchctl: true, clientRegistrationAdapter: { prepare: async () => { await Promise.resolve(); events.push('prepared'); return { apply: () => events.push('applied'), rollback: () => events.push('rolled-back') }; } } });
  assert.equal(result.status, 'migrated');
  assert.deepEqual(events, ['prepared', 'applied']);
});

test('invalid async adapter shape fails before registration mutation', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-invalid-adapter-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
  const before = fs.readFileSync(legacy, 'utf8');
  await assert.rejects(() => migration.migrateInstallation({ home, clients: ['claude'], provider: 'local', skipLaunchctl: true, clientRegistrationAdapter: { prepare: async () => ({ apply: () => undefined }) } }), /apply, rollback/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, '.token-optimizer-mcp', 'backups')), false);
});

test('public CLI migration works without external command or launchctl adapters and reports follow-up', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-cli-default-'));
  const legacy = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ env: { LOCAL_LLM_API_URL: 'http://localhost:8080/v1' } }));
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../../packages/installer/bin/token-optimizer.js'), 'install', '--migrate', '--provider', 'local', '--clients', 'claude', '--home', home, '--skip-update-check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migrated Token Optimizer/);
  assert.match(result.stdout, /Follow-up:/);
  assert.equal(fs.existsSync(path.join(home, '.token-optimizer', 'migration-v2.json')), true);
});
