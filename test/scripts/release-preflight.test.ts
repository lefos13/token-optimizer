import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..', '..', '..');
const { validateReleaseTag, inspectInventory, validateCycloneDx, inspectTrackedFiles } = require('../../../scripts/release-policy');
const { PreflightFailure, runPreflight } = require('../../../scripts/release-preflight');

test('tag policy reports stable machine codes and never maps prerelease to latest', () => {
  assert.deepEqual(validateReleaseTag('2.0.0', undefined), { code: 'TAG_REQUIRED' });
  assert.equal(validateReleaseTag('2.0.0', undefined, true).warning, 'NO_RELEASE_TAG');
  assert.deepEqual(validateReleaseTag('2.0.0', 'v2.0.1'), { code: 'TAG_VERSION_MISMATCH' });
  assert.deepEqual(validateReleaseTag('2.0.0-preview.1', 'v2.0.0-preview.1'), { code: 'TAG_POLICY_REJECTED' });
  assert.equal(validateReleaseTag('2.0.0', 'v2.0.0').distTag, 'latest');
  for (const channel of ['alpha', 'beta', 'rc']) assert.equal(validateReleaseTag(`2.0.0-${channel}.1`, `v2.0.0-${channel}.1`).distTag, channel);
});

test('package inventory rejects forbidden paths and secrets in bounded content', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-inventory-'));
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  for (const file of ['LICENSE', 'NOTICE', 'README.md']) fs.writeFileSync(path.join(directory, file), 'safe');
  fs.mkdirSync(path.join(directory, 'dist')); fs.writeFileSync(path.join(directory, 'dist/index.js'), 'safe');
  const base = ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/index.js'].map(path => ({ path }));
  assert.doesNotThrow(() => inspectInventory({ files: base }, directory, 'root'));
  assert.throws(() => inspectInventory({ files: [...base, { path: 'node_modules/x.js' }] }, directory, 'root'), /PACKAGE_INVENTORY_REJECTED/);
  fs.writeFileSync(path.join(directory, 'dist/index.js'), '-----BEGIN PRIVATE' + ' KEY-----');
  assert.throws(() => inspectInventory({ files: base }, directory, 'root'), /PACKAGE_SECRET_REJECTED/);
});

test('schema validator rejects missing and structurally plausible invalid SBOMs', () => {
  assert.equal(validateCycloneDx(undefined), false);
  assert.equal(validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'x', version: 1, metadata: { timestamp: 'not-a-date', component: {} }, components: [] }), false);
  assert.equal(validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ type: 'plausible-but-invalid', name: 'x', version: '1' }] }), false);
});

test('tracked repository scan rejects a committed high-confidence secret', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tracked-secret-'));
  fs.writeFileSync(path.join(directory, 'config.txt'), 'api_' + 'key="abcdefgh' + 'ijklmnop' + 'qrstuvwxyz123456"\n');
  assert.throws(() => inspectTrackedFiles(directory, ['config.txt']), /REPOSITORY_SECRET_REJECTED:config\.txt/);
  fs.writeFileSync(path.join(directory, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
  assert.doesNotThrow(() => inspectTrackedFiles(directory, ['binary.bin']));
});

test('generated drift returns stable JSON code and restores a tracked tree', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-drift-'));
  fs.mkdirSync(path.join(directory, 'scripts')); fs.copyFileSync(path.join(root, 'scripts', 'verify-generated-assets.js'), path.join(directory, 'scripts', 'verify-generated-assets.js'));
  fs.mkdirSync(path.join(directory, 'plugin', 'codex'), { recursive: true }); fs.writeFileSync(path.join(directory, 'plugin/codex/value.txt'), 'before\n');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ scripts: { 'build:installer': "node -e \"require('fs').writeFileSync('plugin/codex/value.txt','after\\n')\"" } }));
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: directory }).status, 0);
  const result = spawnSync(process.execPath, ['scripts/verify-generated-assets.js'], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 21); assert.match(result.stderr, /"code":"GENERATED_ASSET_DRIFT"/);
  assert.equal(fs.readFileSync(path.join(directory, 'plugin/codex/value.txt'), 'utf8'), 'before\n');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' }).stdout, '');
});

/*
 * Real repository contents exercise version and inventory policy while injected
 * process adapters make every external outcome deterministic and side-effect free.
 */
function adapters(overrides: Record<string, unknown> = {}) {
  const sbom = JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', version: 1, metadata: { component: { type: 'application', name: 'fixture', version: '1' } } });
  const inventory = (kind: string) => kind === 'root'
    ? ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/index.js']
    : ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'bin/token-optimizer.js'];
  return {
    env: { RELEASE_TAG: 'v2.0.0-beta.11', RELEASE_ARTIFACT_DIR: `release-artifacts/test-${process.pid}-${Math.random()}`, PREFLIGHT_ALLOW_DIRTY: '1' },
    argv: [],
    run: (command: string, args: string[]) => ({ status: 0, stdout: command === 'git' && args[0] === 'ls-files' ? '' : '', stderr: '' }),
    commands: {
      sbom: () => ({ status: 0, stdout: sbom, stderr: '' }), generated: () => ({ status: 0, stdout: '', stderr: '' }),
      audit: () => ({ status: 0, stdout: '', stderr: '' }),
      pack: (kind: string) => ({ status: 0, stdout: JSON.stringify([{ files: inventory(kind).map(file => ({ path: file })) }]), stderr: '' }),
    },
    ...overrides,
  };
}

test('runPreflight returns stable success JSON and derives prerelease dist tag', () => {
  assert.deepEqual(runPreflight(root, adapters()), { ok: true, code: 'RELEASE_PREFLIGHT_PASSED', version: '2.0.0-beta.11', distTag: 'beta', warnings: [], artifacts: ['root.cdx.json', 'installer.cdx.json'] });
});

test('runPreflight reports deterministic command and SBOM failure codes', () => {
  const cases = [
    ['AUDIT_POLICY_FAILED', { commands: { ...adapters().commands, audit: () => ({ status: 1, stdout: 'high vulnerability', stderr: '' }) } }],
    ['ROOT_PACK_FAILED', { commands: { ...adapters().commands, pack: (kind: string) => ({ status: kind === 'root' ? 1 : 0, stdout: '[]', stderr: 'pack failed' }) } }],
    ['SBOM_GENERATION_FAILED', { commands: { ...adapters().commands, sbom: () => ({ status: 1, stdout: '', stderr: 'failed' }) } }],
    ['SBOM_INVALID_JSON', { commands: { ...adapters().commands, sbom: () => ({ status: 0, stdout: '{', stderr: '' }) } }],
    ['SBOM_SCHEMA_INVALID', { commands: { ...adapters().commands, sbom: () => ({ status: 0, stdout: '{}', stderr: '' }) } }],
  ];
  for (const [code, override] of cases) assert.throws(() => runPreflight(root, adapters(override as Record<string, unknown>)), (error: any) => error instanceof PreflightFailure && error.code === code);
});

test('actual npm pack dry-run JSON inventories satisfy release policy', () => {
  for (const [kind, packagePath, packageRoot] of [['root', '.', root], ['installer', './packages/installer', path.join(root, 'packages/installer')]]) {
    const result = spawnSync('npm', ['pack', packagePath, '--dry-run', '--json'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    inspectInventory(JSON.parse(result.stdout)[0], packageRoot, kind);
  }
});
