import test from 'node:test';
import assert from 'node:assert/strict';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../packages/installer/lib/install-core.js');

const clients = ['claude', 'codex', 'antigravity', 'opencode', 'cursor'];
for (const client of clients) {
  test(`v1 BYOK preserves gateway destination for ${client}`, () => {
    const plan = installer.planMigration({ env: { LLM_GATEWAY_URL: 'https://legacy.example/v1', OPENROUTER_BYOK_KEY: 'secret' }, client }, {});
    assert.equal(plan.effectiveProvider.mode, 'gateway-byok');
    assert.equal(plan.effectiveProvider.apiUrl, 'https://legacy.example/v1');
    assert.match(plan.warnings.join('\n'), /gateway/i);
    assert.equal(installer.planMigration({ env: { LLM_GATEWAY_URL: 'https://legacy.example/v1', OPENROUTER_BYOK_KEY: 'secret' }, client }, {}).effectiveProvider.apiUrl, 'https://legacy.example/v1');
  });
}

test('migration emits explicit cleanup and never stores a raw credential', () => {
  const plan = installer.planMigration({ LLM_GATEWAY_URL: 'https://g/v1', OPENROUTER_BYOK_KEY: 'secret' }, { credentialRef: { store: 'config', service: 'token-optimizer', account: 'tester' } });
  assert.ok(plan.operations.some((op: any) => op.id === 'cleanup:legacy-provider-env'));
  assert.doesNotMatch(JSON.stringify(plan), /secret/);
});
