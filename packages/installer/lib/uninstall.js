const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { createChangePlan, copyTreeOperation, removeFileOperation, removeEmptyDirectoryOperation, managedBlockOperation, credentialOperation, clientCommandOperation, platformServiceOperation, manifestOperation } = require('./change-plan');
const { writeManifest } = require('./manifest');
const { createCredentialStore } = require('./credential-store');

/* Lifecycle plans are deliberately side-effect free. They use the ownership
   hashes captured during installation, so uninstall never deletes a file that
   a user changed after the installer created it. Repair is similarly scoped to
   doctor findings instead of reinstalling every managed client. */
function planUninstall(manifest, currentState = {}, options = {}) {
  assertManifest(manifest);
  const operations = [];
  const warnings = [];
  for (const file of manifest.files) {
    const actual = stateHash(currentState, file.path);
    if (actual !== file.sha256) {
      warnings.push({ code: 'USER_MODIFIED_FILE', path: file.path });
      continue;
    }
    operations.push(removeFileOperation(file.path));
  }
  const cleanupPaths = discoverCleanupPaths(manifest, options.home);
  for (const cleanupPath of cleanupPaths) operations.push(removeFileOperation(cleanupPath));
  for (const block of manifest.managedBlocks || []) {
    const actual = managedBlockHash(block.path, block.marker || block.id || 'TOKEN_OPTIMIZER_START');
    if ((block.blockSha256 || block.sha256) && actual !== (block.blockSha256 || block.sha256)) {
      warnings.push({ code: 'USER_MODIFIED_BLOCK', path: block.path });
      continue;
    }
    operations.push(managedBlockOperation(block.path, block.marker || block.id || 'TOKEN_OPTIMIZER_START'));
  }
  for (const credential of manifest.credentials || []) {
    if (credential.ownership === 'installer' && credential.reference) operations.push(credentialOperation('remove', { reference: credential.reference }));
  }
  for (const registration of manifest.registrations || []) {
    if (registration.ownership === 'installer' && registration.client) operations.push(clientCommandOperation(registration.client, 'remove-registration', { paths: registration.paths || [], recipe: registration.kind === 'marketplace' ? { remove: registration.remove, restore: registration.restore } : undefined }));
  }
  if (options.home) operations.push(clientCommandOperation('all', 'cleanup-installer-metadata', { paths: installerMetadataPaths(options.home) }));
  for (const service of manifest.platformServices || []) {
    if (service.ownership === 'installer') operations.push(platformServiceOperation(service.platform, service.service, { path: service.path, envKeys: Object.keys(service.managedEnv || {}) }));
  }
  if (options.manifestPath) operations.push(manifestOperation(options.manifestPath, warnings.length ? 'retain-warnings' : 'remove'));
  if (cleanupPaths.length || options.home) {
    for (const root of [...new Set(manifest.roots || [])].filter((entry) => installerOwnedRoot(entry, options.home)).sort((a, b) => b.length - a.length)) operations.push(removeEmptyDirectoryOperation(root));
    if (options.home) for (const root of emptyCleanupRoots(options.home)) operations.push(removeEmptyDirectoryOperation(root));
  }
  return createChangePlan({ action: 'uninstall', warnings }, operations);
}

/* Runtime caches can appear after the manifest is written, so uninstall combines
   declared cache roots with bounded client-generated locations discovered at apply time. */
function discoverCleanupPaths(manifest, home) {
  const result = new Set(manifest.cleanupPaths || []);
  if (Array.isArray(manifest.cleanupPaths) || home) {
    for (const root of (manifest.roots || []).filter((entry) => installerOwnedRoot(entry, home))) { result.add(path.join(root, '.data')); result.add(path.join(root, 'server', '.data')); }
  }
  if (home) {
    result.add(path.join(home, '.token-optimizer-mcp', 'backups'));
    const legacyLog = path.join(home, '.token-optimizer-mcp', 'start.log');
    if (isGeneratedLegacyLog(legacyLog)) result.add(legacyLog);
    for (const metadata of generatedMarketplaceMetadataPaths(home)) if (isGeneratedMarketplaceMetadata(metadata)) result.add(metadata);
    const pluginLocalDescriptor = path.join(home, '.gemini', 'config', 'plugins', 'token-optimizer', 'mcp_config.json');
    if (isGeneratedAntigravityDescriptor(pluginLocalDescriptor, home)) result.add(pluginLocalDescriptor);
    result.add(path.join(home, '.gemini', 'antigravity-ide', 'mcp', 'token_optimizer'));
    result.add(path.join(home, '.gemini', 'antigravity', 'mcp', 'token_optimizer'));
    const legacyGeminiCache = path.join(home, '.gemini', 'tmp', 'local-tester-mcp');
    if (hasGeneratedIdentity(legacyGeminiCache)) result.add(legacyGeminiCache);
    const projects = path.join(home, '.cursor', 'projects');
    let entries = []; try { entries = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).slice(0, 1000); } catch (_) {}
    for (const entry of entries) for (const name of ['plugin-token-optimizer-token_optimizer', 'user-token_optimizer']) result.add(path.join(projects, entry.name, 'mcps', name));
  }
  return [...result].filter((entry) => typeof entry === 'string' && path.isAbsolute(entry));
}

/* Old packages copied the two marketplace catalogs outside the manifest and
   left empty cache ancestors behind. Exact catalog identities make the files
   safe to remove; recursive empty-directory pruning never deletes user data. */
function generatedMarketplaceMetadataPaths(home) {
  const root = path.join(path.resolve(home), '.token-optimizer');
  return [path.join(root, '.agents', 'plugins', 'marketplace.json'), path.join(root, '.claude-plugin', 'marketplace.json')];
}

function isGeneratedMarketplaceMetadata(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); const plugins = data.plugins;
    if (!Array.isArray(plugins) || plugins.length !== 1 || plugins[0]?.name !== 'token-optimizer') return false;
    if (data.name === 'Softaware-marketplace') return plugins[0]?.source?.source === 'local' && plugins[0]?.source?.path === './plugin/codex';
    if (data.name === 'token-optimizer-marketplace') return plugins[0]?.source === './plugin/claude';
    return false;
  } catch (_) { return false; }
}

function isGeneratedLegacyLog(file) {
  try { return /token[_-]optimizer|Token Optimizer|@modelcontextprotocol/i.test(fs.readFileSync(file, 'utf8').slice(0, 256 * 1024)); } catch (_) { return false; }
}

function emptyCleanupRoots(home) {
  const root = path.resolve(home);
  return [
    path.join(root, '.token-optimizer'), path.join(root, '.token-optimizer-mcp'),
    path.join(root, '.claude', 'plugins', 'cache', 'token-optimizer-marketplace', 'token-optimizer'),
    path.join(root, '.codex', 'plugins', 'cache', 'Softaware-marketplace', 'token-optimizer'),
    path.join(root, '.codex', 'plugins', 'token-optimizer'),
    path.join(root, '.gemini', 'config', 'plugins', 'token-optimizer'),
    path.join(root, '.config', 'opencode', 'token-optimizer-server'),
    path.join(root, '.config', 'opencode', 'skills', 'token-optimizer'),
    path.join(root, '.cursor', 'token-optimizer-server'),
  ];
}

function hasRecognizedUninstallState(home) {
  const synthetic = { schemaVersion: 3, roots: [], files: [] };
  if (discoverCleanupPaths(synthetic, home).some((entry) => fs.existsSync(entry))) return true;
  if (emptyCleanupRoots(home).some((entry) => isEmptyTree(entry))) return true;
  return installerMetadataPaths(home).some((file) => {
    try { return /token[_-]?optimizer|TOKEN_OPTIMIZER_|LLM_GATEWAY_|LOCAL_LLM_|OPENROUTER_/i.test(fs.readFileSync(file, 'utf8')); } catch (_) { return false; }
  });
}

function isEmptyTree(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isEmptyTree(path.join(root, entry.name)));
  } catch (_) { return false; }
}

function isGeneratedAntigravityDescriptor(file, home) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')); const top = Object.keys(data); const servers = data.mcpServers;
    if (top.length !== 1 || top[0] !== 'mcpServers' || !servers || Object.keys(servers).length !== 1) return false;
    const entry = servers.token_optimizer || servers['token-optimizer']; const expectedRoot = path.join(path.resolve(home), '.gemini', 'config', 'plugins', 'token-optimizer', 'server');
    const launcher = Array.isArray(entry?.args) && entry.args.length ? path.resolve(String(entry.args[0])) : '';
    return entry?.command === 'node' && (launcher === path.join(expectedRoot, 'start.js') || launcher === path.join(expectedRoot, 'start.sh'));
  } catch (_) { return false; }
}

function installerOwnedRoot(candidate, home) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate); const base = path.basename(resolved);
  if (home && [path.join(path.resolve(home), '.token-optimizer'), path.join(path.resolve(home), '.token-optimizer-mcp', 'backups')].includes(resolved)) return true;
  return ['token-optimizer', 'token-optimizer-server'].includes(base) || resolved.includes(`${path.sep}.token-optimizer${path.sep}`);
}

function hasGeneratedIdentity(root) {
  for (const relative of ['package.json', path.join('server', 'package.json'), path.join('.claude-plugin', 'plugin.json'), path.join('.codex-plugin', 'plugin.json')]) {
    try { const data = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); if (data.name === 'token-optimizer' || data.name === 'token-optimizer-mcp') return true; } catch (_) {}
  }
  return false;
}

function installerMetadataPaths(home) { return [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json'), path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), path.join(home, '.codex', 'config.toml')]; }

function planRepair(report = {}, manifest, options = {}) {
  assertManifest(manifest);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const actionable = findings.filter((item) => item && item.severity !== 'info' && isRepairFinding(item));
  const needed = new Set(actionable.map((item) => item.path).filter(Boolean));
  const operations = [];
  for (const file of manifest.files) {
    const relevant = needed.has(file.path);
    if (!relevant) continue;
    if (file.source || file.assetPath) operations.push(copyTreeOperation(trustedRepairSource(file, manifest, options), file.path));
    else if (file.kind === 'copy-tree' && file.sourcePath) operations.push(copyTreeOperation(trustedRepairSource({ ...file, source: file.sourcePath }, manifest, options), file.path));
  }
  for (const finding of actionable) {
    if (finding.code === 'MISSING_LAUNCHER') { const launchers = manifest.files.filter((file) => /start\.js$/.test(file.path) && (!finding.client || file.path.includes(`/${finding.client}/`) || finding.path && file.path.startsWith(finding.path))); for (const launcher of launchers) { const cachePath = trustedRuntimeCache(path.join(path.dirname(launcher.path), '.data', 'node_modules'), options); operations.push(removeFileOperation(cachePath)); operations.push(clientCommandOperation(finding.client || 'runtime', 'bootstrap-runtime', { launcherPath: launcher.path, networkPotential: true })); } }
    if (finding.operation === 'refresh-runtime' && finding.code === 'DEPENDENCY_CACHE_INCOMPLETE' && finding.path) { const cachePath = trustedRuntimeCache(finding.path, options); operations.push(removeFileOperation(cachePath)); operations.push(clientCommandOperation(finding.client || 'runtime', 'bootstrap-runtime', { launcherPath: path.join(path.dirname(path.dirname(cachePath)), 'start.js'), networkPotential: true })); }
    if (['rewrite-registration', 'deduplicate-registration', 'install-client'].includes(finding.operation)) { const owned = (manifest.registrations || []).filter((item) => !finding.client || item.client === finding.client); const canonicalOwned = owned.find((item) => item.template); const identities = finding.registrations || []; const canonical = finding.canonical; const extraIdentities = identities.filter((item) => !canonical || item.type !== canonical.type || item.path !== canonical.path || item.name !== canonical.name); for (const identity of extraIdentities.filter((item) => item.type !== 'marketplace')) operations.push(clientCommandOperation(identity.client || finding.client, 'remove-registration-identity', { paths: [identity.path], identity })); if (extraIdentities.some((item) => item.type === 'marketplace')) { const external = owned.find((item) => item.kind === 'marketplace'); if (external) operations.push(clientCommandOperation(external.client, 'normalize-marketplace-registration', { paths: [], identities: extraIdentities.filter((item) => item.type === 'marketplace'), canonicalIdentity: canonical?.type === 'marketplace' ? canonical : null, recipe: { remove: external.remove, restore: canonical?.type === 'marketplace' ? external.restore : null } })); } if ((!canonical || canonical.type === 'direct') && canonicalOwned) operations.push(clientCommandOperation(canonicalOwned.client, 'upsert-registration', { paths: [], canonicalPath: canonicalOwned.canonicalPath, template: canonicalOwned.template, identity: canonical || { name: 'token_optimizer', type: 'direct', path: canonicalOwned.canonicalPath } })); }
    if (['rewrite-launch-agent', 'reload-launch-agent', 'apply-managed-env'].includes(finding.operation)) { const service = (manifest.platformServices || []).find((item) => item.path === finding.path) || {}; operations.push(platformServiceOperation('darwin', service.service || 'com.softawarest.token-optimizer.env', { path: finding.path || service.path, action: finding.operation, envKeys: finding.envKey ? [finding.envKey] : undefined })); }
  }
  if (options.manifestPath && operations.length) operations.push(manifestOperation(options.manifestPath, 'refresh-hashes'));
  return createChangePlan({ action: 'repair', findings: actionable.map((item) => item.code).filter(Boolean) }, deduplicateOperations(operations));
}

function isRepairFinding(item) {
  return ['MISSING_LAUNCHER', 'LAUNCHER_NOT_EXECUTABLE', 'MISSING_FILE', 'CORRUPT_FILE', 'VERSION_MISMATCH', 'CLIENT_NOT_CONFIGURED', 'STALE_REGISTRATION', 'DUPLICATE_REGISTRATION', 'LAUNCH_AGENT_MISSING', 'LAUNCH_AGENT_INVALID', 'LAUNCHCTL_MISMATCH', 'LAUNCHCTL_ENV_MISMATCH', 'DEPENDENCY_CACHE_INCOMPLETE', 'MANIFEST_ENTRY_MISSING', 'MANIFEST_HASH_MISMATCH'].includes(item.code);
}

function deduplicateOperations(operations) { const seen = new Set(); return operations.filter((operation) => { const key = JSON.stringify(operation); if (seen.has(key)) return false; seen.add(key); return true; }); }

function trustedRepairSource(file, manifest, options) {
  const trustedRoot = options.assetsRoot && path.resolve(options.assetsRoot);
  if (!trustedRoot) throw Object.assign(new Error('trusted installer assets root is required for repair'), { code: 'REPAIR_SOURCE_UNTRUSTED' });
  if (file.assetPath) {
    const source = path.resolve(trustedRoot, file.assetPath);
    if (!(source === trustedRoot || source.startsWith(`${trustedRoot}${path.sep}`)) || !fs.existsSync(source)) throw Object.assign(new Error('packaged repair source is unavailable'), { code: 'REPAIR_SOURCE_UNAVAILABLE' });
    return source;
  }
  const declared = (manifest.assetRoots || []).map((root) => path.resolve(root)).find((root) => file.source === root || file.source.startsWith(`${root}${path.sep}`));
  if (!declared) throw Object.assign(new Error('manifest repair source is outside declared assets'), { code: 'REPAIR_SOURCE_UNTRUSTED' });
  const relative = path.relative(declared, file.source); const source = path.resolve(trustedRoot, relative);
  if (!(source === trustedRoot || source.startsWith(`${trustedRoot}${path.sep}`)) || !fs.existsSync(source)) throw Object.assign(new Error('packaged repair source is unavailable'), { code: 'REPAIR_SOURCE_UNAVAILABLE' });
  return source;
}

function trustedRuntimeCache(candidate, options) { const target = path.resolve(candidate); if (!target.endsWith(`${path.sep}.data${path.sep}node_modules`)) throw Object.assign(new Error('runtime cache path is not launcher-owned'), { code: 'REPAIR_RUNTIME_PATH_UNTRUSTED' }); const roots = (options.managedRoots || []).map((root) => path.resolve(root)); if (!roots.some((root) => target.startsWith(`${root}${path.sep}`))) throw Object.assign(new Error('runtime cache path is outside managed roots'), { code: 'REPAIR_RUNTIME_PATH_UNTRUSTED' }); let current = target; while (!fs.existsSync(current)) current = path.dirname(current); const real = fs.realpathSync.native(current); const canonicalRoots = roots.map((root) => { let existing = root; while (!fs.existsSync(existing)) existing = path.dirname(existing); return path.join(fs.realpathSync.native(existing), path.relative(existing, root)); }); if (!canonicalRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`) || root.startsWith(`${real}${path.sep}`))) throw Object.assign(new Error('runtime cache canonical path is outside managed roots'), { code: 'REPAIR_RUNTIME_PATH_UNTRUSTED' }); return target; }

function assertManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) throw new TypeError('manifest with files is required');
  const roots = [...(manifest.roots || []), ...(manifest.assetRoots || [])].filter((root) => typeof root === 'string' && path.isAbsolute(root)).map((root) => path.resolve(root));
  for (const file of manifest.files) {
    if (file.source && (!path.isAbsolute(file.source) || !roots.some((root) => file.source === root || file.source.startsWith(`${root}${path.sep}`)))) throw new Error(`manifest source outside trusted roots: ${file.source}`);
    if (file.assetPath && (path.isAbsolute(file.assetPath) || file.assetPath.split(/[\\/]/).includes('..'))) throw new Error(`manifest asset path is not package-relative: ${file.assetPath}`);
  }
  for (const cleanupPath of manifest.cleanupPaths || []) {
    const resolved = typeof cleanupPath === 'string' && path.isAbsolute(cleanupPath) ? path.resolve(cleanupPath) : null;
    if (!resolved || !roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) throw new Error(`manifest cleanup path outside trusted roots: ${cleanupPath}`);
  }
}

function stateHash(state, filePath) {
  if (state && typeof state.hash === 'function') return state.hash(filePath);
  if (state && state.files && Object.prototype.hasOwnProperty.call(state.files, filePath)) {
    const entry = state.files[filePath];
    return typeof entry === 'string' ? entry : entry && entry.sha256;
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null;
  }
}

function currentStateFromManifest(manifest) {
  const files = Object.fromEntries((manifest.files || []).map((file) => [file.path, stateHash({}, file.path)]));
  return { files, hash(filePath) { return files[filePath]; } };
}

/* Every mutation captures an inverse before it runs. External client/service
   state is fail-closed unless a reversible adapter is supplied, preventing a
   successful-looking uninstall that silently leaves registrations behind. */
function applyLifecyclePlan(plan, options = {}) {
  if (!plan || !Array.isArray(plan.operations)) throw new TypeError('invalid lifecycle plan');
  const inverses = []; const applied = []; const notify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  try {
    for (let index = 0; index < plan.operations.length; index += 1) {
      const operation = plan.operations[index];
      notify({ schemaVersion: 1, event: 'operation-start', phase: operation.phase || plan.action || 'lifecycle', sequence: index + 1, total: plan.operations.length, operationId: operation.id || operation.kind, kind: operation.kind, client: operation.client, path: operation.path, status: 'running', message: `running: ${operation.id || operation.kind}` });
      const inverse = prepareInverse(operation, options);
      if (inverse) inverses.push(inverse);
      applyOperation(operation, options);
      applied.push(operation);
      notify({ schemaVersion: 1, event: 'operation-complete', phase: operation.phase || plan.action || 'lifecycle', sequence: index + 1, total: plan.operations.length, operationId: operation.id || operation.kind, kind: operation.kind, client: operation.client, path: operation.path, status: 'completed', message: `completed: ${operation.id || operation.kind}` });
    }
    for (const inverse of inverses) if (typeof inverse.dispose === 'function') inverse.dispose();
    notify({ schemaVersion: 1, event: 'complete', phase: plan.action || 'lifecycle', sequence: plan.operations.length, total: plan.operations.length, status: 'completed', message: `completed: ${plan.action || 'lifecycle'}` });
  } catch (error) {
    notify({ schemaVersion: 1, event: 'rollback-start', phase: plan.action || 'lifecycle', sequence: applied.length, total: plan.operations.length, status: 'rolling-back', message: `rolling-back: ${plan.action || 'lifecycle'}` });
    const rollbackErrors = [];
    for (let index = inverses.length - 1; index >= 0; index -= 1) try { inverses[index](); notify({ schemaVersion: 1, event: 'operation-rolled-back', phase: plan.action || 'lifecycle', sequence: index + 1, total: plan.operations.length, status: 'rolled-back', message: `rolled-back: ${plan.action || 'lifecycle'}` }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    for (const inverse of inverses) if (typeof inverse.dispose === 'function') try { inverse.dispose(); } catch (_) {}
    const safe = new Error(rollbackErrors.length ? 'lifecycle operation failed and rollback was incomplete' : 'lifecycle operation failed; earlier mutations were rolled back');
    safe.cause = error; safe.applied = applied; safe.rollbackErrors = rollbackErrors.length;
    notify({ schemaVersion: 1, event: 'complete', phase: plan.action || 'lifecycle', sequence: applied.length, total: plan.operations.length, status: 'failed', message: `failed: ${plan.action || 'lifecycle'}` });
    throw safe;
  }
  return applied;
}

function prepareInverse(operation, options) {
  if (operation.kind === 'remove-empty-directory') return captureDirectoryStructure(operation.path);
  if (['remove-file', 'copy-tree', 'managed-block', 'manifest'].includes(operation.kind)) return snapshotPath(operation.path);
  if (operation.kind === 'credential') {
    const store = credentialStore(operation, options); const previous = store.get(operation.reference);
    return previous == null ? () => {} : () => store.set(previous, operation.reference);
  }
  const adapter = operation.kind === 'client-command' ? options.registrationAdapter : operation.kind === 'platform-service' ? options.serviceAdapter : null;
  if (!adapter) {
    if (options.requireExternalAdapters === true) throw new Error(`reversible ${operation.kind} adapter unavailable`);
    return () => {};
  }
  if (typeof adapter.capture !== 'function' || typeof adapter.apply !== 'function' || typeof adapter.restore !== 'function') throw new Error(`reversible ${operation.kind} adapter unavailable`);
  const state = adapter.capture(operation); const inverse = () => adapter.restore(operation, state); inverse.dispose = () => { if (typeof adapter.dispose === 'function') adapter.dispose(operation, state); }; return inverse;
}

function applyOperation(operation, options) {
  if (operation.kind === 'remove-file') fs.rmSync(operation.path, { recursive: true, force: true });
  else if (operation.kind === 'copy-tree') { fs.mkdirSync(path.dirname(operation.path), { recursive: true }); fs.cpSync(operation.source, operation.path, { recursive: true, force: true }); }
  else if (operation.kind === 'managed-block') removeManagedBlock(operation.path, operation.marker);
  else if (operation.kind === 'credential') credentialStore(operation, options).delete(operation.reference);
  else if (operation.kind === 'client-command' && options.registrationAdapter) options.registrationAdapter.apply(operation);
  else if (operation.kind === 'platform-service' && options.serviceAdapter) options.serviceAdapter.apply(operation);
  else if (operation.kind === 'manifest') applyManifestOperation(operation, options);
  else if (operation.kind === 'remove-empty-directory') removeEmptyDirectories(operation.path);
}

function captureDirectoryStructure(root) { const directories = []; const walk = (directory) => { let entries = []; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; } directories.push(directory); for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name)); }; walk(root); return () => { for (const directory of directories) fs.mkdirSync(directory, { recursive: true }); }; }
function removeEmptyDirectories(root) { let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; } for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink()) removeEmptyDirectories(path.join(root, entry.name)); try { fs.rmdirSync(root); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; } }

function applyManifestOperation(operation, options) {
  if (!options.manifest) throw new Error('manifest state is required');
  if (operation.action === 'remove') fs.rmSync(operation.path, { force: true });
  else if (operation.action === 'refresh-hashes') { writeManifest(options.home, { ...options.manifest, files: options.manifest.files.map((file) => fs.existsSync(file.path) ? { ...file, sha256: crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex') } : file) }); }
  else {
    const warned = new Set((options.planWarnings || []).map((warning) => warning.path));
    writeManifest(options.home, { ...options.manifest, files: (options.manifest.files || []).filter((file) => warned.has(file.path)), managedBlocks: (options.manifest.managedBlocks || []).filter((block) => warned.has(block.path)), credentials: [], registrations: [], platformServices: [] });
  }
}

function credentialStore(operation, options) { const ref = operation.reference; const kind = ref.store === 'config' || ref.store === 'protected-config' ? 'config' : 'native'; return options.credentialStoreFactory ? options.credentialStoreFactory(ref) : createCredentialStore(kind, { service: ref.service, account: ref.account, path: ref.path }); }

function snapshotPath(target) {
  const existed = fs.existsSync(target); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-lifecycle-')); const copy = path.join(root, 'state');
  if (existed) fs.cpSync(target, copy, { recursive: true });
  const inverse = () => { fs.rmSync(target, { recursive: true, force: true }); if (existed) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(copy, target, { recursive: true }); } }; inverse.dispose = () => fs.rmSync(root, { recursive: true, force: true }); return inverse;
}

function removeManagedBlock(filePath, marker) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const start = marker.includes('<!--') ? marker : `<!-- ${marker} -->`;
  const end = marker.includes('<!--') ? marker.replace('START', 'END') : `<!-- ${marker.replace('START', 'END')} -->`;
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = text.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), '\n');
  if (next !== text) fs.writeFileSync(filePath, next);
}

function managedBlockHash(filePath, marker) { try { const text = fs.readFileSync(filePath, 'utf8'); const start = marker.includes('<!--') ? marker : `<!-- ${marker} -->`; const end = marker.includes('<!--') ? marker.replace('START', 'END') : `<!-- ${marker.replace('START', 'END')} -->`; const match = text.match(new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); return match ? crypto.createHash('sha256').update(match[0]).digest('hex') : null; } catch (_) { return null; } }

module.exports = { planUninstall, planRepair, currentStateFromManifest, stateHash, applyLifecyclePlan, discoverCleanupPaths, installerMetadataPaths, installerOwnedRoot, hasGeneratedIdentity, isGeneratedAntigravityDescriptor, isGeneratedMarketplaceMetadata, isGeneratedLegacyLog, emptyCleanupRoots, hasRecognizedUninstallState };
