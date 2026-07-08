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
    'plugin/opencode/server/index.js': 'console.log("server")\n',
    'plugin/opencode/server/package.json': '{"name":"token-optimizer-server"}\n',
    'plugin/opencode/skills/token-optimizer/SKILL.md': '# Token Optimizer\n',
    'plugin/cursor/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/cursor/server/index.js': 'console.log("server")\n',
    'plugin/cursor/server/package.json': '{"name":"token-optimizer-server"}\n',
    'plugin/cursor/rules/token-optimizer.mdc': '---\nalwaysApply: true\n---\n',
    'plugin/claude/server/start.sh': '#!/usr/bin/env bash\n',
    'plugin/claude/README.md': '# Claude\n',
    'plugin/codex/server/start.sh': '#!/usr/bin/env bash\n',
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

  assert.ok(fs.existsSync(path.join(home, '.cursor', 'token-optimizer-server', 'start.sh')));
  const config = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, 'person-token');
  assert.ok(fs.existsSync(path.join(project, '.cursor', 'rules', 'token-optimizer.mdc')));
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

  const codexAgents = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
  assert.ok(codexAgents.includes('TOKEN_OPTIMIZER_START'));
});
