import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../packages/installer/lib/install-core.js');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFixtureAssets(root: string): void {
  const files: Record<string, string> = {
    'plugin/opencode/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/opencode/server/start.js': '#!/usr/bin/env node\n',
    'plugin/opencode/server/index.js': 'console.log("server")\n',
    'plugin/opencode/server/package.json': '{"name":"token-optimizer-server"}\n',
    'plugin/opencode/skills/token-optimizer/SKILL.md': '# Token Optimizer\n',
    'plugin/cursor/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/cursor/server/start.js': '#!/usr/bin/env node\n',
    'plugin/cursor/server/index.js': 'console.log("server")\n',
    'plugin/cursor/server/package.json': '{"name":"token-optimizer-server"}\n',
    'plugin/cursor/rules/token-optimizer.mdc': '---\nalwaysApply: true\n---\n',
    'plugin/antigravity/plugin.json': '{"name":"token-optimizer"}\n',
    'plugin/antigravity/mcp_config.json': '{"mcpServers":{}}\n',
    'plugin/antigravity/server/start.js': '#!/usr/bin/env node\n',
    'plugin/claude/.claude-plugin/plugin.json': '{"name":"token-optimizer"}\n',
    'plugin/claude/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/claude/server/start.js': '#!/usr/bin/env node\n',
    'plugin/claude/README.md': '# Claude\n',
    'plugin/codex/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/codex/server/start.js': '#!/usr/bin/env node\n',
    'plugin/codex/skills/token-optimizer/SKILL.md': '# Token Optimizer\n',
    'plugin/codex/README.md': '# Codex\n',
    '.claude-plugin/marketplace.json': '{"name":"token-optimizer-marketplace"}\n',
    '.agents/plugins/marketplace.json': '{"name":"Softaware-marketplace"}\n',
  };
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

test('installOpenCode copies server and skill, replaces legacy MCP config, and writes defaults', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const launchctlStatePath = path.join(home, 'launchctl.json');
  writeFixtureAssets(assetsRoot);

  const configPath = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `{
    // Existing config and stale brand entry should be handled.
    "mcp": {
      "codegraph": { "type": "local", "command": ["codegraph", "serve", "--mcp"], },
      "local_tester": { "type": "local", "command": ["node", "old.js"], },
    },
  }\n`);

  installer.installOpenCode({
    home,
    assetsRoot,
    gatewayToken: 'person-token',
    credentialStore: 'config',
    gatewayUrl: 'https://llm-proxy.lnf.gr/v1',
    launchctlStatePath,
  });

  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.sh')));
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'skills', 'token-optimizer', 'SKILL.md')));

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.ok(config.mcp.token_optimizer);
  assert.ok(!config.mcp.local_tester);
  assert.equal(config.mcp.codegraph.command[0], 'codegraph');
  assert.deepEqual(config.mcp.token_optimizer.command, ['node', path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.js')]);
  assert.equal(config.mcp.token_optimizer.environment.LLM_GATEWAY_TOKEN, 'person-token');

  const agents = fs.readFileSync(path.join(home, '.config', 'opencode', 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('TOKEN_OPTIMIZER_START'));
});

test('successful install persists source-backed ownership manifest for lifecycle repair', () => {
  const home = tmpDir('to-installer-manifest-home-');
  const assetsRoot = tmpDir('to-installer-manifest-assets-');
  writeFixtureAssets(assetsRoot);
  installer.installSelectedClients({ home, assetsRoot, clients: ['opencode'], provider: 'skip', skipLaunchctl: true, defaults: false, skipClientCommands: true });
  const manifest = require('../../../packages/installer/lib/manifest.js').readManifest(home);
  assert.ok(manifest.files.length > 0);
  assert.ok(manifest.files.every((file: any) => file.source && file.source.startsWith(assetsRoot)));
});

test('installer launchctl state clears stale BYOK key and model when the provider changes', () => {
  const home = tmpDir('to-installer-home-');
  const launchctlStatePath = path.join(home, 'launchctl.json');

  installer.applyGatewayConfig({
    home,
    clients: ['opencode'],
    provider: 'byok',
    byokKey: 'sk-or-v1-mykey',
    byokModel: 'openai/gpt-4o-mini',
    launchctlStatePath,
  });
  installer.applyGatewayConfig({
    home,
    clients: ['opencode'],
    provider: 'gateway',
    gatewayToken: 'person-token',
    launchctlStatePath,
  });

  const state = JSON.parse(fs.readFileSync(launchctlStatePath, 'utf8'));
  assert.equal(state.LLM_GATEWAY_TOKEN, 'person-token');
  assert.ok(!('OPENROUTER_BYOK_KEY' in state));
  assert.ok(!('OPENROUTER_BYOK_MODEL' in state));
});

/* launchctl setenv does not survive a reboot/logout, so the installer also
   writes a RunAtLoad LaunchAgent that re-applies the managed env at every
   login. These tests use the temp home + state-path hook so no real launchctl
   agent is loaded. */
function launchAgentPath(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents', `${installer.LAUNCH_AGENT_LABEL}.plist`);
}

test('installer writes a persistent RunAtLoad LaunchAgent so GUI env survives reboot', () => {
  const home = tmpDir('to-installer-home-');
  const launchctlStatePath = path.join(home, 'launchctl.json');

  installer.applyGatewayConfig({
    home,
    clients: ['opencode'],
    provider: 'gateway',
    gatewayToken: 'person-token',
    launchctlStatePath,
  });

  const plist = fs.readFileSync(launchAgentPath(home), 'utf8');
  assert.ok(plist.includes('<key>RunAtLoad</key>'));
  assert.ok(plist.includes('<true/>'));
  assert.ok(plist.includes('launchctl setenv LLM_GATEWAY_TOKEN'));
  assert.ok(plist.includes('person-token'));
});

test('provider switch rewrites the LaunchAgent to only the current provider values', () => {
  const home = tmpDir('to-installer-home-');
  const launchctlStatePath = path.join(home, 'launchctl.json');

  installer.applyGatewayConfig({
    home, clients: ['opencode'], provider: 'byok', byokKey: 'sk-or-v1-mykey', byokModel: 'openai/gpt-4o-mini', launchctlStatePath,
  });
  installer.applyGatewayConfig({
    home, clients: ['opencode'], provider: 'gateway', gatewayToken: 'person-token', launchctlStatePath,
  });

  const plist = fs.readFileSync(launchAgentPath(home), 'utf8');
  assert.ok(plist.includes('LLM_GATEWAY_TOKEN'));
  assert.ok(!plist.includes('OPENROUTER_BYOK_KEY'));
  assert.ok(!plist.includes('sk-or-v1-mykey'));
});

test('a provider with no managed values removes any stale LaunchAgent', () => {
  const home = tmpDir('to-installer-home-');
  const launchctlStatePath = path.join(home, 'launchctl.json');

  installer.applyGatewayConfig({
    home, clients: ['opencode'], provider: 'gateway', gatewayToken: 'person-token', launchctlStatePath,
  });
  assert.ok(fs.existsSync(launchAgentPath(home)));

  installer.applyGatewayConfig({ home, clients: ['opencode'], provider: 'skip', launchctlStatePath });
  assert.ok(!fs.existsSync(launchAgentPath(home)), 'stale LaunchAgent removed when no provider values remain');
});

test('LaunchAgent plist shell-escapes values so special characters cannot break the command', () => {
  const home = tmpDir('to-installer-home-');
  const launchctlStatePath = path.join(home, 'launchctl.json');

  installer.applyGatewayConfig({
    home,
    clients: ['opencode'],
    provider: 'local',
    localApiUrl: "http://localhost:8080/v1?a=1&b=2",
    localModel: "model's-name",
    launchctlStatePath,
  });

  const plist = fs.readFileSync(launchAgentPath(home), 'utf8');
  /* & must be XML-escaped in the plist string; the single quote in the model
     must be shell-escaped as '\'' inside the single-quoted argument. */
  assert.ok(plist.includes('a=1&amp;b=2'));
  assert.ok(plist.includes("model'\\''s-name"));
});

test('installCursor writes global MCP config and optional project rule', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const project = tmpDir('to-installer-project-');
  writeFixtureAssets(assetsRoot);

  installer.installCursor({
    home,
    assetsRoot,
    gatewayToken: 'person-token',
    gatewayUrl: 'https://llm-proxy.lnf.gr/v1',
    cursorProjects: [project],
    skipLaunchctl: true,
  });

  assert.ok(fs.existsSync(path.join(home, '.cursor', 'token-optimizer-server', 'start.js')));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, 'person-token');
  /* Windows-safe launch: node + start.js, never bash. */
  assert.equal(config.mcpServers.token_optimizer.command, 'node');
  assert.deepEqual(config.mcpServers.token_optimizer.args, [path.join(home, '.cursor', 'token-optimizer-server', 'start.js')]);
  assert.ok(fs.existsSync(path.join(project, '.cursor', 'rules', 'token-optimizer.mdc')));
});

test('buildProviderValues: gateway needs a token, byok needs ONLY a key (no token), local and skip need neither', () => {
  assert.throws(() => installer.buildProviderValues({ provider: 'gateway' }), /gatewayToken is required/);
  assert.throws(() => installer.buildProviderValues({ provider: 'byok' }), /byokKey is required/);

  const gateway = installer.buildProviderValues({ provider: 'gateway', gatewayToken: 'tok' });
  assert.equal(gateway.LLM_GATEWAY_TOKEN, 'tok');
  assert.equal(gateway.LLM_GATEWAY_URL, installer.DEFAULT_GATEWAY_URL);
  assert.equal(gateway.OPENROUTER_BYOK_KEY, '');

  /* byok needs no gatewayToken at all: the gateway does not authenticate a
     BYOK-only caller, so writing one would be misleading. */
  const byok = installer.buildProviderValues({
    provider: 'byok',
    byokKey: 'sk-or-key',
    byokModel: ' openai/gpt-4o-mini ',
  });
  assert.equal(byok.LLM_GATEWAY_TOKEN, '');
  assert.equal(byok.LLM_GATEWAY_URL, installer.DEFAULT_GATEWAY_URL);
  assert.equal(byok.OPENROUTER_BYOK_KEY, 'sk-or-key');
  assert.equal(byok.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');

  const local = installer.buildProviderValues({ provider: 'local' });
  assert.deepEqual(Object.keys(local).sort(), [...installer.MANAGED_ENV_KEYS].sort());
  assert.equal(local.TOKEN_OPTIMIZER_PROVIDER_MODE, 'local');

  const localWithOverrides = installer.buildProviderValues({ provider: 'local', localApiUrl: 'http://x:1/v1', localModel: 'm' });
  assert.equal(localWithOverrides.LOCAL_LLM_API_URL, 'http://x:1/v1');
  assert.equal(localWithOverrides.LOCAL_LLM_MODEL, 'm');
  assert.equal(localWithOverrides.LLM_GATEWAY_TOKEN, '');

  const skip = installer.buildProviderValues({ provider: 'skip' });
  assert.equal(skip.TOKEN_OPTIMIZER_PROVIDER_MODE, '');

  /* No explicit provider: inferred from whichever fields were supplied. */
  assert.equal(installer.buildProviderValues({ gatewayToken: 'tok' }).LLM_GATEWAY_TOKEN, 'tok');
  assert.ok(Object.values(installer.buildProviderValues({})).every((v: unknown) => v === ''));
});

test('native credential preparation writes only a reference across all five client config shapes', () => {
  const home = tmpDir('to-native-credential-home-');
  const secret = 'fixture-credential-value';
  const calls: any[] = [];
  const assetsRoot = tmpDir('to-native-assets-');
  writeFixtureAssets(assetsRoot);
  const codexConfig = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
  fs.writeFileSync(codexConfig, '[mcp_servers.token_optimizer]\ncommand = \'node\'\n');
  const options = {
    home,
    clients: ['all'],
    provider: 'gateway-token',
    gatewayToken: secret,
    credentialStore: 'native',
    credentialStoreOptions: { platform: 'darwin', available: true, account: 'gateway-token', execFileSync: (_bin: string, args: string[], processOptions: any) => { calls.push({ args, processOptions }); return ''; } },
    skipLaunchctl: true,
    skipClientCommands: true,
    assetsRoot,
  };
  const result = installer.applyChangePlan(installer.planInstallation(options));
  assert.equal(result.error, undefined);
  const paths = [
    path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.gemini', 'config', 'mcp_config.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'config.toml'),
  ];
  assert.ok(paths.every(fs.existsSync), 'all five supported client config shapes should be written');
  const serialized = paths.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.ok(calls.some((call) => call.processOptions.input === secret));
  assert.doesNotMatch(JSON.stringify(calls.map((call) => call.args)), new RegExp(secret));
  assert.match(serialized, /TOKEN_OPTIMIZER_CREDENTIAL_REF/);
  assert.doesNotMatch(serialized, new RegExp(secret));
});

test('native credential execution fails closed and plaintext requires an explicit store', () => {
  const result = installer.applyChangePlan(installer.planInstallation({ provider: 'gateway-token', gatewayToken: 'fixture-credential-value', credentialStore: 'native', credentialStoreOptions: { platform: 'unknown' }, clients: ['opencode'] }));
  assert.match(result.error.message, /choose env or config explicitly/i);
  assert.equal(installer.prepareCredentialOptions({ provider: 'local' }).credentialRef, undefined);
});

test('a later install failure restores the credential that existed before the transaction', () => {
  const home = tmpDir('to-credential-rollback-');
  const { createCredentialStore } = require('../../../packages/installer/lib/credential-store.js');
  const store = createCredentialStore('config', { home, service: 'token-optimizer', account: 'gateway-token' });
  store.set('prior-value');
  const result = installer.applyChangePlan(installer.planInstallation({ home, clients: ['opencode'], assetsRoot: tmpDir('to-empty-assets-'), provider: 'gateway-token', gatewayToken: 'replacement-value', credentialStore: 'config', skipLaunchctl: true }));
  assert.ok(result.error);
  assert.equal(store.get(), 'prior-value');
});

test('provider-only config restores the prior credential when a client write fails', () => {
  const home = tmpDir('to-config-credential-rollback-');
  const { createCredentialStore } = require('../../../packages/installer/lib/credential-store.js');
  const store = createCredentialStore('config', { home, service: 'token-optimizer', account: 'gateway-token' });
  store.set('prior-value');
  const target = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  const mutableFs = require('node:fs');
  const originalWrite = mutableFs.writeFileSync;
  mutableFs.writeFileSync = (file: string, ...args: any[]) => {
    if (path.resolve(String(file)) === path.resolve(target)) throw new Error('simulated client config failure');
    return originalWrite(file, ...args);
  };
  try {
    assert.throws(() => installer.applyProviderConfiguration({ home, clients: ['opencode'], provider: 'gateway-token', gatewayToken: 'replacement-value', credentialStore: 'config', skipLaunchctl: true }), /simulated client config failure/);
  } finally {
    mutableFs.writeFileSync = originalWrite;
  }
  assert.equal(store.get(), 'prior-value');
});

test('install manifest owns a newly created credential and uninstall removes it', () => {
  const home = tmpDir('to-credential-uninstall-');
  const assetsRoot = tmpDir('to-credential-assets-');
  writeFixtureAssets(assetsRoot);
  installer.installSelectedClients({ home, assetsRoot, clients: ['opencode'], provider: 'gateway-token', gatewayToken: 'installed-value', credentialStore: 'config', skipLaunchctl: true, skipClientCommands: true, defaults: false });
  const { readManifest } = require('../../../packages/installer/lib/manifest.js');
  const lifecycle = require('../../../packages/installer/lib/uninstall.js');
  const manifest = readManifest(home);
  assert.equal(manifest.credentials.length, 1);
  const plan = lifecycle.planUninstall(manifest, lifecycle.currentStateFromManifest(manifest));
  lifecycle.applyLifecyclePlan(plan);
  const { createCredentialStore } = require('../../../packages/installer/lib/credential-store.js');
  assert.equal(createCredentialStore('config', { home, service: 'token-optimizer', account: 'gateway-token' }).get(), null);
});

test('pre-existing credentials are restored and never claimed by the manifest', () => {
  const home = tmpDir('to-existing-credential-');
  const assetsRoot = tmpDir('to-existing-assets-');
  writeFixtureAssets(assetsRoot);
  const { createCredentialStore } = require('../../../packages/installer/lib/credential-store.js');
  const store = createCredentialStore('config', { home, service: 'token-optimizer', account: 'gateway-token' });
  store.set('user-owned-value');
  installer.installSelectedClients({ home, assetsRoot, clients: ['opencode'], provider: 'gateway-token', gatewayToken: 'temporary-value', credentialStore: 'config', skipLaunchctl: true, skipClientCommands: true, defaults: false });
  const manifest = require('../../../packages/installer/lib/manifest.js').readManifest(home);
  assert.deepEqual(manifest.credentials, []);
});

test('installOpenCode with provider "local" registers the server with no token required', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);

  installer.installOpenCode({
    home, assetsRoot, provider: 'local', localApiUrl: 'http://localhost:9999/v1', localModel: 'my-model',
    skipLaunchctl: true,
  });

  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.ok(config.mcp.token_optimizer);
  assert.equal(config.mcp.token_optimizer.environment.LOCAL_LLM_API_URL, 'http://localhost:9999/v1');
  assert.ok(!('LLM_GATEWAY_TOKEN' in config.mcp.token_optimizer.environment));
});

test('installOpenCode with provider "byok" writes the OpenRouter key and optional model, with no gateway token', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);

  installer.installOpenCode({
    home,
    assetsRoot,
    provider: 'byok',
    byokKey: 'sk-or-key',
    byokModel: 'openai/gpt-4o-mini',
    skipLaunchctl: true,
  });

  const config = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.equal(config.mcp.token_optimizer.environment.OPENROUTER_BYOK_KEY, 'sk-or-key');
  assert.equal(config.mcp.token_optimizer.environment.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');
  assert.equal(config.mcp.token_optimizer.environment.LLM_GATEWAY_URL, installer.DEFAULT_GATEWAY_URL);
  assert.ok(!('LLM_GATEWAY_TOKEN' in config.mcp.token_optimizer.environment));
});

test('installCursor with provider "skip" still registers the server, writing no provider env at all', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);

  installer.installCursor({ home, assetsRoot, provider: 'skip', skipLaunchctl: true });

  assert.ok(fs.existsSync(path.join(home, '.cursor', 'token-optimizer-server', 'start.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(config.mcpServers.token_optimizer);
  assert.deepEqual(config.mcpServers.token_optimizer.env, {});
});

test('installSelectedClients defaults to detected clients and does not write every client config', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });

  const installed = installer.installSelectedClients({
    home,
    assetsRoot,
    gatewayToken: 'person-token',
    credentialStore: 'config',
    skipLaunchctl: true,
    skipClientCommands: true,
  });

  assert.deepEqual(installed, ['opencode']);
  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.sh')));
  assert.ok(!fs.existsSync(path.join(home, '.cursor', 'mcp.json')));
});

test('installClaude and installCodex copy marketplace assets and write config/defaults', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const installRoot = path.join(home, '.token-optimizer');
  writeFixtureAssets(assetsRoot);

  installer.installClaude({
    home,
    assetsRoot,
    installRoot,
    gatewayToken: 'person-token',
    skipLaunchctl: true,
    skipClientCommands: true,
  });
  installer.installCodex({
    home,
    assetsRoot,
    installRoot,
    gatewayToken: 'person-token',
    skipLaunchctl: true,
    skipClientCommands: true,
  });

  assert.ok(fs.existsSync(path.join(installRoot, '.claude-plugin', 'marketplace.json')));
  assert.ok(fs.existsSync(path.join(installRoot, 'plugin', 'claude', 'README.md')));
  assert.ok(fs.existsSync(path.join(installRoot, '.agents', 'plugins', 'marketplace.json')));
  assert.ok(fs.existsSync(path.join(installRoot, 'plugin', 'codex', 'README.md')));

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.LLM_GATEWAY_TOKEN, 'person-token');

  /* CLI-free fallbacks (client CLIs skipped/unavailable): Claude gets a
     skills-directory plugin; Codex gets a config.toml server + skill copy. */
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'token-optimizer', '.claude-plugin', 'plugin.json')));
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'token-optimizer', 'server', 'start.js')));
  const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(codexToml.includes('[mcp_servers.token_optimizer]'));
  assert.ok(codexToml.includes("command = 'node'"));
  assert.ok(codexToml.includes('start.js'));
  assert.ok(codexToml.includes("LLM_GATEWAY_TOKEN = 'person-token'"));
  assert.ok(fs.existsSync(path.join(home, '.codex', 'skills', 'token-optimizer', 'SKILL.md')));

  const codexAgents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.ok(codexAgents.includes('TOKEN_OPTIMIZER_START'));
});

test('installCodex writes the credential-bearing direct server after plugin CLI registration succeeds', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const installRoot = path.join(home, '.token-optimizer');
  const commandDir = tmpDir('to-installer-bin-');
  writeFixtureAssets(assetsRoot);

  /* Simulate successful marketplace and plugin commands without touching the
     real Codex installation. The installer must still write its direct server. */
  const fakeCodex = path.join(commandDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  fs.writeFileSync(fakeCodex, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/usr/bin/env sh\nexit 0\n');
  if (process.platform !== 'win32') {
    fs.chmodSync(fakeCodex, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${commandDir}${path.delimiter}${originalPath || ''}`;
  try {
    installer.installCodex({
      home,
      assetsRoot,
      installRoot,
      gatewayToken: 'person-token',
      skipLaunchctl: true,
    });
  } finally {
    process.env.PATH = originalPath;
  }

  const codexToml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(codexToml.includes("command = 'node'"));
  assert.ok(codexToml.includes(`start.js`));
  assert.ok(codexToml.includes("LLM_GATEWAY_TOKEN = 'person-token'"));
});

/* Repeated marketplace installation must invalidate the installed Codex plugin
   cache before adding the current staged plugin again. */
test('installCodex refreshes an existing marketplace plugin before adding it again', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const installRoot = path.join(home, '.token-optimizer');
  const commandDir = tmpDir('to-installer-bin-');
  const commandLog = path.join(home, 'codex-commands.log');
  writeFixtureAssets(assetsRoot);

  const fakeCodex = path.join(commandDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeCodex, `@echo %*>>"${commandLog}"\r\n@exit /b 0\r\n`);
  } else {
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> '${commandLog}'\n`);
    fs.chmodSync(fakeCodex, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${commandDir}${path.delimiter}${originalPath || ''}`;
  try {
    installer.installCodex({
      home,
      assetsRoot,
      installRoot,
      gatewayToken: 'person-token',
      skipLaunchctl: true,
    });
  } finally {
    process.env.PATH = originalPath;
  }

  const commands = fs.readFileSync(commandLog, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(commands, [
    `plugin marketplace add ${installRoot}`,
    'plugin remove token-optimizer --marketplace Softaware-marketplace',
    'plugin add token-optimizer --marketplace Softaware-marketplace',
  ]);
});

/* Claude owns a marketplace cache too, but its CLI offers a supported update
   command; a repeat installer run should prefer it before fallback install. */
test('installClaude refreshes an existing marketplace plugin with plugin update', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const installRoot = path.join(home, '.token-optimizer');
  const commandDir = tmpDir('to-installer-bin-');
  const commandLog = path.join(home, 'claude-commands.log');
  writeFixtureAssets(assetsRoot);

  const fakeClaude = path.join(commandDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (process.platform === 'win32') {
    fs.writeFileSync(fakeClaude, `@echo %*>>"${commandLog}"\r\n@exit /b 0\r\n`);
  } else {
    fs.writeFileSync(fakeClaude, `#!/usr/bin/env sh\nprintf '%s\\n' "$*" >> '${commandLog}'\n`);
    fs.chmodSync(fakeClaude, 0o755);
  }
  const originalPath = process.env.PATH;
  process.env.PATH = `${commandDir}${path.delimiter}${originalPath || ''}`;
  try {
    installer.installClaude({
      home,
      assetsRoot,
      installRoot,
      gatewayToken: 'person-token',
      skipLaunchctl: true,
    });
  } finally {
    process.env.PATH = originalPath;
  }

  const commands = fs.readFileSync(commandLog, 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(commands, [
    `plugin marketplace add ${installRoot}`,
    'plugin update token-optimizer@token-optimizer-marketplace',
  ]);
});

test('upsertCodexTomlServer replaces an existing section without touching other config', () => {
  const existing = [
    '[mcp_servers.playwright]',
    'command = "npx"',
    '',
    '[mcp_servers.token_optimizer]',
    "command = 'bash'",
    "args = ['/old/start.sh']",
    '',
    '[mcp_servers.token_optimizer.env]',
    "LLM_GATEWAY_URL = 'https://old.example/v1'",
    '',
    '[other]',
    'key = "value"',
    '',
  ].join('\n');
  const installer2 = require('../../../packages/installer/lib/install-core.js');
  const next = installer2.upsertCodexTomlServer(existing, 'C:\\Users\\x\\start.js', {
    LLM_GATEWAY_URL: 'https://llm-proxy.lnf.gr/v1',
    LLM_GATEWAY_TOKEN: 'tok',
    OPENROUTER_BYOK_KEY: '',
    OPENROUTER_BYOK_MODEL: '',
    LOCAL_LLM_API_URL: '',
    LOCAL_LLM_MODEL: '',
  });
  assert.ok(next.includes('[mcp_servers.playwright]'));
  assert.ok(next.includes('[other]'));
  assert.ok(!next.includes('/old/start.sh'));
  assert.ok(!next.includes('https://old.example/v1'));
  assert.ok(next.includes("args = ['C:\\Users\\x\\start.js']"));
  assert.ok(next.includes("LLM_GATEWAY_TOKEN = 'tok'"));
  assert.equal((next.match(/\[mcp_servers\.token_optimizer\]/g) || []).length, 1);
});

test('plan preview is mutation-free and a later client failure restores prior writes', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);
  const before = fs.readdirSync(home);
  const plan = installer.planInstallation({ home, assetsRoot, clients: ['opencode', 'unsupported'], provider: 'skip', skipLaunchctl: true });
  assert.deepEqual(fs.readdirSync(home), before);
  assert.ok(plan.operations.length >= 6);
  const result = installer.applyChangePlan(plan);
  assert.ok(result.error);
  assert.ok(result.rolledBack.length > 0);
  assert.deepEqual(fs.readdirSync(home), before);
});

test('install rollback snapshots never traverse unrelated protected home directories', () => {
  const home = tmpDir('to-installer-protected-home-');
  const assetsRoot = tmpDir('to-installer-protected-assets-');
  const protectedMusic = path.join(home, 'Music', 'Music');
  writeFixtureAssets(assetsRoot);
  fs.mkdirSync(protectedMusic, { recursive: true });

  /*
   * macOS privacy controls reject recursive reads of protected home folders.
   * Simulate that deterministic boundary while allowing installer-owned asset
   * copies, so the test does not depend on the host's TCC permission state.
   */
  const mutableFs = require('node:fs');
  const originalCopy = mutableFs.cpSync;
  mutableFs.cpSync = (source: fs.PathLike, destination: fs.PathLike, options?: fs.CopySyncOptions) => {
    if (path.resolve(String(source)) === path.resolve(home)) {
      const error = new Error(`Operation not permitted: ${protectedMusic}`) as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return originalCopy(source, destination, options);
  };

  try {
    const result = installer.applyChangePlan(installer.planInstallation({
      home,
      assetsRoot,
      clients: ['opencode'],
      provider: 'skip',
      skipLaunchctl: true,
      defaults: false,
      skipClientCommands: true,
    }));
    assert.equal(result.error, undefined);
    assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.js')));
  } finally {
    mutableFs.cpSync = originalCopy;
  }
});

test('cursor rollback restores project-local targets without replacing the project', () => {
  const home = tmpDir('to-installer-cursor-rollback-home-');
  const assetsRoot = tmpDir('to-installer-cursor-rollback-assets-');
  const project = tmpDir('to-installer-cursor-project-');
  const userFile = path.join(project, 'user-work.txt');
  writeFixtureAssets(assetsRoot);
  fs.writeFileSync(userFile, 'keep me');

  const result = installer.applyChangePlan(installer.planInstallation({
    home,
    assetsRoot,
    clients: ['cursor', 'unsupported'],
    cursorProjects: [project],
    provider: 'skip',
    skipLaunchctl: true,
    defaults: false,
    skipClientCommands: true,
  }));

  assert.ok(result.error);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'keep me');
  assert.ok(!fs.existsSync(path.join(project, '.cursor')));
  assert.ok(!fs.existsSync(path.join(home, '.cursor')));
});
