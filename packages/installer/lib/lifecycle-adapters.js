const fs = require('fs');
const { execFileSync } = require('child_process');

/* Lifecycle adapters capture exact external state before removing installer
   registrations or services. Restores write the captured bytes and reload the
   prior LaunchAgent, making later-operation failure reversible. */
function createRegistrationAdapter(options = {}) {
  const exec = options.execFileSync || execFileSync;
  return {
    capture(operation) { return { files: (operation.paths || []).map((file) => ({ file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file) : null })), marketplace: Boolean(operation.recipe) }; },
    apply(operation) { for (const file of operation.paths || []) removeRegistration(file, operation.client); if (operation.recipe) exec(operation.client, operation.recipe.remove, { stdio: 'ignore' }); },
    restore(operation, state) { for (const item of state.files) { if (!item.exists) fs.rmSync(item.file, { force: true }); else { fs.mkdirSync(require('path').dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, item.content); } } if (state.marketplace) exec(operation.client, operation.recipe.restore, { stdio: 'ignore' }); },
  };
}

function removeRegistration(file, client) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  if (client === 'codex') { fs.writeFileSync(file, text.replace(/^\[mcp_servers\.(?:"?token[_-]optimizer"?)\]\s*$[\s\S]*?(?=^\[|(?![\s\S]))/gm, '').replace(/^\[mcp_servers\.token_optimizer\.env\]\s*$[\s\S]*?(?=^\[|(?![\s\S]))/gm, '')); return; }
  const next = removeJsonProperty(text, ['token_optimizer', 'token-optimizer']);
  if (next === null) throw new Error(`cannot safely patch ${client} registration`);
  fs.writeFileSync(file, next);
}

function removeJsonProperty(text, keys) { for (const key of keys) { const match = new RegExp(`(["']${key.replace('-', '\\-')}["']\\s*:)`, 'g').exec(text); if (!match) continue; let start = match.index; let value = match.index + match[0].length; while (/\s/.test(text[value])) value++; let end = scanValue(text, value); if (end < 0) return null; while (/\s/.test(text[end])) end++; if (text[end] === ',') end++; else { let before = start - 1; while (/\s/.test(text[before])) before--; if (text[before] === ',') start = before; } return text.slice(0, start) + text.slice(end); } return text; }
function scanValue(text, start) { const opener = text[start]; if (!'{['.includes(opener)) { let quote = null; for (let i = start; i < text.length; i++) { const char = text[i]; if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; } else if (char === '"' || char === "'") quote = char; else if (char === ',' || char === '}') return i; } return -1; } const closer = opener === '{' ? '}' : ']'; let depth = 0; let quote = null; for (let i = start; i < text.length; i++) { const char = text[i]; if (quote) { if (char === '\\') i++; else if (char === quote) quote = null; continue; } if (char === '"' || char === "'") quote = char; else if (char === opener) depth++; else if (char === closer && --depth === 0) return i + 1; } return -1; }

function createServiceAdapter(options = {}) {
  const exec = options.execFileSync || execFileSync; const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return {
    capture(operation) { const file = operation.path; let loaded = false; try { exec('launchctl', ['print', `gui/${uid}/${operation.service}`], { stdio: 'ignore' }); loaded = true; } catch (_) {} return { file, loaded, content: file && fs.existsSync(file) ? fs.readFileSync(file) : null }; },
    apply(operation) { if (operation.action === 'reload-launch-agent' || operation.action === 'rewrite-launch-agent') { const definition = (options.services || []).find((item) => item.service === operation.service); if (operation.action === 'rewrite-launch-agent') { if (!definition?.content) throw new Error('managed LaunchAgent source unavailable'); fs.mkdirSync(require('path').dirname(operation.path), { recursive: true }); fs.writeFileSync(operation.path, definition.content); } exec('launchctl', ['bootstrap', `gui/${uid}`, operation.path], { stdio: 'ignore' }); return; } try { exec('launchctl', ['bootout', `gui/${uid}/${operation.service}`], { stdio: 'pipe' }); } catch (error) { const message = `${error.stderr || ''} ${error.message || ''}`; if (!/not loaded|not found|could not find|no such process/i.test(message)) throw error; } if (operation.path) fs.rmSync(operation.path, { force: true }); },
    restore(operation, state) { if (state.content) { fs.mkdirSync(require('path').dirname(state.file), { recursive: true }); fs.writeFileSync(state.file, state.content); } if (state.loaded && state.file) exec('launchctl', ['bootstrap', `gui/${uid}`, state.file], { stdio: 'ignore' }); },
  };
}

module.exports = { createRegistrationAdapter, createServiceAdapter, removeRegistration, removeJsonProperty };
