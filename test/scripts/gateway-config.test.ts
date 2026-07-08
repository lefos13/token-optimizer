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

test('GATEWAY_ENV_KEYS is exactly the two gateway vars', () => {
  assert.deepEqual(cli.GATEWAY_ENV_KEYS, ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN']);
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

test('applyToTargets writes gateway values to Claude + Gemini configs, collect reads them back, empty clears', () => {
  const home = tmpHome();
  const values = { LLM_GATEWAY_URL: 'https://llm-proxy.lnf.gr/v1', LLM_GATEWAY_TOKEN: 'person-token' };
  cli.applyToTargets(values, home);

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.LLM_GATEWAY_TOKEN, 'person-token');
  assert.equal(claude.env.LLM_GATEWAY_URL, 'https://llm-proxy.lnf.gr/v1');

  const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(gemini.mcpServers.token_optimizer.env.LLM_GATEWAY_TOKEN, 'person-token');

  assert.equal(cli.collectCurrentValues(home).LLM_GATEWAY_TOKEN, 'person-token');

  cli.applyToTargets({}, home);
  const cleared = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in cleared.env));
});

test('launchctl values round-trip through the state-file seam', () => {
  const home = tmpHome();
  const statePath = path.join(home, 'launchctl-state.json');
  process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH = statePath;
  try {
    cli.applyLaunchctlValues({ LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: 'https://g/v1' });
    assert.equal(cli.readLaunchctlValues().LLM_GATEWAY_TOKEN, 'tok');
    cli.clearLaunchctlValues();
    assert.ok(!('LLM_GATEWAY_TOKEN' in cli.readLaunchctlValues()));
  } finally {
    delete process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH;
  }
});

test('applyDirectiveToTargets inserts the block into existing global instruction files, idempotent on re-run', () => {
  const home = tmpHome();
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# My existing instructions\n');

  cli.applyDirectiveToTargets(home);
  const first = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(first.includes('# My existing instructions'));
  assert.ok(cli.hasDirectiveBlock(first));

  cli.applyDirectiveToTargets(home); // re-run must not duplicate
  const second = fs.readFileSync(claudeMd, 'utf8');
  const occurrences = second.split(cli.DIRECTIVE_MARKER_START).length - 1;
  assert.equal(occurrences, 1);
});

test('applyDirectiveToTargets skips files that do not exist', () => {
  const home = tmpHome(); // no .codex/AGENTS.md created
  cli.applyDirectiveToTargets(home); // must not throw or create the file
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
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

