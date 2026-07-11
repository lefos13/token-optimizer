import test from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../packages/installer/bin/token-optimizer.js');
const lifecycle = require('../../../packages/installer/lib/uninstall.js');
const logs = require('../../../packages/installer/lib/logs.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const installer = require('../../../packages/installer/lib/install-core.js');

function readlineWith(...answers: string[]) {
  return {
    question(_prompt: string, done: (answer: string) => void) {
      done(answers.shift() || '');
    }
  };
}

test('interactive BYOK setup asks for one optional model', async () => {
  const options = await cli.resolveProviderOptions(
    { provider: 'byok' },
    readlineWith('sk-or-v1-mykey', 'openai/gpt-4o-mini')
  );
  assert.equal(options.byokKey, 'sk-or-v1-mykey');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('--byok-key and --byok-model configure BYOK without prompting', async () => {
  const args = cli.parseArgs([
    '--byok-key', 'sk-or-v1-mykey',
    '--byok-model', 'openai/gpt-4o-mini'
  ]);
  const options = await cli.resolveProviderOptions(args, readlineWith());
  assert.equal(options.provider, 'gateway-byok');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('a BYOK key flag without a model remains non-interactive and uses gateway defaults', async () => {
  const options = await cli.resolveProviderOptions(
    { byokKey: 'sk-or-v1-mykey' },
    readlineWith('must-not-be-consumed')
  );
  assert.equal(options.byokModel, '');
});

test('--credential-store env is an explicit working plaintext opt-in', async () => {
  const options = await cli.resolveProviderOptions(cli.parseArgs(['--provider', 'gateway-token', '--token', 'fixture-value', '--credential-store', 'env']), readlineWith());
  const credentialEnv: Record<string, string> = { LLM_GATEWAY_TOKEN: 'parent-value' };
  const prepared = installer.prepareCredentialOptions({ ...options, credentialStoreOptions: { env: credentialEnv } });
  const values = installer.buildProviderValues(prepared);
  assert.equal(prepared.credentialRef.store, 'env');
  assert.equal(prepared.credentialRef.variable, 'LLM_GATEWAY_TOKEN');
  assert.equal(credentialEnv.LLM_GATEWAY_TOKEN, 'parent-value');
  assert.equal(values.LLM_GATEWAY_TOKEN, '');
});

test('--credential-store env fails when the parent/client credential variable is absent', async () => {
  const options = await cli.resolveProviderOptions(cli.parseArgs(['--provider', 'gateway-token', '--token', 'fixture-value', '--credential-store', 'env']), readlineWith());
  assert.throws(() => installer.prepareCredentialOptions({ ...options, credentialStoreOptions: { env: {} } }), /requires LLM_GATEWAY_TOKEN.*parent\/client environment/i);
});

test('uninstall preserves a user-modified managed file', () => {
  const managed = path.join(os.tmpdir(), 'token-optimizer-user-modified');
  const manifest = { schemaVersion: 2, roots: [path.dirname(managed)], files: [{ path: managed, sha256: 'expected', ownership: 'installer' }] };
  const plan = lifecycle.planUninstall(manifest, { hash: () => 'changed' });
  assert.equal(plan.operations.some((operation: any) => operation.path === managed), false);
  assert.ok(plan.warnings.some((warning: any) => warning.code === 'USER_MODIFIED_FILE'));
});

test('repair derives only operations required by doctor findings', () => {
  const source = path.join(os.tmpdir(), 'token-optimizer-source');
  const target = path.join(os.tmpdir(), 'token-optimizer-target');
  const manifest = { schemaVersion: 2, roots: [path.dirname(source)], files: [{ path: target, source, sha256: 'x', ownership: 'installer' }] };
  const plan = lifecycle.planRepair({ findings: [{ code: 'MISSING_LAUNCHER', path: target }] }, manifest);
  assert.deepEqual(plan.operations.map((operation: any) => operation.kind), ['copy-tree']);
});

test('logs require an absolute workspace and purge protects metadata by default', async () => {
  await assert.rejects(() => logs.statusLogs('relative-workspace'), /absolute/);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'to-logs-'));
  const directory = path.join(workspace, '.codex-local-test-runs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'run.log'), 'run');
  fs.writeFileSync(path.join(directory, 'baseline.json'), '{}');
  fs.writeFileSync(path.join(directory, 'analytics.json'), '{}');
  await logs.purgeLogs(directory === workspace ? workspace : workspace);
  assert.equal(fs.existsSync(path.join(directory, 'run.log')), false);
  assert.equal(fs.existsSync(path.join(directory, 'baseline.json')), true);
  assert.equal(fs.existsSync(path.join(directory, 'analytics.json')), true);
});

test('logs reject a symlinked managed directory', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'to-logs-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'to-logs-outside-'));
  fs.symlinkSync(outside, path.join(workspace, '.codex-local-test-runs'), 'dir');
  await assert.rejects(() => logs.statusLogs(workspace), /real directory|escapes workspace/);
});
