const path = require('path');
const fs = require('fs');

/* Doctor and lifecycle mutation must agree on every marketplace-owned layout;
   otherwise a reported duplicate cannot be safely normalized or rolled back. */
function marketplaceLocations(home) {
  return [
    { client: 'claude', root: path.join(home, '.claude', 'plugins', 'cache', 'token-optimizer-marketplace', 'token-optimizer'), layout: 'versioned' },
    { client: 'claude', root: path.join(home, '.claude', 'skills', 'token-optimizer'), layout: 'single' },
    { client: 'codex', root: path.join(home, '.codex', 'plugins', 'cache', 'Softaware-marketplace', 'token-optimizer'), layout: 'versioned' },
    { client: 'codex', root: path.join(home, '.codex', 'plugins', 'token-optimizer'), layout: 'versioned' },
  ].map((item) => ({ ...item, root: path.resolve(item.root) }));
}

function marketplaceManifest(location, installedPath) {
  const target = path.resolve(installedPath);
  if (location.layout === 'single' ? target !== location.root : path.dirname(target) !== location.root) return null;
  for (const candidate of [path.join(target, '.claude-plugin', 'plugin.json'), path.join(target, '.codex-plugin', 'plugin.json')]) {
    try { const data = JSON.parse(fs.readFileSync(candidate, 'utf8')); const identity = data.name ?? data.id; if (typeof identity === 'string' && /^token[_-]optimizer$/.test(identity)) return { path: candidate, data }; } catch (_) {}
  }
  return null;
}

function ownsMarketplacePath(location, installedPath) { return Boolean(marketplaceManifest(location, installedPath)); }

module.exports = { marketplaceLocations, marketplaceManifest, ownsMarketplacePath };
