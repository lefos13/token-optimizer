import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '..', '..', '..');
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;

/* Every installable artifact needs the same release version so marketplace and
   npm users receive the server build that was tested for that release. */
test('all distributable package and plugin version sources are aligned', () => {
  assert.equal(RELEASE_VERSION, '2.0.0-beta.4');
  const installerPackage = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'installer', 'package.json'), 'utf8'));
  assert.equal(installerPackage.version, RELEASE_VERSION);
  const serverSource = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
  assert.match(serverSource, new RegExp(`version: '${RELEASE_VERSION.replace(/\./g, '\\.')}'`));

  for (const name of [
    'generate-plugin-antigravity.js',
    'generate-plugin-claude.js',
    'generate-plugin-codex.js',
    'generate-plugin-opencode.js',
    'generate-plugin-cursor.js'
  ]) {
    const source = fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
    assert.match(source, new RegExp(`const VERSION = "${RELEASE_VERSION.replace(/\./g, '\\.')}"`));
  }
});

test('agent-facing skill documents both remote provider paths', () => {
  const generatedSkill = fs.readFileSync(path.join(root, 'skill', 'skill-example.md'), 'utf8');
  assert.match(generatedSkill, /openrouter-direct/);
  assert.match(generatedSkill, /gateway-byok/);
});

/* The beta installer is a lifecycle tool, not only a first-run copier. Keep
   the published command surface and bundled guide aligned so users can
   inspect, repair, uninstall, and prune installations without guessing. */
test('packaged lifecycle exposes the complete installer surface', () => {
  const installerBin = path.join(root, 'packages', 'installer', 'bin', 'token-optimizer.js');
  const help = spawnSync(process.execPath, [installerBin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const installerHelp = help.stdout;
  assert.match(installerHelp, /install --dry-run/);
  assert.match(installerHelp, /doctor/);
  assert.match(installerHelp, /uninstall --dry-run/);

  const installerReadme = fs.readFileSync(path.join(root, 'packages', 'installer', 'README.md'), 'utf8');
  assert.match(installerReadme, /gateway-byok/);
  assert.match(installerReadme, /OpenRouter key.*gateway/i);
  assert.match(installerReadme, /repair/);
  assert.match(installerReadme, /logs (?:status|prune|purge)/);
});
