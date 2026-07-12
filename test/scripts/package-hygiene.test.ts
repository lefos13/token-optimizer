import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(__dirname, '..', '..', '..');
const installerRoot = path.join(root, 'packages', 'installer');

type PackageManifest = {
  license?: string;
  dependencies?: Record<string, string>;
};

type PackFile = { path: string };
type PackResult = { files: PackFile[] };

const APACHE_2_SHA256 = 'b87a529a13d5294f97bb847936a82f39e4f8adae2425a3a5fb5f1a7b75d43e6a';
const EXPECTED_NOTICE = 'Token Optimizer\nCopyright 2026 Lefteris Evangelinos\n';

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function dryRunInventory(packagePath: string): string[] {
  const result = spawnSync('npm', ['pack', packagePath, '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout) as PackResult[];
  return pack.files.map((file) => file.path).sort();
}

/*
 * Both npm entry points represent the same Apache-licensed release and must
 * publish the legal texts needed to identify and redistribute that release.
 */
test('package metadata and legal files consistently declare Apache-2.0', () => {
  const rootPackage = readJson<PackageManifest>(path.join(root, 'package.json'));
  const installerPackage = readJson<PackageManifest>(path.join(installerRoot, 'package.json'));

  assert.equal(rootPackage.license, 'Apache-2.0');
  assert.equal(installerPackage.license, 'Apache-2.0');
  for (const packageRoot of [root, installerRoot]) {
    const license = fs.readFileSync(path.join(packageRoot, 'LICENSE'));
    assert.equal(createHash('sha256').update(license).digest('hex'), APACHE_2_SHA256);
    assert.equal(fs.readFileSync(path.join(packageRoot, 'NOTICE'), 'utf8'), EXPECTED_NOTICE);
  }
});

test('server package does not depend on the installer package', () => {
  const rootPackage = readJson<PackageManifest>(path.join(root, 'package.json'));
  const lockfile = fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8');

  assert.equal(rootPackage.dependencies?.['@softawarest/token-optimizer-installer'], undefined);
  assert.doesNotMatch(lockfile, /@softawarest\/token-optimizer-installer/);

  const runtimeProbe = spawnSync(process.execPath, [
    '-e',
    "require.resolve('@modelcontextprotocol/sdk/server/index.js'); require.resolve('zod'); require.resolve('nodemailer')",
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(runtimeProbe.status, 0, runtimeProbe.stderr);
});

/*
 * Explicit inventories keep npm releases focused on executable artifacts and
 * guarantee that license metadata is present in each independently packed tarball.
 */
test('root and installer publish only their intentional package inventories', () => {
  const rootInventory = dryRunInventory('.');
  assert.ok(rootInventory.includes('LICENSE'));
  assert.ok(rootInventory.includes('NOTICE'));
  assert.ok(rootInventory.includes('README.md'));
  assert.ok(rootInventory.includes('package.json'));
  assert.ok(rootInventory.includes('dist/index.js'));
  assert.ok(rootInventory.every((file) =>
    ['LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(file) || file.startsWith('dist/')),
  `unexpected root publish files:\n${rootInventory.join('\n')}`);

  const installerInventory = dryRunInventory('./packages/installer');
  for (const required of ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'bin/token-optimizer.js']) {
    assert.ok(installerInventory.includes(required), `installer package is missing ${required}`);
  }
  assert.ok(installerInventory.every((file) =>
    ['LICENSE', 'NOTICE', 'README.md', 'package.json'].includes(file)
      || file.startsWith('assets/')
      || file.startsWith('bin/')
      || file.startsWith('lib/')),
  `unexpected installer publish files:\n${installerInventory.join('\n')}`);

  const allPublishedPaths = [...rootInventory, ...installerInventory].join('\n');
  assert.doesNotMatch(allPublishedPaths, /(?:^|\/)(?:\.env|\.codex-local-test-runs|node_modules)(?:\/|$)/);
  assert.doesNotMatch(allPublishedPaths, /(?:^|\/)(?:\.env(?:\.|$)|credentials?\.json|secrets?\.json|[^/]+\.log$)|\/Users\/|[A-Za-z]:\\\\/i);
});
