import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const releaseVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
).version;
assert.equal(releaseVersion, '3.1.0');
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

test('Codex marketplace configuration forwards the OpenRouter credentials', () => {
  const source = readGenerator('generate-plugin-codex.js');
  const envVars = source.match(/env_vars:\s*\[([\s\S]*?)\]/)?.[1] || '';
  assert.match(envVars, /OPENROUTER_API_KEY/);
  assert.match(envVars, /OPENROUTER_MODEL/);
  assert.match(envVars, /OPENROUTER_API_URL/);
  assert.doesNotMatch(envVars, /GATEWAY|BYOK/);
});

test('no generated client configuration references the retired gateway', () => {
  for (const name of ['antigravity', 'claude', 'codex', 'opencode', 'cursor', 'agensi']) {
    assert.doesNotMatch(readGenerator(`generate-plugin-${name}.js`), /LLM_GATEWAY|llm-proxy|gateway:config|BYOK/i);
  }
});

test('generated server bundles include every runtime module required by llm.js', () => {
  const bundles = ['antigravity', 'claude', 'codex', 'opencode', 'cursor'];
  const required = ['providers.js', 'llm-schemas.js', 'redaction.js', 'config.js'];
  for (const bundle of bundles) {
    for (const file of required) {
      const generated = path.join(root, 'plugin', bundle, 'server', file);
      assert.ok(fs.existsSync(generated), `${bundle} missing ${file}`);
      assert.doesNotThrow(() => require(generated), `${bundle} cannot load ${file}`);
      const installer = path.join(root, 'packages', 'installer', 'assets', 'plugin', bundle, 'server', file);
      assert.ok(fs.existsSync(installer), `installer ${bundle} missing ${file}`);
      assert.doesNotThrow(() => require(installer), `installer ${bundle} cannot load ${file}`);
    }
  }
});

/*
 * Generators must use the repository lockfile rather than whichever SDK version
 * happens to be installed in a maintainer's local node_modules. This keeps the
 * clean npm ci verification job byte-for-byte deterministic.
 */
test('generated server manifests use the lockfile-pinned SDK version', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const expected = `^${lock.packages['node_modules/@modelcontextprotocol/sdk'].version}`;
  for (const bundle of ['antigravity', 'claude', 'codex', 'opencode', 'cursor']) {
    for (const manifest of [
      path.join(root, 'plugin', bundle, 'server', 'package.json'),
      path.join(root, 'packages', 'installer', 'assets', 'plugin', bundle, 'server', 'package.json'),
    ]) {
      const packageJson = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], expected, manifest);
    }
  }
});

test('generated plugin and installer server entrypoints load successfully', () => {
  const bundles = ['antigravity', 'claude', 'codex', 'opencode', 'cursor'];
  for (const bundle of bundles) {
    const generated = path.join(root, 'plugin', bundle, 'server', 'index.js');
    const installer = path.join(root, 'packages', 'installer', 'assets', 'plugin', bundle, 'server', 'index.js');
    assert.ok(fs.existsSync(generated), `${bundle} missing plugin index.js`);
    assert.ok(fs.existsSync(installer), `${bundle} missing installer index.js`);

    /*
     * Each generated entrypoint is an MCP server that may register process-wide
     * stdin listeners during module initialization. Loading them in this test
     * process leaked listeners across the ten bundles and produced warnings;
     * isolated child processes preserve load coverage without shared state.
     */
    for (const [label, entrypoint] of [
      ['plugin', generated],
      ['installer', installer],
    ] as const) {
      const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(entrypoint)})`], {
        env: { ...process.env, TOKEN_OPTIMIZER_NO_AUTOSTART: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(
        result.status,
        0,
        `${bundle} ${label} index.js cannot load: ${result.stderr || result.error?.message || 'unknown error'}`,
      );
      assert.doesNotMatch(result.stderr, /MaxListenersExceededWarning/, `${bundle} ${label} emitted listener warning`);
    }
  }
});

test('every client bundle ships the setup skill (Cursor as an agent-requested rule)', () => {
  const setup = path.join('skills', 'token-optimizer-setup', 'SKILL.md');
  for (const bundle of ['antigravity', 'claude', 'codex', 'opencode']) {
    const file = path.join(root, 'plugin', bundle, setup);
    assert.ok(fs.existsSync(file), `${bundle} is missing ${setup}`);
    assert.match(fs.readFileSync(file, 'utf8'), /^name: token-optimizer-setup$/m);
  }
  const rule = fs.readFileSync(path.join(root, 'plugin', 'cursor', 'rules', 'token-optimizer-setup.mdc'), 'utf8');
  assert.match(rule, /^---\ndescription: .+\nalwaysApply: false\n---\n/);
  assert.doesNotMatch(rule, /^name:/m);
});

test('Agensi package is one skill whose root SKILL.md routes to the setup reference', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-plugin-agensi.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const bundle = path.join(root, 'plugin', 'agensi', 'token-optimizer');
  assert.deepEqual(fs.readdirSync(path.join(root, 'plugin', 'agensi')).filter((entry) => !entry.endsWith('.zip')), ['token-optimizer']);
  const skill = fs.readFileSync(path.join(bundle, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: token-optimizer\n/);
  assert.match(skill, /references\/setup\.md/);
  const setup = fs.readFileSync(path.join(bundle, 'references', 'setup.md'), 'utf8');
  assert.match(setup, /^# Token Optimizer setup/);
  assert.doesNotMatch(setup, /^name:|disable-model-invocation/m);
});
