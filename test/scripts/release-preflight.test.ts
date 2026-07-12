import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..', '..', '..');
const { validateReleaseTag, inspectInventory, validateCycloneDx } = require('../../../scripts/release-policy');

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
  fs.writeFileSync(path.join(directory, 'dist/index.js'), '-----BEGIN PRIVATE KEY-----');
  assert.throws(() => inspectInventory({ files: base }, directory, 'root'), /PACKAGE_SECRET_REJECTED/);
});

test('schema validator rejects missing and structurally plausible invalid SBOMs', () => {
  assert.equal(validateCycloneDx(undefined), false);
  assert.equal(validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'x', version: 1, metadata: { timestamp: 'not-a-date', component: {} }, components: [] }), false);
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

test('preflight source fixes stable failure codes for dirty/version/audit/pack/SBOM/secret command failures', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'release-preflight.js'), 'utf8') + fs.readFileSync(path.join(root, 'scripts', 'release-policy.js'), 'utf8');
  for (const code of ['DIRTY_TREE', 'VERSION_MISMATCH', 'TAG_REQUIRED', 'TAG_VERSION_MISMATCH', 'TAG_POLICY_REJECTED', 'AUDIT_POLICY_FAILED', 'ROOT_PACK_FAILED', 'INSTALLER_PACK_FAILED', 'SBOM_GENERATION_FAILED', 'SBOM_INVALID_JSON', 'SBOM_SCHEMA_INVALID', 'REPOSITORY_SECRET_REJECTED']) assert.match(source, new RegExp(code));
  assert.match(source, /console\.error\(JSON\.stringify\(\{ ok: false, code/);
});
