import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const releaseVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;
const generators = [
  'generate-plugin-antigravity.js',
  'generate-plugin-claude.js',
  'generate-plugin-codex.js',
  'generate-plugin-opencode.js',
  'generate-plugin-cursor.js',
];

function readGenerator(name: string): string {
  return fs.readFileSync(path.join(root, 'scripts', name), 'utf8');
}

test('every plugin generator carries the release version and delegates POSIX startup to start.js', () => {
  for (const generator of generators) {
    const source = readGenerator(generator);
    assert.match(
      source,
      new RegExp(`const VERSION = "${releaseVersion.replace(/\./g, '\\.')}"`),
      `${generator} should carry the release version`,
    );
    const startSh = source.match(/const startSh = `([\s\S]*?)`;\r?\n/)?.[1] || '';
    assert.match(startSh, /start\.js/, `${generator} start.sh should delegate to start.js`);
    assert.doesNotMatch(startSh, /npm install/, `${generator} start.sh should not duplicate dependency setup`);
  }
});

test('Codex marketplace configuration forwards the OpenRouter BYOK credentials', () => {
  const source = readGenerator('generate-plugin-codex.js');
  const envVars = source.match(/env_vars:\s*\[([\s\S]*?)\]/)?.[1] || '';
  assert.match(envVars, /OPENROUTER_BYOK_KEY/);
  assert.match(envVars, /OPENROUTER_BYOK_MODEL/);
});
