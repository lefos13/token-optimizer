const fs = require('fs').promises;
const path = require('path');

const LOG_DIR = '.codex-local-test-runs';
const DEFAULT_LOG_POLICY = Object.freeze({ retentionDays: 7, maxDiskMb: 500 });
const PROTECTED = new Set(['baseline.json', 'analytics.json', 'analytics-summary.json', 'registry.json']);

/* The installer exposes log lifecycle operations without importing the MCP
   server bundle. All paths are resolved beneath an absolute workspace and
   only ordinary *.log files are touched unless purge receives explicit
   metadata flags. */
function requireWorkspace(workspace) {
  if (!workspace || !path.isAbsolute(workspace)) throw new Error('logs commands require an absolute workspace path');
  return path.resolve(workspace);
}

async function ensureManagedRoot(workspace) {
  const resolvedWorkspace = requireWorkspace(workspace);
  const root = path.join(resolvedWorkspace, LOG_DIR);
  let workspaceReal;
  try { workspaceReal = await fs.realpath(resolvedWorkspace); } catch (error) { throw new Error(`workspace is not accessible: ${error.message}`); }
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('managed log directory must be a real directory');
  } catch (error) {
    if (error.code === 'ENOENT') return { workspace: workspaceReal, root };
    throw error;
  }
  const rootReal = await fs.realpath(root);
  if (!(rootReal === workspaceReal || rootReal.startsWith(`${workspaceReal}${path.sep}`))) throw new Error('managed log directory escapes workspace');
  return { workspace: workspaceReal, root: rootReal };
}

async function logEntries(workspace) {
  const { root } = await ensureManagedRoot(workspace);
  let names;
  try { names = await fs.readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const file = path.join(root, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      result.push({ path: file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch (_) { /* concurrent deletion is harmless */ }
  }
  return result.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function result(removed, bytes, policy, remainingBytes) {
  const maxBytes = (policy.maxDiskMb ?? DEFAULT_LOG_POLICY.maxDiskMb) * 1024 * 1024;
  return { removed, freedBytes: bytes, quota: { bytes: remainingBytes, maxBytes, overQuota: remainingBytes > maxBytes }, warnings: [] };
}

async function statusLogs(workspace, policy = DEFAULT_LOG_POLICY) {
  await ensureManagedRoot(workspace);
  const entries = await logEntries(workspace);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return result([], 0, policy, bytes);
}

async function pruneLogs(workspace, policy = DEFAULT_LOG_POLICY) {
  await ensureManagedRoot(workspace);
  const retentionDays = policy.retentionDays ?? DEFAULT_LOG_POLICY.retentionDays;
  const now = Date.now();
  const entries = await logEntries(workspace);
  const removed = [];
  const keep = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > retentionDays * 86400000) {
      await fs.unlink(entry.path); removed.push({ path: path.relative(workspace, entry.path), bytes: entry.bytes, reason: 'expired' });
    } else keep.push(entry);
  }
  const maxBytes = (policy.maxDiskMb ?? DEFAULT_LOG_POLICY.maxDiskMb) * 1024 * 1024;
  let total = keep.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of keep) {
    if (total <= maxBytes) break;
    await fs.unlink(entry.path); total -= entry.bytes;
    removed.push({ path: path.relative(workspace, entry.path), bytes: entry.bytes, reason: 'quota' });
  }
  return result(removed, removed.reduce((sum, item) => sum + item.bytes, 0), policy, total);
}

async function purgeLogs(workspace, options = {}) {
  const { root } = await ensureManagedRoot(workspace);
  const removed = [];
  for (const entry of await logEntries(workspace)) {
    await fs.unlink(entry.path); removed.push({ path: path.relative(workspace, entry.path), bytes: entry.bytes, reason: 'purged' });
  }
  const names = [];
  if (options.includeBaseline) names.push('baseline.json');
  if (options.includeAnalytics) names.push('analytics.json', 'analytics-summary.json');
  for (const name of names) {
    const file = path.join(root, name);
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || PROTECTED.has(name) === false) continue;
      await fs.unlink(file); removed.push({ path: path.relative(workspace, file), bytes: stat.size, reason: 'purged' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result(removed, removed.reduce((sum, item) => sum + item.bytes, 0), DEFAULT_LOG_POLICY, 0);
}

module.exports = { LOG_DIR, DEFAULT_LOG_POLICY, statusLogs, pruneLogs, purgeLogs, logEntries };
