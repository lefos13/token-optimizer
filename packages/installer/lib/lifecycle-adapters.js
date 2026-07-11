const fs = require('fs');
const { execFileSync } = require('child_process');

/* Lifecycle adapters capture exact external state before removing installer
   registrations or services. Restores write the captured bytes and reload the
   prior LaunchAgent, making later-operation failure reversible. */
function createRegistrationAdapter() {
  return {
    capture(operation) { return (operation.paths || []).map((file) => ({ file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file) : null })); },
    apply(operation) { for (const file of operation.paths || []) removeRegistration(file, operation.client); },
    restore(_operation, state) { for (const item of state) { if (!item.exists) fs.rmSync(item.file, { force: true }); else { fs.mkdirSync(require('path').dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, item.content); } } },
  };
}

function removeRegistration(file, client) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (client === 'codex') { fs.writeFileSync(file, text.replace(/^\[mcp_servers\.(?:"?token[_-]optimizer"?)\]\s*$[\s\S]*?(?=^\[|(?![\s\S]))/gm, '').replace(/^\[mcp_servers\.token_optimizer\.env\]\s*$[\s\S]*?(?=^\[|(?![\s\S]))/gm, '')); return; }
  let data; try { data = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1').replace(/,\s*([}\]])/g, '$1')); } catch (_) { throw new Error(`cannot safely parse ${client} registration`); }
  const container = client === 'opencode' ? data.mcp : data.mcpServers;
  if (container) { delete container.token_optimizer; delete container['token-optimizer']; }
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function createServiceAdapter(options = {}) {
  const exec = options.execFileSync || execFileSync; const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return {
    capture(operation) { const file = operation.path; let loaded = false; try { exec('launchctl', ['print', `gui/${uid}/${operation.service}`], { stdio: 'ignore' }); loaded = true; } catch (_) {} return { file, loaded, content: file && fs.existsSync(file) ? fs.readFileSync(file) : null }; },
    apply(operation) { try { exec('launchctl', ['bootout', `gui/${uid}/${operation.service}`], { stdio: 'ignore' }); } catch (_) {} if (operation.path) fs.rmSync(operation.path, { force: true }); },
    restore(operation, state) { if (state.content) { fs.mkdirSync(require('path').dirname(state.file), { recursive: true }); fs.writeFileSync(state.file, state.content); } if (state.loaded && state.file) exec('launchctl', ['bootstrap', `gui/${uid}`, state.file], { stdio: 'ignore' }); },
  };
}

module.exports = { createRegistrationAdapter, createServiceAdapter, removeRegistration };
