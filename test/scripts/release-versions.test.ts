import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;

/* Every installable artifact needs the same release version so marketplace and
   npm users receive the server build that was tested for that release. */
test('all distributable package and plugin version sources are aligned', () => {
  assert.equal(RELEASE_VERSION, '2.0.0-alpha.7');
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
