import test from 'node:test';
import assert from 'node:assert/strict';
const { planUninstall } = require('../../../packages/installer/lib/uninstall.js');
const { applyLifecyclePlan } = require('../../../packages/installer/lib/uninstall.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRegistrationAdapter, createFilesystemMarketplaceAdapter, createServiceAdapter, removeRegistration, removeRegistrationIdentity, upsertJsonProperty } = require('../../../packages/installer/lib/lifecycle-adapters.js');

test('uninstall emits a warning and preserves user-modified files', () => {
  const file = '/managed/user-edited';
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [{ path: file, sha256: 'installer', ownership: 'installer' }] };
  const plan = planUninstall(manifest, { hash: () => 'user' });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.warnings[0].code, 'USER_MODIFIED_FILE');
});

test('uninstall removes only the managed directive block', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-block-'));
  const file = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(file, `before\n<!-- TOKEN_OPTIMIZER_START -->\nmanaged\n<!-- TOKEN_OPTIMIZER_END -->\nafter\n`);
  const manifest = { schemaVersion: 2, roots: [home], files: [], managedBlocks: [{ path: file, marker: 'TOKEN_OPTIMIZER_START' }] };
  applyLifecyclePlan(planUninstall(manifest, {}));
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\nafter\n');
});

test('uninstall preserves a directive file changed after installation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-block-edit-'));
  const file = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(file, 'user edited\n<!-- TOKEN_OPTIMIZER_START -->\nmanaged\n<!-- TOKEN_OPTIMIZER_END -->\n');
  const manifest = { schemaVersion: 2, roots: [home], files: [], managedBlocks: [{ path: file, marker: 'TOKEN_OPTIMIZER_START', sha256: 'installer-hash' }] };
  const plan = planUninstall(manifest, { hash: () => 'changed-hash' });
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.warnings[0].code, 'USER_MODIFIED_BLOCK');
});

test('uninstall rolls back files when a later reversible registration fails', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-uninstall-rollback-'));
  const file = path.join(home, 'owned'); fs.writeFileSync(file, 'owned');
  const sha256 = require('node:crypto').createHash('sha256').update('owned').digest('hex');
  const manifest = { schemaVersion: 2, roots: [home], files: [{ path: file, sha256, ownership: 'installer' }], registrations: [{ client: 'codex', ownership: 'installer' }] };
  const adapter = { capture: () => ({ present: true }), apply: () => { throw new Error('fixture'); }, restore: () => {} };
  assert.throws(() => applyLifecyclePlan(planUninstall(manifest), { registrationAdapter: adapter }), /rolled back/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned');
});

test('uninstall fails closed before external state without a reversible adapter', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [], registrations: [{ client: 'claude', ownership: 'installer' }] };
  assert.throws(() => applyLifecyclePlan(planUninstall(manifest), { requireExternalAdapters: true }), /rolled back/);
});

test('marketplace registration adapter removes and re-adds Claude and Codex on rollback', () => {
  for (const client of ['claude', 'codex']) {
    const calls: any[] = []; const adapter = createRegistrationAdapter({ execFileSync: (...args: any[]) => calls.push(args) });
    const recipe = client === 'claude' ? { remove: ['plugin', 'uninstall', 'token'], restore: ['plugin', 'install', 'token'] } : { remove: ['plugin', 'remove', 'token'], restore: ['plugin', 'add', 'token'] };
    const operation = { kind: 'client-command', client, paths: [], recipe };
    const state = adapter.capture(operation); adapter.apply(operation); adapter.restore(operation, state);
    assert.deepEqual(calls.map((call) => call.slice(0, 2)), [[client, recipe.remove], [client, recipe.restore]]);
  }
});

test('JSON registration cleanup preserves comments, formatting, and unrelated servers', () => {
  for (const client of ['opencode', 'cursor', 'antigravity']) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'registration-bytes-')); const file = path.join(home, 'config.jsonc'); const container = client === 'opencode' ? 'mcp' : 'mcpServers'; const original = `{\n  // keep this comment\n  "${container}": {\n    "other": { "command": "keep" },\n    "token_optimizer": { "command": "remove" }\n  },\n  "untouched": true\n}\n`; fs.writeFileSync(file, original); removeRegistration(file, client); const actual = fs.readFileSync(file, 'utf8'); assert.ok(actual.includes('// keep this comment')); assert.ok(actual.includes('"other": { "command": "keep" }')); assert.ok(actual.includes('"untouched": true')); assert.ok(!actual.includes('token_optimizer')); }
});

test('JSON and JSONC registration upsert preserves every unrelated byte', () => {
  for (const container of ['mcp', 'mcpServers']) { const original = `{\n  // before\n  "${container}": {\n    "other": { "command": "keep" }, // inline\n    "token_optimizer": { "command": "old" }\n  },\n  "tail": [1, 2, 3]\n}\n`; const next = upsertJsonProperty(original, container, 'token_optimizer', { command: 'new' }); assert.ok(next.includes('// before')); assert.ok(next.includes('"other": { "command": "keep" }, // inline')); assert.ok(next.includes('"tail": [1, 2, 3]')); assert.ok(next.includes('"command":"new"') || next.includes('"command": "new"')); }
});

test('same-file JSON and TOML aliases remove only the noncanonical identity', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-identity-')); const json = path.join(home, 'mcp.json'); fs.writeFileSync(json, '{"mcpServers":{"token_optimizer":{"command":"keep"},"token-optimizer":{"command":"drop"},"other":{}}}'); removeRegistrationIdentity({ client: 'cursor', name: 'token-optimizer', path: json }); assert.ok(fs.readFileSync(json, 'utf8').includes('token_optimizer')); assert.ok(!fs.readFileSync(json, 'utf8').includes('token-optimizer'));
  const toml = path.join(home, 'config.toml'); fs.writeFileSync(toml, '[mcp_servers.token_optimizer]\ncommand="keep"\n\n[mcp_servers."token-optimizer"]\ncommand="drop"\n'); removeRegistrationIdentity({ client: 'codex', name: 'token-optimizer', path: toml }); const next = fs.readFileSync(toml, 'utf8'); assert.ok(next.includes('[mcp_servers.token_optimizer]')); assert.ok(!next.includes('[mcp_servers."token-optimizer"]'));
});

test('registration cleanup is scoped to MCP container and full TOML namespace', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-cleanup-')); const json = path.join(home, 'config.jsonc'); fs.writeFileSync(json, '{"token_optimizer":{"keep":true},"nested":{"mcpServers":{"token_optimizer":{"keep":true}}},"mcpServers":{"token_optimizer":{"drop":true},"other":{}}}'); removeRegistration(json, 'cursor'); const jsonText = fs.readFileSync(json, 'utf8'); assert.equal((jsonText.match(/token_optimizer/g) || []).length, 2); assert.ok(jsonText.includes('"other"'));
  const toml = path.join(home, 'config.toml'); fs.writeFileSync(toml, '# keep\n[mcp_servers."token-optimizer"]\ncommand="drop"\n[mcp_servers."token-optimizer".env]\nA="drop"\n[mcp_servers.other]\ncommand="keep"\n'); removeRegistrationIdentity({ client: 'codex', name: 'token-optimizer', path: toml }); const tomlText = fs.readFileSync(toml, 'utf8'); assert.ok(tomlText.includes('# keep')); assert.ok(tomlText.includes('[mcp_servers.other]')); assert.ok(!tomlText.includes('A="drop"'));
});

test('LaunchAgent permission failure leaves plist untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'launchagent-permission-')); const file = path.join(home, 'agent.plist'); fs.writeFileSync(file, 'owned');
  const adapter = createServiceAdapter({ execFileSync: (_cmd: string, args: string[]) => { if (args[0] === 'print') return ''; const error: any = new Error('Operation not permitted'); error.stderr = 'Operation not permitted'; throw error; } });
  const operation = { kind: 'platform-service', service: 'fixture', path: file };
  assert.throws(() => adapter.apply(operation), /permitted/); assert.equal(fs.readFileSync(file, 'utf8'), 'owned');
});

test('managed launchctl environment apply restores exact previous values', () => {
  const state: Record<string, string> = { TOKEN_OPTIMIZER_PROVIDER_MODE: 'previous' };
  const exec = (_cmd: string, args: string[]) => { if (args[0] === 'print') return ''; if (args[0] === 'getenv') return state[args[1]] || ''; if (args[0] === 'setenv') { state[args[1]] = args[2]; return ''; } if (args[0] === 'unsetenv') { delete state[args[1]]; return ''; } return ''; };
  const adapter = createServiceAdapter({ execFileSync: exec, services: [{ service: 'fixture', managedEnv: { TOKEN_OPTIMIZER_PROVIDER_MODE: 'local' } }] });
  const operation = { kind: 'platform-service', service: 'fixture', action: 'apply-managed-env', envKeys: ['TOKEN_OPTIMIZER_PROVIDER_MODE'] };
  const before = adapter.capture(operation); adapter.apply(operation); assert.equal(state.TOKEN_OPTIMIZER_PROVIDER_MODE, 'local'); adapter.restore(operation, before); assert.equal(state.TOKEN_OPTIMIZER_PROVIDER_MODE, 'previous');
});

test('marketplace normalization rollback restores the exact duplicate identity set', () => {
  const before = [{ version: '2.0.0-beta.6' }, { version: '2.0.0-beta.5' }, { version: '1.9.0' }]; let state = structuredClone(before); const marketplaceAdapter = { list: () => structuredClone(state), replace: (_client: string, next: any[]) => { state = structuredClone(next); } }; const adapter = createRegistrationAdapter({ marketplaceAdapter }); const operation = { kind: 'client-command', command: 'normalize-marketplace-registration', client: 'claude', paths: [], canonicalIdentity: before[0], recipe: { remove: ['remove'], restore: ['add'] } }; const captured = adapter.capture(operation); adapter.apply(operation); assert.deepEqual(state, [before[0]]); adapter.restore(operation, captured); assert.deepEqual(state, before);
});

test('marketplace normalization fails closed without exact state enumeration', () => {
  const plan = { schemaVersion: 2, operations: [{ kind: 'client-command', command: 'normalize-marketplace-registration', client: 'claude', paths: [], canonicalIdentity: { version: '2.0.0-beta.6' } }] };
  assert.throws(() => applyLifecyclePlan(plan, { registrationAdapter: createRegistrationAdapter() }), /rolled back/);
});

test('filesystem marketplace adapter restores exact version directories', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-fs-')); const root = path.join(home, '.claude', 'plugins', 'cache', 'token-optimizer-marketplace', 'token-optimizer'); for (const version of ['2.0.0-beta.6', '2.0.0-beta.5']) { fs.mkdirSync(path.join(root, version), { recursive: true }); fs.writeFileSync(path.join(root, version, 'marker'), version); } const marketplaceAdapter = createFilesystemMarketplaceAdapter(home); const adapter = createRegistrationAdapter({ marketplaceAdapter }); const operation = { kind: 'client-command', command: 'normalize-marketplace-registration', client: 'claude', paths: [], canonicalIdentity: { path: path.join(root, '2.0.0-beta.6'), version: '2.0.0-beta.6' } }; const captured = adapter.capture(operation); adapter.apply(operation); assert.deepEqual(fs.readdirSync(root), ['2.0.0-beta.6']); adapter.restore(operation, captured); assert.deepEqual(fs.readdirSync(root).sort(), ['2.0.0-beta.5', '2.0.0-beta.6']);
});
