import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const manifests = require('../../../packages/installer/lib/manifest.js');

function home(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'to-manifest-')); }
function manifestFixture() { return { schemaVersion: 2, roots: ['/managed'], files: [{ path: '/managed/file', sha256: 'abc', ownership: 'installer' }] }; }

test('manifest round trip preserves ownership hashes', () => {
  const root = home(); manifests.writeManifest(root, manifestFixture());
  assert.deepEqual(manifests.readManifest(root).files[0], { path: '/managed/file', sha256: 'abc', ownership: 'installer' });
});

test('manifest rejects corrupt schema and traversal paths', () => {
  const root = home(); const file = manifests.manifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, files: [] }));
  assert.throws(() => manifests.readManifest(root), /schema/);
  assert.throws(() => manifests.writeManifest(root, { schemaVersion: 2, files: [] }), /allowed roots/);
  assert.throws(() => manifests.writeManifest(root, { schemaVersion: 2, roots: ['/managed'], files: [{ path: '/managed/../secret', sha256: 'x', ownership: 'installer' }] }), /invalid path|outside known roots/);
});

test('manifest rejects symlink escapes and tightens existing permissions', () => {
  const root = home(); const allowed = path.join(root, 'managed'); const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed, { recursive: true }); fs.mkdirSync(outside); fs.symlinkSync(outside, path.join(allowed, 'link'));
  assert.throws(() => manifests.writeManifest(root, { schemaVersion: 2, roots: [allowed], files: [{ path: path.join(allowed, 'link', 'owned'), sha256: 'x', ownership: 'installer' }] }), /outside known roots/);
  if (process.platform !== 'win32') {
    const fixture = { schemaVersion: 2, roots: [allowed], files: [{ path: path.join(allowed, 'owned'), sha256: 'x', ownership: 'installer' }] };
    manifests.writeManifest(root, fixture); fs.chmodSync(manifests.manifestPath(root), 0o644); fs.chmodSync(path.dirname(manifests.manifestPath(root)), 0o755);
    manifests.readManifest(root);
    assert.equal(fs.statSync(manifests.manifestPath(root)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(manifests.manifestPath(root))).mode & 0o777, 0o700);
  }
});

test('manifest replacement is private where supported', () => {
  const root = home(); manifests.writeManifest(root, manifestFixture());
  if (process.platform !== 'win32') assert.equal(fs.statSync(manifests.manifestPath(root)).mode & 0o777, 0o600);
});
