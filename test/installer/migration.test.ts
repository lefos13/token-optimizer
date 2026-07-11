import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../packages/installer/lib/install-core.js');
const migration = require('../../../packages/installer/lib/migration.js');

const clients = ['claude', 'codex', 'antigravity', 'opencode', 'cursor'];
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
