import test from 'node:test';
import assert from 'node:assert/strict';
const { planRepair } = require('../../../packages/installer/lib/uninstall.js');

test('repair is scoped to actionable doctor findings', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assets = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-assets-')); fs.writeFileSync(path.join(assets, 'server'), 'x'); fs.writeFileSync(path.join(assets, 'skill'), 'y');
  const manifest = { schemaVersion: 2, roots: ['/managed', assets], assetRoots: [assets], files: [
    { path: '/managed/server', source: path.join(assets, 'server'), sha256: 'x', ownership: 'installer' },
    { path: '/managed/skill', source: path.join(assets, 'skill'), sha256: 'y', ownership: 'installer' },
  ] };
  const plan = planRepair({ findings: [{ code: 'MISSING_LAUNCHER', path: '/managed/server' }] }, manifest, { assetsRoot: assets });
  assert.deepEqual(plan.operations.map((item: any) => item.path), ['/managed/server']);
});

test('repair consumes stable operation hints and deduplicates exact external work', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed', '/assets'], files: [], registrations: [{ client: 'codex', canonicalPath: '/managed/config.toml', template: '[mcp_servers.token_optimizer]\ncommand = "node"', ownership: 'installer' }] };
  const plan = planRepair({ findings: [
    { code: 'STALE_REGISTRATION', client: 'codex', operation: 'rewrite-registration' },
    { code: 'STALE_REGISTRATION', client: 'codex', operation: 'rewrite-registration' },
    { code: 'PROVIDER_MISSING', operation: 'configure-provider' },
  ] }, manifest);
  assert.deepEqual(plan.operations, [{ kind: 'client-command', client: 'codex', command: 'upsert-registration', paths: [], canonicalPath: '/managed/config.toml', template: '[mcp_servers.token_optimizer]\ncommand = "node"', identity: { name: 'token_optimizer', type: 'direct', path: '/managed/config.toml' } }]);
});

test('repair removes an incomplete dependency cache so launcher bootstrap can rebuild it', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-runtime-')); const cache = path.join(root, '.data', 'node_modules');
  const manifest = { schemaVersion: 2, roots: [root], files: [] };
  const plan = planRepair({ findings: [{ code: 'DEPENDENCY_CACHE_INCOMPLETE', path: cache, operation: 'refresh-runtime' }] }, manifest, { managedRoots: [root] });
  assert.deepEqual(plan.operations, [{ kind: 'remove-file', path: cache }]);
  assert.throws(() => planRepair({ findings: [{ code: 'DEPENDENCY_CACHE_INCOMPLETE', path: '/tmp/arbitrary/.data/node_modules', operation: 'refresh-runtime' }] }, manifest, { managedRoots: [root] }), /outside managed roots/);
});

test('duplicate repair honors marketplace canonical and does not upsert direct', () => {
  const manifest = { schemaVersion: 2, roots: ['/managed'], files: [], registrations: [{ client: 'codex', canonicalPath: '/managed/config.toml', template: '[mcp_servers.token_optimizer]\ncommand="node"', ownership: 'installer' }, { client: 'codex', kind: 'marketplace', remove: ['plugin', 'remove'], restore: ['plugin', 'add'], ownership: 'installer' }] };
  const finding = { code: 'DUPLICATE_REGISTRATION', client: 'codex', operation: 'deduplicate-registration', canonical: { client: 'codex', name: 'token-optimizer', type: 'marketplace', path: '/cache/plugin', version: '2.0.0-beta.6' }, registrations: [{ client: 'codex', name: 'token-optimizer', type: 'marketplace', path: '/cache/plugin' }, { client: 'codex', name: 'token_optimizer', type: 'direct', path: '/managed/config.toml', stale: true }] };
  const plan = planRepair({ findings: [finding] }, manifest);
  assert.equal(plan.operations.some((item: any) => item.command === 'upsert-registration'), false);
  assert.equal(plan.operations[0].command, 'remove-registration-identity');
});
