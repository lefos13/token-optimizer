const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { createChangePlan, copyTreeOperation, removeFileOperation, managedBlockOperation, credentialOperation, clientCommandOperation, platformServiceOperation } = require('./change-plan');
const { createCredentialStore } = require('./credential-store');

/* Lifecycle plans are deliberately side-effect free. They use the ownership
   hashes captured during installation, so uninstall never deletes a file that
   a user changed after the installer created it. Repair is similarly scoped to
   doctor findings instead of reinstalling every managed client. */
function planUninstall(manifest, currentState = {}) {
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
    const actual = stateHash(currentState, block.path);
    if (block.sha256 && actual !== block.sha256) {
      warnings.push({ code: 'USER_MODIFIED_FILE', path: block.path });
      continue;
    }
    operations.push(managedBlockOperation(block.path, block.marker || block.id || 'TOKEN_OPTIMIZER_START'));
  }
  for (const credential of manifest.credentials || []) {
    if (credential.ownership === 'installer' && credential.reference) operations.push(credentialOperation('remove', { reference: credential.reference }));
  }
  for (const registration of manifest.registrations || []) {
    if (registration.ownership === 'installer' && registration.client) operations.push(clientCommandOperation(registration.client, 'remove-registration'));
  }
  for (const service of manifest.platformServices || []) {
    if (service.ownership === 'installer') operations.push(platformServiceOperation(service.platform, service.service));
  }
  return createChangePlan({ action: 'uninstall', warnings }, operations);
}

function planRepair(report = {}, manifest) {
  assertManifest(manifest);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const actionable = findings.filter((item) => item && item.severity !== 'info' && isRepairFinding(item));
  const needed = new Set(actionable.map((item) => item.path).filter(Boolean));
  const operations = [];
  for (const file of manifest.files) {
    const relevant = needed.has(file.path);
    if (!relevant) continue;
    if (file.source) operations.push(copyTreeOperation(file.source, file.path));
    else if (file.kind === 'copy-tree' && file.sourcePath) operations.push(copyTreeOperation(file.sourcePath, file.path));
  }
  for (const finding of actionable) {
    if (['rewrite-registration', 'deduplicate-registration', 'install-client'].includes(finding.operation) && finding.client) operations.push(clientCommandOperation(finding.client, finding.operation));
    if (['rewrite-launch-agent', 'reload-launch-agent'].includes(finding.operation)) operations.push(platformServiceOperation('darwin', finding.operation));
  }
  return createChangePlan({ action: 'repair', findings: actionable.map((item) => item.code).filter(Boolean) }, deduplicateOperations(operations));
}

function isRepairFinding(item) {
  return ['MISSING_LAUNCHER', 'MISSING_FILE', 'CORRUPT_FILE', 'VERSION_MISMATCH', 'CLIENT_NOT_CONFIGURED', 'STALE_REGISTRATION', 'DUPLICATE_REGISTRATION', 'LAUNCH_AGENT_MISSING', 'LAUNCH_AGENT_INVALID', 'LAUNCHCTL_MISMATCH', 'DEPENDENCY_CACHE_INCOMPLETE', 'MANIFEST_HASH_MISMATCH'].includes(item.code);
}

function deduplicateOperations(operations) { const seen = new Set(); return operations.filter((operation) => { const key = JSON.stringify(operation); if (seen.has(key)) return false; seen.add(key); return true; }); }

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
  if (['remove-file', 'copy-tree', 'managed-block'].includes(operation.kind)) return snapshotPath(operation.path);
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

module.exports = { planUninstall, planRepair, currentStateFromManifest, stateHash, applyLifecyclePlan };
