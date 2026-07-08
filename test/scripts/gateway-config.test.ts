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
  assert.equal(gemini.mcpServers.local_tester.env.LLM_GATEWAY_TOKEN, 'person-token');

  assert.equal(cli.collectCurrentValues(home).LLM_GATEWAY_TOKEN, 'person-token');

  cli.applyToTargets({}, home);
  const cleared = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in cleared.env));
});

test('launchctl values round-trip through the state-file seam', () => {
  const home = tmpHome();
  const statePath = path.join(home, 'launchctl-state.json');
  process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH = statePath;
  try {
    cli.applyLaunchctlValues({ LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: 'https://g/v1' });
    assert.equal(cli.readLaunchctlValues().LLM_GATEWAY_TOKEN, 'tok');
    cli.clearLaunchctlValues();
    assert.ok(!('LLM_GATEWAY_TOKEN' in cli.readLaunchctlValues()));
  } finally {
    delete process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
  }
});
