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

async function logEntries(workspace) {
  const root = path.join(requireWorkspace(workspace), LOG_DIR);
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
  requireWorkspace(workspace);
  const entries = await logEntries(workspace);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return result([], 0, policy, bytes);
}

async function pruneLogs(workspace, policy = DEFAULT_LOG_POLICY) {
  requireWorkspace(workspace);
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
  requireWorkspace(workspace);
  const root = path.join(workspace, LOG_DIR);
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
