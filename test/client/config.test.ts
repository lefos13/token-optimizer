import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfigFile, resolveEffectiveConfig } from '../../src/config';

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
  if (process.platform !== 'win32') fs.chmodSync(path.join(home, 'config.json'), 0o600);
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

test('effective provider configuration selects each documented destination', () => {
  const cases = [
    [{ TOKEN_OPTIMIZER_PROVIDER_MODE: 'local', LOCAL_LLM_API_URL: 'http://local/v1' }, 'local', 'http://local/v1'],
    [{ TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', LLM_GATEWAY_URL: 'https://gateway/v1', LLM_GATEWAY_TOKEN: 'token' }, 'gateway-token', 'https://gateway/v1'],
    [{ TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-byok', LLM_GATEWAY_URL: 'https://gateway/v1', OPENROUTER_BYOK_KEY: 'byok' }, 'gateway-byok', 'https://gateway/v1'],
    [{ TOKEN_OPTIMIZER_PROVIDER_MODE: 'openrouter-direct', OPENROUTER_API_KEY: 'direct' }, 'openrouter-direct', 'https://openrouter.ai/api/v1'],
  ] as const;
  for (const [env, mode, apiUrl] of cases) {
    const config = resolveEffectiveConfig({ env });
    assert.equal(config.provider.mode, mode);
    assert.equal(config.provider.apiUrl, apiUrl);
  }
});

test('user provider policy binds credential-bearing destination against lower-trust redirects', () => {
  const config = resolveEffectiveConfig({
    env: { LLM_GATEWAY_TOKEN: 'runtime-secret', OPENROUTER_API_KEY: 'other-secret' },
    user: { provider: { mode: 'gateway-token', apiUrl: 'https://approved/v1', model: 'approved-model' }, execution: { profile: 'standard' }, logs: { retentionDays: 3, maxDiskMb: 100, storageMode: 'redacted-local' } },
    project: { provider: { mode: 'openrouter-direct', apiUrl: 'https://project/v1' }, execution: { profile: 'unrestricted' }, logs: { retentionDays: 2, maxDiskMb: 1000, storageMode: 'raw-local' } },
    tool: { provider: { mode: 'openrouter-direct', apiUrl: 'https://tool/v1', model: 'tool-model' }, execution: { profile: 'safe' }, logs: { retentionDays: 30, maxDiskMb: 50 } },
  });
  assert.equal(config.provider.mode, 'gateway-token');
  assert.equal(config.provider.apiUrl, 'https://approved/v1');
  assert.equal(config.provider.model, 'approved-model');
  assert.equal(config.execution.profile, 'safe');
  assert.deepEqual(config.logs, { retentionDays: 2, maxDiskMb: 50, storageMode: 'redacted-local' });
  assert.match(config.warnings.join('\n'), /lower-trust provider/i);
});

test('provider task routing remains user-authoritative and redaction rules accumulate', () => {
  const config = resolveEffectiveConfig({
    user: { provider: { mode: 'local', taskRouting: { verdict: 'model/verdict' } }, redaction: { rules: [{ pattern: 'USER-[0-9]+', category: 'user' }] } },
    project: { provider: { taskRouting: { verdict: 'evil/model' } }, redaction: { rules: [{ pattern: 'PROJECT-[0-9]+', category: 'project' }] } },
    tool: { redaction: { rules: [{ pattern: 'TOOL-[0-9]+', category: 'tool' }] } },
  });
  assert.equal(config.provider.taskRouting?.verdict, 'model/verdict');
  assert.deepEqual(config.redaction.rules.map((rule) => rule.category), ['user', 'project', 'tool']);
});

test('project config rejects symlink escape', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-project-'));
  const outside = path.join(os.tmpdir(), `token-optimizer-outside-${process.pid}.json`);
  fs.writeFileSync(outside, '{}');
  fs.symlinkSync(outside, path.join(workspace, '.token-optimizer.json'));
  assert.throws(() => resolveEffectiveConfig({ workspacePath: workspace, env: { TOKEN_OPTIMIZER_CONFIG_HOME: path.join(workspace, 'missing') } }), /symbolic link/i);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test('generic config loader rejects a caller-supplied path outside its root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-root-'));
  const outside = path.join(os.tmpdir(), `token-optimizer-external-${process.pid}.json`);
  fs.writeFileSync(outside, '{}');
  assert.throws(() => loadConfigFile(outside, root), /escapes/i);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test('authoritative user config rejects broad permissions and oversized files', () => {
  if (process.platform === 'win32') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-user-'));
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, '{}', { mode: 0o644 });
  assert.throws(() => resolveEffectiveConfig({ env: { TOKEN_OPTIMIZER_CONFIG_HOME: home } }), /permissions/i);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, ' '.repeat(70_000));
  assert.throws(() => resolveEffectiveConfig({ env: { TOKEN_OPTIMIZER_CONFIG_HOME: home } }), /too large/i);
  fs.rmSync(home, { recursive: true, force: true });
});
