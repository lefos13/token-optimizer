const path = require('path');

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

module.exports = { marketplaceLocations };
