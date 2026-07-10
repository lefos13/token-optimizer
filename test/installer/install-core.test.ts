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
  const byok = installer.buildProviderValues({ provider: 'byok', byokKey: 'sk-or-key' });
  assert.equal(byok.LLM_GATEWAY_TOKEN, '');
  assert.equal(byok.LLM_GATEWAY_URL, installer.DEFAULT_GATEWAY_URL);
  assert.equal(byok.OPENROUTER_BYOK_KEY, 'sk-or-key');

  const local = installer.buildProviderValues({ provider: 'local' });
  assert.deepEqual(Object.keys(local).sort(), [...installer.MANAGED_ENV_KEYS].sort());
  assert.ok(Object.values(local).every((v: unknown) => v === ''));

  const localWithOverrides = installer.buildProviderValues({ provider: 'local', localApiUrl: 'http://x:1/v1', localModel: 'm' });
  assert.equal(localWithOverrides.LOCAL_LLM_API_URL, 'http://x:1/v1');
  assert.equal(localWithOverrides.LOCAL_LLM_MODEL, 'm');
  assert.equal(localWithOverrides.LLM_GATEWAY_TOKEN, '');

  const skip = installer.buildProviderValues({ provider: 'skip' });
  assert.ok(Object.values(skip).every((v: unknown) => v === ''));

  /* No explicit provider: inferred from whichever fields were supplied. */
  assert.equal(installer.buildProviderValues({ gatewayToken: 'tok' }).LLM_GATEWAY_TOKEN, 'tok');
  assert.ok(Object.values(installer.buildProviderValues({})).every((v: unknown) => v === ''));
});

test('installOpenCode with provider "local" registers the server with no token required', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);

  installer.installOpenCode({
    home, assetsRoot, provider: 'local', localApiUrl: 'http://localhost:9999/v1', localModel: 'my-model',
  });

  assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'token-optimizer-server', 'start.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.ok(config.mcp.token_optimizer);
  assert.equal(config.mcp.token_optimizer.environment.LOCAL_LLM_API_URL, 'http://localhost:9999/v1');
  assert.ok(!('LLM_GATEWAY_TOKEN' in config.mcp.token_optimizer.environment));
});

test('installOpenCode with provider "byok" writes only the OpenRouter key, no gateway token', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  writeFixtureAssets(assetsRoot);

  installer.installOpenCode({ home, assetsRoot, provider: 'byok', byokKey: 'sk-or-key' });

  const config = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.equal(config.mcp.token_optimizer.environment.OPENROUTER_BYOK_KEY, 'sk-or-key');
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
