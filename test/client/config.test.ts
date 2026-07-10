import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveEffectiveConfig } from '../../src/config';

test('project config cannot elevate a safe user ceiling', () => {
  const config = resolveEffectiveConfig({
    user: { execution: { profile: 'safe' } },
    project: { execution: { profile: 'unrestricted' } },
  });
  assert.equal(config.execution.profile, 'safe');
  assert.match(config.warnings.join('\n'), /cannot elevate/i);
});

test('legacy BYOK maps to gateway-byok without changing destination', () => {
  const config = resolveEffectiveConfig({
    env: { LLM_GATEWAY_URL: 'https://gateway.example/v1', OPENROUTER_BYOK_KEY: 'secret-ref' },
  });
  assert.equal(config.provider.mode, 'gateway-byok');
  assert.match(config.warnings.join('\n'), /legacy/i);
});

test('user config loads without a workspace path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-config-'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ execution: { profile: 'standard' } }));
  const config = resolveEffectiveConfig({ env: { TOKEN_OPTIMIZER_CONFIG_HOME: home } });
  assert.equal(config.execution.profile, 'standard');
  fs.rmSync(home, { recursive: true, force: true });
});

test('invalid provider mode falls back conservatively with a warning', () => {
  const config = resolveEffectiveConfig({ env: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'not-a-provider', LLM_GATEWAY_URL: 'https://gateway.example/v1', LLM_GATEWAY_TOKEN: 'token', OPENROUTER_BYOK_KEY: 'secret', OPENROUTER_API_KEY: 'direct' } });
  assert.equal(config.provider.mode, 'local');
  assert.match(config.warnings.join('\n'), /invalid.*provider mode/i);
});

test('gateway token environment infers legacy gateway-token when mode is absent', () => {
  const config = resolveEffectiveConfig({ env: { LLM_GATEWAY_URL: 'https://gateway.example/v1', LLM_GATEWAY_TOKEN: 'token' } });
  assert.equal(config.provider.mode, 'gateway-token');
  assert.match(config.warnings.join('\n'), /legacy/i);
});

test('lower-trust allowlists cannot widen the user allowlist', () => {
  const config = resolveEffectiveConfig({
    user: { execution: { allowedCommandPrefixes: ['npm test'] } },
    project: { execution: { allowedCommandPrefixes: ['npm test', 'npm run build'] } },
  });
  assert.deepEqual(config.execution.allowedCommandPrefixes, ['npm test']);
});
