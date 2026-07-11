import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* The config CLI is a CommonJS script under scripts/. From the compiled test at
   .test-build/test/scripts/, it resolves at ../../../scripts/manage-gateway-config.js. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../scripts/manage-gateway-config.js');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cfg-'));
}

function readlineWith(...answers: string[]) {
  return {
    question(_prompt: string, done: (answer: string) => void) {
      done(answers.shift() || '');
    }
  };
}

test('MANAGED_ENV_KEYS covers gateway, BYOK, and local-LLM provider vars', () => {
  assert.deepEqual(cli.MANAGED_ENV_KEYS, [
    'LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN', 'OPENROUTER_BYOK_KEY', 'OPENROUTER_BYOK_MODEL', 'LOCAL_LLM_API_URL', 'LOCAL_LLM_MODEL', 'TOKEN_OPTIMIZER_PROVIDER_MODE', 'TOKEN_OPTIMIZER_CREDENTIAL_REF', 'OPENROUTER_API_KEY'
  ]);
});

test('emptyManagedValues returns every managed key set to an empty string', () => {
  const empty = cli.emptyManagedValues();
  assert.deepEqual(Object.keys(empty).sort(), [...cli.MANAGED_ENV_KEYS].sort());
  assert.ok(Object.values(empty).every((v: unknown) => v === ''));
});

test('sanitizeEnvObject keeps only managed keys with non-empty values', () => {
  const out = cli.sanitizeEnvObject({
    LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: '', OPENROUTER_API_KEY: 'legacy', OTHER: 'x'
  });
  assert.deepEqual(out, { LLM_GATEWAY_TOKEN: 'tok' });
});

test('mergeManagedEnvValues sets provided keys and deletes empty ones', () => {
  const merged = cli.mergeManagedEnvValues(
    { LLM_GATEWAY_URL: 'old', KEEP: 'yes' },
    { LLM_GATEWAY_URL: 'https://g/v1', LLM_GATEWAY_TOKEN: '' }
  );
  assert.equal(merged.LLM_GATEWAY_URL, 'https://g/v1');
  assert.equal(merged.KEEP, 'yes');            // unmanaged keys untouched
  assert.ok(!('LLM_GATEWAY_TOKEN' in merged)); // empty managed value removed
});

test('applyToTargets writes gateway values to every managed client config, collect reads them back, empty clears', () => {
  const home = tmpHome();
  const values = { LLM_GATEWAY_URL: 'https://llm-proxy.lnf.gr/v1', LLM_GATEWAY_TOKEN: 'person-token' };

  const opencodePath = path.join(home, '.config', 'opencode', 'opencode.jsonc');
  fs.mkdirSync(path.dirname(opencodePath), { recursive: true });
  fs.writeFileSync(opencodePath, `{
    // Existing OpenCode config should survive the gateway manager.
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "existing": { "type": "local", "command": ["node", "server.js"], },
    },
  }\n`);

  cli.applyToTargets(values, home);

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.LLM_GATEWAY_TOKEN, 'person-token');
  assert.equal(claude.env.LLM_GATEWAY_URL, 'https://llm-proxy.lnf.gr/v1');

  const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(gemini.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, 'person-token');

  const opencode = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
  assert.equal(opencode.mcp.token_optimizer.environment.LLM_GATEWAY_TOKEN, 'person-token');
  assert.equal(opencode.mcp.token_optimizer.environment.LLM_GATEWAY_URL, 'https://llm-proxy.lnf.gr/v1');
  assert.equal(opencode.mcp.existing.command[1], 'server.js');

  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, 'person-token');
  assert.equal(cursor.mcpServers.token_optimizer.env.LLM_GATEWAY_URL, 'https://llm-proxy.lnf.gr/v1');

  assert.equal(cli.collectCurrentValues(home).LLM_GATEWAY_TOKEN, 'person-token');

  cli.applyToTargets({}, home);
  const cleared = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in cleared.env));

  const clearedOpencode = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in clearedOpencode.mcp.token_optimizer.environment));

  const clearedCursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in clearedCursor.mcpServers.token_optimizer.env));
});

test('local-LLM provider values require no token and switching modes clears previous gateway and BYOK values', () => {
  const home = tmpHome();

  cli.applyToTargets(
    {
      LLM_GATEWAY_URL: 'https://llm-proxy.lnf.gr/v1',
      LLM_GATEWAY_TOKEN: 'person-token',
      OPENROUTER_BYOK_KEY: 'sk-or-v1-mykey',
      OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini',
    },
    home
  );
  const beforeSwitch = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(beforeSwitch.env.LLM_GATEWAY_TOKEN, 'person-token');

  const localValues = {
    ...cli.emptyManagedValues(),
    LOCAL_LLM_API_URL: cli.DEFAULT_LOCAL_LLM_URL,
    LOCAL_LLM_MODEL: cli.DEFAULT_LOCAL_LLM_MODEL,
  };
  cli.applyToTargets(localValues, home);

  const afterSwitch = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in afterSwitch.env));  // stale gateway token cleared
  assert.ok(!('OPENROUTER_BYOK_KEY' in afterSwitch.env));
  assert.ok(!('OPENROUTER_BYOK_MODEL' in afterSwitch.env));
  assert.equal(afterSwitch.env.LOCAL_LLM_API_URL, cli.DEFAULT_LOCAL_LLM_URL);
  assert.equal(afterSwitch.env.LOCAL_LLM_MODEL, cli.DEFAULT_LOCAL_LLM_MODEL);

  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.token_optimizer.env.LOCAL_LLM_API_URL, cli.DEFAULT_LOCAL_LLM_URL);
  assert.ok(!('LLM_GATEWAY_TOKEN' in cursor.mcpServers.token_optimizer.env));
  assert.ok(!('OPENROUTER_BYOK_KEY' in cursor.mcpServers.token_optimizer.env));
  assert.ok(!('OPENROUTER_BYOK_MODEL' in cursor.mcpServers.token_optimizer.env));
});

test('BYOK-mode values write the OpenRouter key, optional model, and gateway URL, with no gateway token at all', () => {
  const home = tmpHome();
  const values = {
    ...cli.emptyManagedValues(),
    LLM_GATEWAY_URL: cli.DEFAULT_GATEWAY_URL,
    OPENROUTER_BYOK_KEY: 'sk-or-v1-mykey',
    OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini',
  };
  cli.applyToTargets(values, home);
  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.OPENROUTER_BYOK_KEY, 'sk-or-v1-mykey');
  assert.equal(claude.env.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');
  assert.equal(claude.env.LLM_GATEWAY_URL, cli.DEFAULT_GATEWAY_URL);
  assert.ok(!('LLM_GATEWAY_TOKEN' in claude.env));

  const opencode = JSON.parse(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.jsonc'), 'utf8'));
  assert.equal(opencode.mcp.token_optimizer.environment.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');

  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.equal(cursor.mcpServers.token_optimizer.env.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');
});

test('collectByokValues keeps or clears the optional model explicitly', async () => {
  const keep = await cli.collectByokValues(
    readlineWith('', '', ''),
    {
      LLM_GATEWAY_URL: cli.DEFAULT_GATEWAY_URL,
      OPENROUTER_BYOK_KEY: 'sk-or-v1-existing',
      OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini'
    }
  );
  assert.equal(keep.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');

  const clear = await cli.collectByokValues(
    readlineWith('', '', '-'),
    {
      LLM_GATEWAY_URL: cli.DEFAULT_GATEWAY_URL,
      OPENROUTER_BYOK_KEY: 'sk-or-v1-existing',
      OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini'
    }
  );
  assert.equal(clear.OPENROUTER_BYOK_MODEL, '');
});

test('launchctl values round-trip through the state-file seam', () => {
  const home = tmpHome();
  const statePath = path.join(home, 'launchctl-state.json');
  process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH = statePath;
  const plistPath = path.join(home, `${cli.LAUNCH_AGENT_LABEL}.plist`);
  try {
    cli.applyLaunchctlValues({ LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: 'https://g/v1' });
    assert.equal(cli.readLaunchctlValues().LLM_GATEWAY_TOKEN, 'tok');
    /* Persistence: a RunAtLoad LaunchAgent must re-apply the value after reboot. */
    const plist = fs.readFileSync(plistPath, 'utf8');
    assert.ok(plist.includes('<key>RunAtLoad</key>'));
    assert.ok(plist.includes('launchctl setenv LLM_GATEWAY_TOKEN'));
    assert.ok(plist.includes('tok'));
    cli.clearLaunchctlValues();
    assert.ok(!('LLM_GATEWAY_TOKEN' in cli.readLaunchctlValues()));
    assert.ok(!fs.existsSync(plistPath), 'clearing removes the LaunchAgent');
  } finally {
    delete process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH;
  }
});

test('applyDirectiveToTargets inserts the block into existing global instruction files, idempotent on re-run', () => {
  const home = tmpHome();
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# My existing instructions\n');
  const opencodeAgents = path.join(home, '.config', 'opencode', 'AGENTS.md');
  fs.mkdirSync(path.dirname(opencodeAgents), { recursive: true });
  fs.writeFileSync(opencodeAgents, '# OpenCode instructions\n');

  cli.applyDirectiveToTargets(home);
  const first = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(first.includes('# My existing instructions'));
  assert.ok(cli.hasDirectiveBlock(first));
  assert.ok(cli.hasDirectiveBlock(fs.readFileSync(opencodeAgents, 'utf8')));

  cli.applyDirectiveToTargets(home); // re-run must not duplicate
  const second = fs.readFileSync(claudeMd, 'utf8');
  const occurrences = second.split(cli.DIRECTIVE_MARKER_START).length - 1;
  assert.equal(occurrences, 1);
});

test('stripJsonCommentsAndTrailingCommas preserves URLs while removing JSONC comments', () => {
  const stripped = cli.stripJsonCommentsAndTrailingCommas(`{
    "url": "https://example.test/v1", // comment
    "nested": {
      "enabled": true,
    },
    /* block comment */
    "items": [1, 2,],
    "literal": "keep ,] and ,} inside strings",
  }`);
  assert.deepEqual(JSON.parse(stripped), {
    url: 'https://example.test/v1',
    nested: { enabled: true },
    items: [1, 2],
    literal: 'keep ,] and ,} inside strings',
  });
});

test('applyDirectiveToTargets creates missing managed instruction files', () => {
  const home = tmpHome();
  cli.applyDirectiveToTargets(home);
  const agentsPath = path.join(home, '.codex', 'AGENTS.md');
  const opencodePath = path.join(home, '.config', 'opencode', 'AGENTS.md');
  assert.ok(cli.hasDirectiveBlock(fs.readFileSync(agentsPath, 'utf8')));
  assert.ok(cli.hasDirectiveBlock(fs.readFileSync(opencodePath, 'utf8')));
});

test('removeDirectiveFromTargets removes a previously-inserted block and is a no-op when absent', () => {
  const home = tmpHome();
  const agentsMd = path.join(home, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
  fs.writeFileSync(agentsMd, '# Codex rules\n');

  cli.applyDirectiveToTargets(home);
  assert.ok(cli.hasDirectiveBlock(fs.readFileSync(agentsMd, 'utf8')));

  cli.removeDirectiveFromTargets(home);
  const cleaned = fs.readFileSync(agentsMd, 'utf8');
  assert.ok(!cli.hasDirectiveBlock(cleaned));
  assert.ok(cleaned.includes('# Codex rules'));

  cli.removeDirectiveFromTargets(home); // no-op, must not throw
  assert.ok(!cli.hasDirectiveBlock(fs.readFileSync(agentsMd, 'utf8')));
});

test('hasDirectiveBlock returns true if both markers are present, false otherwise', () => {
  assert.equal(cli.hasDirectiveBlock('Some content <!-- TOKEN_OPTIMIZER_START --> foo <!-- TOKEN_OPTIMIZER_END -->'), true);
  assert.equal(cli.hasDirectiveBlock('Some content <!-- TOKEN_OPTIMIZER_START --> foo'), false);
  assert.equal(cli.hasDirectiveBlock('foo <!-- TOKEN_OPTIMIZER_END -->'), false);
  assert.equal(cli.hasDirectiveBlock('just some content'), false);
});

test('applyDirectiveBlock appends the block correctly to content, or replaces it if already present', () => {
  const block = cli.DIRECTIVE_BLOCK;
  assert.equal(cli.applyDirectiveBlock(''), block);
  assert.equal(cli.applyDirectiveBlock('Hello\n'), `Hello\n\n${block}`);
  assert.equal(cli.applyDirectiveBlock('Hello'), `Hello\n\n${block}`);

  const initial = `Hello\n\n${block}`;
  const applied = cli.applyDirectiveBlock(initial);
  assert.equal(applied, `Hello\n\n${block}\n`);
});

test('removeDirectiveBlock removes the block, and collapses multiple newlines (supporting both \\n and \\r\\n line endings)', () => {
  const block = cli.DIRECTIVE_BLOCK;
  assert.equal(cli.removeDirectiveBlock('Hello World'), 'Hello World');

  const contentLf = `Hello\n\n\n${block}\n\n\nWorld`;
  assert.equal(cli.removeDirectiveBlock(contentLf), 'Hello\n\nWorld');

  const blockCrlf = block.replace(/\n/g, '\r\n');
  const contentCrlf = `Hello\r\n\r\n\r\n${blockCrlf}\r\n\r\n\r\nWorld`;
  assert.equal(cli.removeDirectiveBlock(contentCrlf), 'Hello\n\nWorld');
});
