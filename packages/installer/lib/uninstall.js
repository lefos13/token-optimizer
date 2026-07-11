const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { createChangePlan, copyTreeOperation, removeFileOperation, managedBlockOperation } = require('./change-plan');

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
  return createChangePlan({ action: 'uninstall', warnings }, operations);
}

function planRepair(report = {}, manifest) {
  assertManifest(manifest);
  const findings = Array.isArray(report.findings) ? report.findings : [];
  const needed = new Set(findings.filter((item) => item && item.severity !== 'info').map((item) => item.path).filter(Boolean));
  const operations = [];
  for (const file of manifest.files) {
    const relevant = needed.has(file.path) || findings.some((item) => item && item.path === file.path && isRepairFinding(item));
    if (!relevant) continue;
    if (file.source) operations.push(copyTreeOperation(file.source, file.path));
    else if (file.kind === 'copy-tree' && file.sourcePath) operations.push(copyTreeOperation(file.sourcePath, file.path));
  }
  return createChangePlan({ action: 'repair', findings: findings.map((item) => item.code).filter(Boolean) }, operations);
}

function isRepairFinding(item) {
  return ['MISSING_LAUNCHER', 'MISSING_FILE', 'CORRUPT_FILE', 'VERSION_MISMATCH', 'CLIENT_NOT_CONFIGURED'].includes(item.code);
}

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

function applyLifecyclePlan(plan) {
  if (!plan || !Array.isArray(plan.operations)) throw new TypeError('invalid lifecycle plan');
  for (const operation of plan.operations) {
    if (operation.kind === 'remove-file') {
      try { fs.rmSync(operation.path, { recursive: true, force: true }); } catch (error) { throw new Error(`unable to remove ${operation.path}: ${error.message}`); }
    } else if (operation.kind === 'copy-tree') {
      fs.mkdirSync(path.dirname(operation.path), { recursive: true });
      fs.cpSync(operation.source, operation.path, { recursive: true, force: true });
    } else if (operation.kind === 'managed-block') {
      removeManagedBlock(operation.path, operation.marker);
    }
  }
  return plan.operations;
}

function removeManagedBlock(filePath, marker) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  const start = marker.includes('START') ? marker : `<!-- ${marker}_START -->`;
  const end = marker.includes('END') ? marker.replace('START', 'END') : `<!-- ${marker}_END -->`;
  const escapedStart = start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEnd = end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = text.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, 'g'), '\\n');
  if (next !== text) fs.writeFileSync(filePath, next);
}

module.exports = { planUninstall, planRepair, currentStateFromManifest, stateHash, applyLifecyclePlan };
