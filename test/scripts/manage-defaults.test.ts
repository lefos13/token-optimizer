import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* The defaults CLI is a CommonJS script under scripts/. From the compiled test at
   .test-build/test/scripts/, it resolves at ../../../scripts/manage-defaults.js. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../scripts/manage-defaults.js');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'def-cfg-'));
}

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

test('normalizeCommand parses valid commands and rejects invalid ones', () => {
  assert.equal(cli.normalizeCommand('enable-defaults'), 'enable-defaults');
  assert.equal(cli.normalizeCommand('DISABLE-DEFAULTS'), 'disable-defaults');
  assert.equal(cli.normalizeCommand('status'), 'status');
  assert.equal(cli.normalizeCommand('help'), 'help');
  assert.equal(cli.normalizeCommand('unknown'), '');
  assert.equal(cli.normalizeCommand(''), '');
});
