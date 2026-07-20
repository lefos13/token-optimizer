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
const { execFileSync } = require('node:child_process');
const { spawnSync } = require('node:child_process');

function readlineWith(...answers: string[]) {
  return {
    question(_prompt: string, done: (answer: string) => void) {
      done(answers.shift() || '');
    }
  };
}

test('fresh install does not preserve ambient provider state without a canonical installation', () => {
  const ambientOnly = { provider: { mode: 'gateway-token', source: 'ambient', requiresCredential: true, credentialConfigured: true }, manifest: { exists: false, valid: false }, clients: { registrations: [] } };
  assert.equal(cli.shouldPreserveInstalledProvider(ambientOnly), false);
  const installed = { provider: { mode: 'local', source: 'registration', requiresCredential: false, credentialConfigured: true }, manifest: { exists: true, valid: true }, clients: { registrations: [{ stale: false }] } };
  assert.equal(cli.shouldPreserveInstalledProvider(installed), true);
});

test('reinstall does not preserve an inaccessible credential reference', () => {
  const broken = { provider: { mode: 'gateway-token', source: 'registration', requiresCredential: true, credentialConfigured: false }, manifest: { exists: true, valid: true }, clients: { registrations: [{ stale: false }] } };
  assert.equal(cli.shouldPreserveInstalledProvider(broken), false);
});

test('upgrade preservation retains local and BYOK model choices', () => {
  assert.deepEqual(cli.preservedProviderOptions({ mode: 'local', url: 'http://localhost:8080/v1', model: 'local-model-name' }), { provider: 'local', credentialRef: undefined, localApiUrl: 'http://localhost:8080/v1', localModel: 'local-model-name' });
  assert.deepEqual(cli.preservedProviderOptions({ mode: 'gateway-byok', url: 'https://gateway.example/v1', model: 'provider/model', credentialReference: { store: 'config' } }), { provider: 'gateway-byok', credentialRef: { store: 'config' }, gatewayUrl: 'https://gateway.example/v1', byokModel: 'provider/model' });
  assert.deepEqual(cli.preservedProviderOptions({ mode: 'openrouter-direct', url: 'https://openrouter.ai/api/v1', model: 'provider/direct', credentialReference: { store: 'config' } }), { provider: 'openrouter-direct', credentialRef: { store: 'config' }, openrouterUrl: 'https://openrouter.ai/api/v1', byokModel: 'provider/direct' });
});

test('fresh spawned install prompts despite stale ambient provider variables', () => {
  const repository = path.resolve(process.cwd(), '..');
  const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-fresh-prompt-'));
  const staleRef = JSON.stringify({ store: 'macos-keychain', service: 'stale-service', account: 'stale-account' });
  const result = spawnSync(process.execPath, [bin, 'install', '--home', home, '--clients', 'cursor', '--skip-client-commands', '--skip-launchctl', '--no-defaults'], {
    cwd: repository,
    encoding: 'utf8',
    input: '4\n',
    env: { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1', TOKEN_OPTIMIZER_PROVIDER_MODE: 'gateway-token', TOKEN_OPTIMIZER_CREDENTIAL_REF: staleRef },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /How should the LLM provider be configured\?/);
  assert.match(result.stdout, /Gateway access token/);
  assert.match(result.stdout, /Your own OpenRouter key/);
  assert.match(result.stdout, /Local LLM only/);
  assert.match(result.stdout, /Skip for now/);
  assert.doesNotMatch(result.stderr, /SecKeychainSearchCopyNext|Could not find service|Bad request/i);
  const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cursor.mcpServers.token_optimizer.env, {});
});

test('interactive JSON install keeps prompts on stderr and one document on stdout', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-json-prompt-'));
  const result = spawnSync(process.execPath, [bin, 'install', '--home', home, '--clients', 'cursor', '--skip-client-commands', '--skip-launchctl', '--no-defaults', '--json'], { cwd: repository, encoding: 'utf8', input: '4\n', env: { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'completed');
  assert.match(result.stderr, /How should the LLM provider be configured\?/);
  assert.doesNotMatch(result.stdout, /How should the LLM provider/);
});

test('interactive BYOK setup asks for one optional model', async () => {
  const options = await cli.resolveProviderOptions(
    { provider: 'byok' },
    readlineWith('sk-or-v1-mykey', 'openai/gpt-4o-mini')
  );
  assert.equal(options.byokKey, 'sk-or-v1-mykey');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('interactive secret input restores readline output without printing the value', async () => {
  let output = ''; let questionPrompt = ''; const original = (value: string) => { output += value; };
  const rl: any = { output: { write: (value: string) => { output += value; } }, _writeToOutput: original, question: (prompt: string, done: (answer: string) => void) => { questionPrompt = prompt; rl._writeToOutput(prompt); rl._writeToOutput('fixture-secret'); done('fixture-secret'); } };
  const value = await cli.askSecretRequired(rl, 'Credential: ');
  assert.equal(value, 'fixture-secret'); assert.equal(questionPrompt, 'Credential: '); assert.equal(rl._writeToOutput, original); assert.equal(output, 'Credential: \n'); assert.doesNotMatch(output, /fixture-secret/);
});

test('--byok-key and --byok-model configure direct OpenRouter without prompting', async () => {
  const args = cli.parseArgs([
    '--byok-key', 'sk-or-v1-mykey',
    '--byok-model', 'openai/gpt-4o-mini'
  ]);
  const options = await cli.resolveProviderOptions(args, readlineWith());
  assert.equal(options.provider, 'openrouter-direct');
  assert.equal(options.openrouterUrl, installer.DEFAULT_OPENROUTER_URL);
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('explicit gateway-byok remains available for migrated routing', async () => {
  const options = await cli.resolveProviderOptions(cli.parseArgs(['--provider', 'gateway-byok', '--byok-key', 'sk-or-v1-mykey', '--byok-model', 'provider/model']), readlineWith());
  assert.equal(options.provider, 'gateway-byok'); assert.equal(options.gatewayUrl, installer.DEFAULT_GATEWAY_URL); assert.equal(options.openrouterUrl, undefined);
});

test('a BYOK key flag without a model remains non-interactive and uses the OpenRouter default', async () => {
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

test('status --installed-version reports mismatch without a discovered registration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-version-'));
  const repository = path.resolve(process.cwd(), '..');
  const output = execFileSync(process.execPath, [
    path.join(repository, 'packages/installer/bin/token-optimizer.js'), 'status', '--json',
    '--home', home, '--provider', 'local', '--installed-version', '1.9.0',
    '--expected-version', '2.0.0'
  ], { cwd: repository, encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.installedVersionSource, 'option-installed-version');
  assert.ok(report.findings.some((item: any) => item.code === 'VERSION_MISMATCH'));
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
  fs.writeFileSync(source, 'fixture');
  const manifest = { schemaVersion: 2, roots: [path.dirname(source)], assetRoots: [path.dirname(source)], files: [{ path: target, source, sha256: 'x', ownership: 'installer' }] };
  const plan = lifecycle.planRepair({ findings: [{ code: 'MISSING_LAUNCHER', path: target }] }, manifest, { assetsRoot: path.dirname(source) });
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

test('spawned CLI completes install, doctor, repair, uninstall, and repeated uninstall for all five clients', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  for (const client of ['claude', 'codex', 'antigravity', 'opencode', 'cursor']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `to-cli-cycle-${client}-`));
    const base = { cwd: repository, encoding: 'utf8', env: { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } };
    const install = spawnSync(process.execPath, [bin, 'install', '--provider', 'local', '--clients', client, '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
    assert.equal(install.status, 0, `${client} install: ${install.stderr}`);
    const ownership = JSON.parse(fs.readFileSync(path.join(home, '.token-optimizer', 'manifest.json'), 'utf8')); const launchers = ownership.files.filter((item: any) => /start\.(?:js|sh)$/.test(item.path)); assert.ok(launchers.length, `${client} launcher ownership missing`); launchers.forEach((item: any) => fs.rmSync(item.path));
    const doctor = spawnSync(process.execPath, [bin, 'doctor', '--home', home, '--json'], base);
    assert.ok([0, 1].includes(doctor.status), `${client} doctor: ${doctor.stderr}`);
    const pre = JSON.parse(doctor.stdout); assert.ok(pre.findings.some((item: any) => ['STALE_REGISTRATION', 'MISSING_LAUNCHER', 'MANIFEST_ENTRY_MISSING'].includes(item.code)), `${client} missing actionable pre-repair finding`);
    const repair = spawnSync(process.execPath, [bin, 'repair', '--home', home, '--skip-launchctl'], base);
    assert.equal(repair.status, 0, `${client} repair: ${repair.stderr}`);
    const postRepair = spawnSync(process.execPath, [bin, 'status', '--home', home, '--provider', 'local', '--json'], base);
    assert.ok([0, 1].includes(postRepair.status), `${client} post-repair status: ${postRepair.stderr}`);
    const post = JSON.parse(postRepair.stdout); assert.ok(post.clients.configured.includes(client), `${client} not configured after repair: ${postRepair.stdout}`); assert.equal(post.expectedVersion, '2.0.9'); assert.ok(!post.findings.some((item: any) => ['STALE_REGISTRATION', 'MISSING_LAUNCHER', 'MANIFEST_ENTRY_MISSING', 'DUPLICATE_REGISTRATION'].includes(item.code))); assert.equal(post.healthy, true, `${client} post-repair not healthy: ${postRepair.stdout}`);
    /* Launchers and clients create caches after the ownership manifest is written.
       Populate every declared and client-derived location to prove uninstall converges. */
    const finalManifest = JSON.parse(fs.readFileSync(path.join(home, '.token-optimizer', 'manifest.json'), 'utf8'));
    const backupRoot = path.join(home, '.token-optimizer-mcp', 'backups'); fs.mkdirSync(backupRoot, { recursive: true }); fs.writeFileSync(path.join(backupRoot, 'managed.bak'), 'generated');
    for (const cache of finalManifest.cleanupPaths || []) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'runtime-fixture'), 'generated'); }
    const derivedCaches: string[] = [];
    if (client === 'antigravity') {
      derivedCaches.push(path.join(home, '.gemini', 'antigravity-ide', 'mcp', 'token_optimizer'));
      const staleDescriptor = path.join(home, '.gemini', 'config', 'plugins', 'token-optimizer', 'mcp_config.json'); fs.writeFileSync(staleDescriptor, JSON.stringify({ mcpServers: { token_optimizer: { command: 'node', args: [path.join(home, '.gemini', 'config', 'plugins', 'token-optimizer', 'server', 'start.js')], env: {} } } }));
    }
    if (client === 'cursor') derivedCaches.push(path.join(home, '.cursor', 'projects', 'fixture-project', 'mcps', 'user-token_optimizer'));
    for (const cache of derivedCaches) { fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'runtime-fixture'), 'generated'); }
    if (client === 'claude') {
      const settingsPath = path.join(home, '.claude', 'settings.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); settings.unrelatedSetting = 'keep'; settings.extraKnownMarketplaces = { ...(settings.extraKnownMarketplaces || {}), 'token-optimizer-marketplace': { source: 'managed' }, unrelated: { source: 'keep' } }; fs.writeFileSync(settingsPath, JSON.stringify(settings));
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ pluginUsage: { 'token-optimizer@token-optimizer-marketplace': 1, unrelated: 2 }, keep: true }));
      fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'token-optimizer-marketplace': {}, unrelated: {} }));
    }
    const uninstall = spawnSync(process.execPath, [bin, 'uninstall', '--home', home, '--skip-launchctl'], base);
    assert.equal(uninstall.status, 0, `${client} uninstall: ${uninstall.stderr}`);
    for (const cache of [...(finalManifest.cleanupPaths || []), ...derivedCaches]) assert.equal(fs.existsSync(cache), false, `${client} generated cache survived: ${cache}`);
    assert.equal(fs.existsSync(path.join(home, '.token-optimizer')), false, `${client} installer metadata root survived`);
    assert.equal(fs.existsSync(backupRoot), false, `${client} installer backup root survived`);
    if (client === 'antigravity') assert.equal(fs.existsSync(path.join(home, '.gemini', 'config', 'plugins', 'token-optimizer')), false, 'Antigravity plugin-local residue survived');
    if (client === 'claude') {
      const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')); assert.equal(settings.unrelatedSetting, 'keep'); assert.equal(settings.extraKnownMarketplaces.unrelated.source, 'keep'); assert.equal(settings.extraKnownMarketplaces['token-optimizer-marketplace'], undefined);
      const global = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); assert.equal(global.keep, true); assert.equal(global.pluginUsage.unrelated, 2); assert.equal(global.pluginUsage['token-optimizer@token-optimizer-marketplace'], undefined);
      const known = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), 'utf8')); assert.deepEqual(known, { unrelated: {} });
    }
    const repeated = spawnSync(process.execPath, [bin, 'uninstall', '--home', home, '--json'], base);
    assert.equal(JSON.parse(repeated.stdout).status, 'already-uninstalled', `${client}: ${repeated.stdout} ${repeated.stderr}`);
  }
});

test('install/config/defaults honor --home even when it differs from the HOME env var', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'to-home-flag-target-'));
  const decoyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'to-home-flag-decoy-'));
  const base = { cwd: repository, encoding: 'utf8', env: { ...process.env, HOME: decoyHome, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } };
  const install = spawnSync(process.execPath, [bin, 'install', '--provider', 'local', '--clients', 'claude', '--home', targetHome, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(install.status, 0, `install: ${install.stderr}`);
  assert.ok(fs.existsSync(path.join(targetHome, '.claude', 'settings.json')), '--home target should receive the install');
  assert.equal(fs.existsSync(path.join(decoyHome, '.claude')), false, 'HOME env decoy must not receive any files when --home is given');
  const config = spawnSync(process.execPath, [bin, 'config', '--local', '--home', targetHome], base);
  assert.equal(config.status, 0, `config: ${config.stderr}`);
  assert.equal(fs.existsSync(path.join(decoyHome, '.token-optimizer')), false, 'config must not touch the HOME env decoy either');
  const defaultsRun = spawnSync(process.execPath, [bin, 'defaults', '--clients', 'claude', '--home', targetHome], base);
  assert.equal(defaultsRun.status, 0, `defaults: ${defaultsRun.stderr}`);
  assert.ok(fs.existsSync(path.join(targetHome, '.claude', 'CLAUDE.md')), '--home target should receive defaults');
  assert.equal(fs.existsSync(path.join(decoyHome, '.claude', 'CLAUDE.md')), false, 'defaults must not touch the HOME env decoy');
});

test('spawned CLI migrates a real v1 layout, then a follow-up install + repair reaches a healthy state', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-migrate-'));
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' };
  for (const key of ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN', 'LOCAL_LLM_API_URL', 'LOCAL_LLM_MODEL', 'TOKEN_OPTIMIZER_CREDENTIAL_REF', 'TOKEN_OPTIMIZER_PROVIDER_MODE', 'OPENROUTER_BYOK_KEY', 'OPENROUTER_API_KEY']) delete env[key];
  const base = { cwd: repository, encoding: 'utf8', env };
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const v1Settings = { mcpServers: { token_optimizer: { command: 'node', args: ['/old/path/start.js'], env: { LOCAL_LLM_API_URL: 'http://127.0.0.1:8080/v1', LOCAL_LLM_MODEL: 'local-model' } } } };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(v1Settings));

  const dryRun = spawnSync(process.execPath, [bin, 'install', '--migrate', '--dry-run', '--json', '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(dryRun.status, 0, `migrate dry-run: ${dryRun.stderr}`);
  const preview = JSON.parse(dryRun.stdout);
  assert.deepEqual(preview.clients, ['claude']);
  assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'), JSON.stringify(v1Settings), 'dry-run must not mutate the v1 layout');

  const migrate = spawnSync(process.execPath, [bin, 'install', '--migrate', '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(migrate.status, 0, `migrate apply: ${migrate.stderr}`);
  assert.match(migrate.stdout, /Migrated Token Optimizer for: claude/);
  assert.match(migrate.stdout, /repair.*leftover legacy registration/);

  const repeated = spawnSync(process.execPath, [bin, 'install', '--migrate', '--json', '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(repeated.status, 0, `repeated migrate: ${repeated.stderr}`);

  const followUp = spawnSync(process.execPath, [bin, 'install', '--local', '--local-url', 'http://127.0.0.1:8080/v1', '--local-model', 'local-model', '--clients', 'claude', '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(followUp.status, 0, `follow-up install: ${followUp.stderr}`);

  const repair = spawnSync(process.execPath, [bin, 'repair', '--home', home, '--skip-launchctl'], base);
  assert.equal(repair.status, 0, `repair: ${repair.stderr}`);

  const status = spawnSync(process.execPath, [bin, 'doctor', '--home', home, '--provider', 'local', '--json'], base);
  assert.ok([0, 1].includes(status.status), `doctor: ${status.stderr}`);
  const report = JSON.parse(status.stdout);
  assert.ok(!report.findings.some((item: any) => ['STALE_REGISTRATION', 'MISSING_LAUNCHER', 'DUPLICATE_REGISTRATION'].includes(item.code)), `leftover legacy finding after migrate+install+repair: ${status.stdout}`);
  assert.equal(report.healthy, true, `not healthy after migrate+install+repair: ${status.stdout}`);
});

test('uninstall --json without --dry-run actually applies, not just previews', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-json-apply-'));
  const base = { cwd: repository, encoding: 'utf8', env: { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } };
  const install = spawnSync(process.execPath, [bin, 'install', '--provider', 'local', '--clients', 'claude', '--home', home, '--skip-client-commands', '--skip-launchctl'], base);
  assert.equal(install.status, 0, `install: ${install.stderr}`);
  const manifestPath = path.join(home, '.token-optimizer', 'manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest should exist after install');
  const uninstall = spawnSync(process.execPath, [bin, 'uninstall', '--home', home, '--skip-launchctl', '--json'], base);
  assert.equal(uninstall.status, 0, `uninstall --json: ${uninstall.stderr}`);
  const report = JSON.parse(uninstall.stdout);
  assert.equal(report.action, 'uninstall');
  assert.ok(report.operations.length > 0);
  assert.equal(fs.existsSync(manifestPath), false, 'uninstall --json must actually remove the manifest, not just print a plan');
});

test('uninstall reconstructs exact legacy cleanup when the ownership manifest is already missing', () => {
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-reconstructed-uninstall-'));
  const metadata = path.join(home, '.token-optimizer', '.agents', 'plugins', 'marketplace.json'); fs.mkdirSync(path.dirname(metadata), { recursive: true });
  fs.writeFileSync(metadata, JSON.stringify({ name: 'Softaware-marketplace', plugins: [{ name: 'token-optimizer', source: { source: 'local', path: './plugin/codex' } }] }));
  const base = { cwd: repository, encoding: 'utf8', env: { ...process.env, HOME: home, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } };
  const cleanup = spawnSync(process.execPath, [bin, 'uninstall', '--home', home, '--skip-launchctl', '--json'], base);
  assert.equal(cleanup.status, 0, cleanup.stderr); assert.equal(JSON.parse(cleanup.stdout).status, 'completed'); assert.equal(fs.existsSync(metadata), false);
  const repeated = spawnSync(process.execPath, [bin, 'uninstall', '--home', home, '--skip-launchctl', '--json'], base);
  assert.equal(JSON.parse(repeated.stdout).status, 'already-uninstalled');
});

test('install --json emits one final document and verbose progress only on stderr', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-json-install-'));
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  const result = spawnSync(process.execPath, [bin, 'install', '--home', home, '--clients', 'opencode', '--provider', 'skip', '--skip-client-commands', '--skip-launchctl', '--no-defaults', '--json', '--verbose'], { cwd: repository, encoding: 'utf8', env: { ...process.env, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.action, 'install');
  assert.equal(report.status, 'completed');
  assert.equal(report.installedVersion, '2.0.9');
  assert.deepEqual(report.clients, ['opencode']);
  const events = result.stderr.trim().split(/\r?\n/).filter(Boolean).map((line: string) => JSON.parse(line));
  assert.ok(events.some((event: any) => event.event === 'operation-start'));
  assert.ok(events.some((event: any) => event.event === 'complete'));
  assert.doesNotMatch(result.stdout + result.stderr, /LLM_GATEWAY_TOKEN|OPENROUTER_API_KEY/);
});

test('CLI provider switch persists cleared credential ownership in the manifest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'to-cli-clear-credential-'));
  const repository = path.resolve(process.cwd(), '..'); const bin = path.join(repository, 'packages/installer/bin/token-optimizer.js');
  installer.installSelectedClients({ home, assetsRoot: path.join(repository, 'packages/installer/assets'), clients: ['cursor'], provider: 'gateway-token', gatewayToken: 'fixture-owned-token', credentialStore: 'config', skipClientCommands: true, skipLaunchctl: true, defaults: false });
  const result = spawnSync(process.execPath, [bin, 'install', '--home', home, '--clients', 'cursor', '--provider', 'local', '--skip-client-commands', '--skip-launchctl', '--no-defaults', '--quiet'], { cwd: repository, encoding: 'utf8', env: { ...process.env, TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '.token-optimizer', 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.credentials, []);
});
