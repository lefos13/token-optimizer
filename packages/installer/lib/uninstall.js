const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { createChangePlan, copyTreeOperation, removeFileOperation, managedBlockOperation, credentialOperation, clientCommandOperation, platformServiceOperation, manifestOperation } = require('./change-plan');
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
  for (const service of manifest.platformServices || []) {
    if (service.ownership === 'installer') operations.push(platformServiceOperation(service.platform, service.service, { path: service.path }));
  }
  if (options.manifestPath) operations.push(manifestOperation(options.manifestPath, warnings.length ? 'retain-warnings' : 'remove'));
  return createChangePlan({ action: 'uninstall', warnings }, operations);
}

function planRepair(report = {}, manifest, options = {}) {
  assertManifest(manifest);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const actionable = findings.filter((item) => item && item.severity !== 'info' && isRepairFinding(item));
  const needed = new Set(actionable.map((item) => item.path).filter(Boolean));
  const operations = [];
  for (const file of manifest.files) {
    const relevant = needed.has(file.path);
    if (!relevant) continue;
    if (file.source) operations.push(copyTreeOperation(trustedRepairSource(file, manifest, options), file.path));
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
  const inverses = []; const applied = [];
  try {
    for (const operation of plan.operations) {
      const inverse = prepareInverse(operation, options);
      if (inverse) inverses.push(inverse);
      applyOperation(operation, options);
      applied.push(operation);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (let index = inverses.length - 1; index >= 0; index -= 1) try { inverses[index](); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    const safe = new Error(rollbackErrors.length ? 'lifecycle operation failed and rollback was incomplete' : 'lifecycle operation failed; earlier mutations were rolled back');
    safe.cause = error; safe.applied = applied; safe.rollbackErrors = rollbackErrors.length;
    throw safe;
  }
  return applied;
}

function prepareInverse(operation, options) {
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
  const state = adapter.capture(operation); return () => adapter.restore(operation, state);
}

function applyOperation(operation, options) {
  if (operation.kind === 'remove-file') fs.rmSync(operation.path, { recursive: true, force: true });
  else if (operation.kind === 'copy-tree') { fs.mkdirSync(path.dirname(operation.path), { recursive: true }); fs.cpSync(operation.source, operation.path, { recursive: true, force: true }); }
  else if (operation.kind === 'managed-block') removeManagedBlock(operation.path, operation.marker);
  else if (operation.kind === 'credential') credentialStore(operation, options).delete(operation.reference);
  else if (operation.kind === 'client-command' && options.registrationAdapter) options.registrationAdapter.apply(operation);
  else if (operation.kind === 'platform-service' && options.serviceAdapter) options.serviceAdapter.apply(operation);
  else if (operation.kind === 'manifest') applyManifestOperation(operation, options);
}

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
  return () => { fs.rmSync(target, { recursive: true, force: true }); if (existed) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.cpSync(copy, target, { recursive: true }); } fs.rmSync(root, { recursive: true, force: true }); };
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

module.exports = { planUninstall, planRepair, currentStateFromManifest, stateHash, applyLifecyclePlan };
