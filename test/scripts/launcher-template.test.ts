import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildStartJs } = require('../../../scripts/launcher-template.js');

interface LauncherFixture {
  startPath: string;
  serverDir: string;
  binDir: string;
  installMarker: string;
  serverMarker: string;
}

function writeResolvableDependencies(dataDir: string): void {
  const sdkDir = path.join(dataDir, 'node_modules', '@modelcontextprotocol', 'sdk');
  const zodDir = path.join(dataDir, 'node_modules', 'zod');
  fs.mkdirSync(path.join(sdkDir, 'server'), { recursive: true });
  fs.mkdirSync(path.join(zodDir, 'v3'), { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
    name: '@modelcontextprotocol/sdk',
    exports: { './server/index.js': './server/index.js' },
  }));
  fs.writeFileSync(path.join(sdkDir, 'server', 'index.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(zodDir, 'package.json'), JSON.stringify({
    name: 'zod',
    exports: { './v3': './v3/index.js' },
  }));
  fs.writeFileSync(path.join(zodDir, 'v3', 'index.js'), 'module.exports = {};\n');
}

/* The fake npm executable creates a complete dependency tree in its cwd. This
   exercises the generated launcher as a subprocess without network access. */
function createFakeNpm(binDir: string, installMarker: string, createsDependencies = true): void {
  const installerPath = path.join(binDir, 'fake-install.js');
  fs.writeFileSync(installerPath, `
const fs = require('fs');
const path = require('path');
const data = process.cwd();
if (${createsDependencies}) {
const sdk = path.join(data, 'node_modules', '@modelcontextprotocol', 'sdk');
const zod = path.join(data, 'node_modules', 'zod');
fs.mkdirSync(path.join(sdk, 'server'), { recursive: true });
fs.mkdirSync(path.join(zod, 'v3'), { recursive: true });
fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/sdk', exports: { './server/index.js': './server/index.js' } }));
fs.writeFileSync(path.join(sdk, 'server', 'index.js'), 'module.exports = {};\\n');
fs.writeFileSync(path.join(zod, 'package.json'), JSON.stringify({ name: 'zod', exports: { './v3': './v3/index.js' } }));
fs.writeFileSync(path.join(zod, 'v3', 'index.js'), 'module.exports = {};\\n');
}
fs.writeFileSync(${JSON.stringify(installMarker)}, 'installed');
`);

  if (process.platform === 'win32') {
    fs.writeFileSync(
      path.join(binDir, 'npm.cmd'),
      `@"${process.execPath}" "%~dp0fake-install.js"\r\n`,
    );
  } else {
    const npmPath = path.join(binDir, 'npm');
    fs.writeFileSync(npmPath, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-install.js"\n`);
    fs.chmodSync(npmPath, 0o755);
  }
}

function createLauncherFixture(options: { healthy?: boolean; repairCreatesDependencies?: boolean } = {}): LauncherFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-launcher-'));
  const serverDir = path.join(root, 'server');
  const dataDir = path.join(serverDir, '.data');
  const binDir = path.join(root, 'bin');
  const installMarker = path.join(root, 'npm-ran');
  const serverMarker = path.join(root, 'server-ran');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  const manifest = JSON.stringify({ name: 'token-optimizer-server', private: true }, null, 2) + '\n';
  fs.writeFileSync(path.join(serverDir, 'package.json'), manifest);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'package.json'), manifest);
  writeResolvableDependencies(dataDir);
  if (!options.healthy) {
    fs.rmSync(path.join(dataDir, 'node_modules', 'zod', 'v3'), { recursive: true });
  }
  fs.writeFileSync(path.join(serverDir, 'start.js'), buildStartJs());
  fs.writeFileSync(
    path.join(serverDir, 'index.js'),
    `require('zod/v3'); require('fs').writeFileSync(${JSON.stringify(serverMarker)}, 'started');\n`,
  );
  createFakeNpm(binDir, installMarker, options.repairCreatesDependencies !== false);

  return {
    startPath: path.join(serverDir, 'start.js'),
    serverDir,
    binDir,
    installMarker,
    serverMarker,
  };
}

test('launcher repairs a matching but incomplete dependency cache before starting', () => {
  const fixture = createLauncherFixture();
  const result = spawnSync(process.execPath, [fixture.startPath], {
    cwd: fixture.serverDir,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(fixture.installMarker), 'launcher should reinstall invalid dependencies');
  assert.ok(fs.existsSync(fixture.serverMarker), 'server should start after dependency repair');
});

test('launcher keeps a healthy matching dependency cache on the fast path', () => {
  const fixture = createLauncherFixture({ healthy: true });
  const result = spawnSync(process.execPath, [fixture.startPath], {
    cwd: fixture.serverDir,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(fixture.installMarker), 'healthy dependencies should not be reinstalled');
  assert.ok(fs.existsSync(fixture.serverMarker));
});

test('launcher exits clearly when npm leaves dependencies unresolved', () => {
  const fixture = createLauncherFixture({ repairCreatesDependencies: false });
  const result = spawnSync(process.execPath, [fixture.startPath], {
    cwd: fixture.serverDir,
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || ''}`,
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime dependencies remain invalid after npm install/);
  assert.ok(!fs.existsSync(fixture.serverMarker), 'server must not start with invalid dependencies');
});

test('launcher supports every credential reference adapter and fails closed when resolution fails', () => {
  const source = buildStartJs();
  assert.match(source, /macos-keychain/);
  assert.match(source, /linux-secret-service/);
  assert.match(source, /windows-dpapi/);
  assert.match(source, /credential reference could not be resolved/);
  assert.doesNotMatch(source, /console\.log\([^)]*secret/);
});

/* Each case executes the generated launcher, lets it resolve the reference,
   and records only the environment seen by the spawned MCP child. Native
   commands are fakes on PATH, so no real credential store is touched. */
test('launcher behavior resolves env, config, and native references only into the child environment', async (t) => {
  const cases = [
    { name: 'env', ref: { store: 'env', variable: 'CUSTOM_CREDENTIAL', account: 'wrong-account' }, extraEnv: { CUSTOM_CREDENTIAL: 'resolved-value' } },
    { name: 'config', ref: { store: 'config', path: 'CUSTOM_PATH', service: 'token-optimizer', account: 'gateway-token' } },
    { name: 'macOS', platform: 'darwin', command: 'security', ref: { store: 'macos-keychain', service: 'token-optimizer', account: 'gateway-token' } },
    { name: 'Linux', platform: 'linux', command: 'secret-tool', ref: { store: 'linux-secret-service', service: 'token-optimizer', account: 'gateway-token' } },
    { name: 'Windows', platform: 'win32', command: 'powershell.exe', ref: { store: 'windows-dpapi', path: 'ignored.dpapi', service: 'token-optimizer', account: 'gateway-token' } },
  ];
  for (const item of cases) await t.test(item.name, () => {
    const fixture = createLauncherFixture({ healthy: true });
    const childEnvPath = path.join(fixture.serverDir, 'child-env.json');
    fs.writeFileSync(path.join(fixture.serverDir, 'index.js'), `require('fs').writeFileSync(${JSON.stringify(childEnvPath)}, JSON.stringify({ token: process.env.LLM_GATEWAY_TOKEN, ref: process.env.TOKEN_OPTIMIZER_CREDENTIAL_REF }));\n`);
    const ref: any = { ...item.ref };
    if (item.name === 'config') {
      const configPath = path.join(fixture.serverDir, 'custom-credentials.json');
      ref.path = configPath;
      fs.writeFileSync(configPath, JSON.stringify({ 'token-optimizer:gateway-token': 'resolved-value' }));
    }
    if (item.command) {
      const executable = path.join(fixture.binDir, item.command);
      fs.writeFileSync(executable, '#!/bin/sh\nprintf %s resolved-value\n');
      fs.chmodSync(executable, 0o755);
    }
    const result = spawnSync(process.execPath, [fixture.startPath], {
      cwd: fixture.serverDir,
      env: { ...process.env, NODE_ENV: 'test', TOKEN_OPTIMIZER_LAUNCHER_TEST_PLATFORM: item.platform || '', TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: JSON.stringify(ref), ...item.extraEnv, PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /resolved-value/);
    const childEnv = JSON.parse(fs.readFileSync(childEnvPath, 'utf8'));
    assert.equal(childEnv.token, 'resolved-value');
    assert.equal(childEnv.ref, JSON.stringify(ref));
  });
});
