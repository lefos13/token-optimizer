import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../packages/installer/lib/install-core.js');

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
