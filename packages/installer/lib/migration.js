const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChangePlan } = require("./change-plan");
const { createCredentialStore } = require("./credential-store");
const { inspectInstallation } = require("./doctor");
const installer = require("./install-core");

const CLIENT_ROOTS = {
  claude: [".claude"],
  codex: [".codex"],
  antigravity: [path.join(".gemini", "config")],
  opencode: [path.join(".config", "opencode")],
  cursor: [".cursor"],
};
const LEGACY_KEYS = ["LLM_GATEWAY_URL", "LLM_GATEWAY_TOKEN", "OPENROUTER_BYOK_KEY", "OPENROUTER_BYOK_MODEL", "OPENROUTER_API_KEY", "LOCAL_LLM_API_URL", "LOCAL_LLM_MODEL"];

/* Legacy inspection is intentionally bounded to the five supported client
   roots. Values stay in process memory and only redacted provider metadata is
   admitted to the public migration plan. */
function detectV1State(options = {}) {
  const home = path.resolve(options.home || process.env.HOME || os.homedir());
  const clients = normalizeClients(options.clients, home);
  const env = { ...(options.env || {}) };
  const files = [];
  for (const client of clients) {
    for (const relative of CLIENT_ROOTS[client] || []) walk(path.join(home, relative), (file) => {
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch { return; }
      let matched = false;
      for (const key of LEGACY_KEYS) {
        const expression = new RegExp(`${key}[\\"']?\\s*[=:]\\s*[\\"']?([^\\"'\\n,}]+)`, "i");
        const match = text.match(expression);
        if (match && String(match[1]).trim()) { env[key] ||= String(match[1]).trim(); matched = true; }
      }
      if (matched) files.push(file);
    });
  }
  return { home, clients, env, files: [...new Set(files)].sort() };
}

function planMigrationFromHome(options = {}) {
  const state = detectV1State(options);
  const legacy = installer.planMigration(state, options);
  const providerOptions = providerOptionsFromState(state, options, legacy.effectiveProvider.mode);
  const install = installer.planInstallation({ ...options, ...providerOptions, clients: state.clients });
  const operations = [
    { id: "migrate:backup", kind: "copy-tree", phase: "backup", path: path.join(state.home, ".token-optimizer-mcp", "backups") },
    ...install.operations,
    { id: "migrate:doctor", kind: "client-command", phase: "validation", client: "all", command: "authenticated-doctor" },
    ...(legacy.operations.some((item) => item.id === "cleanup:legacy-provider-env") ? [{ id: "cleanup:legacy-provider-env", kind: "managed-block", phase: "cleanup", path: "supported-client-configs", marker: "legacy-provider-env" }] : []),
  ];
  return createChangePlan({ action: "migration", version: require("../package.json").version, clients: state.clients, effectiveProvider: legacy.effectiveProvider, warnings: legacy.warnings }, operations);
}

/* The outer backup transaction extends the install transaction through the
   authenticated doctor gate, allowing every client file, credential and
   ownership manifest to be restored if validation or cleanup fails. */
async function migrateInstallation(options = {}) {
  const state = detectV1State(options);
  const completionMarker = path.join(state.home, ".token-optimizer", "migration-v2.json");
  if (fs.existsSync(completionMarker)) {
    return { status: "already-migrated", plan: planMigrationFromHome(options) };
  }
  const plan = planMigrationFromHome(options);
  const mode = plan.effectiveProvider.mode;
  if (!installer.normalizeProviderChoice(mode)) throw new Error(`Unsupported provider mode: ${mode}`);
  const providerOptions = providerOptionsFromState(state, options, mode);
  const backup = createBackup(state);
  let applyResult;
  try {
    const installPlan = installer.planInstallation({ ...options, ...providerOptions, clients: state.clients });
    applyResult = installer.applyChangePlan(installPlan);
    if (applyResult.error) throw applyResult.error;
    installer.persistInstallManifest({ ...options, ...providerOptions, credentialRef: applyResult.credentialRef, credentialOwned: applyResult.credentialOwned }, applyResult.installedClients);
    const report = await inspectInstallation({ home: state.home, provider: mode, credentialRef: applyResult.credentialRef, providerUrl: plan.effectiveProvider.apiUrl, performHealthProbe: true, healthProbe: options.healthProbe });
    if (report.findings.some((item) => item.code === "PROVIDER_UNREACHABLE" || item.code === "CREDENTIAL_MISSING")) throw new Error("post-migration doctor failed");
    cleanupLegacy(state, providerOptions);
    fs.mkdirSync(path.dirname(completionMarker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(completionMarker, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), clients: state.clients })}\n`, { mode: 0o600 });
    return { status: "migrated", plan, appliedOperationIds: plan.operations.map((operation) => operation.id), backup: { directory: backup.directory, manifestPath: backup.manifestPath }, doctor: report };
  } catch (error) {
    restoreBackup(backup, state.home);
    if (applyResult?.credentialOwned && applyResult.credentialRef) {
      const ref = applyResult.credentialRef;
      const kind = ref.store === "config" || ref.store === "protected-config" ? "config" : "native";
      try { createCredentialStore(kind, { home: state.home, service: ref.service, account: ref.account, path: ref.path, ...(options.credentialStoreOptions || {}) }).delete(ref); } catch { /* backup restoration remains authoritative */ }
    }
    throw new Error(`Migration rolled back: ${error.message}`);
  }
}

function providerOptionsFromState(state, choices, mode) {
  const env = state.env;
  if (mode === "gateway-token") return { provider: mode, gatewayUrl: choices.gatewayUrl || env.LLM_GATEWAY_URL, gatewayToken: choices.gatewayToken || env.LLM_GATEWAY_TOKEN };
  if (mode === "gateway-byok") return { provider: mode, gatewayUrl: choices.gatewayUrl || env.LLM_GATEWAY_URL, byokKey: choices.byokKey || env.OPENROUTER_BYOK_KEY || env.OPENROUTER_API_KEY, byokModel: choices.byokModel || env.OPENROUTER_BYOK_MODEL };
  if (mode === "openrouter-direct") return { provider: mode, openrouterUrl: choices.openrouterUrl, openrouterKey: choices.openrouterKey || choices.byokKey || env.OPENROUTER_API_KEY || env.OPENROUTER_BYOK_KEY, byokModel: choices.byokModel || env.OPENROUTER_BYOK_MODEL };
  if (mode === "local") return { provider: mode, localApiUrl: choices.localApiUrl || env.LOCAL_LLM_API_URL, localModel: choices.localModel || env.LOCAL_LLM_MODEL };
  return { provider: "skip" };
}

function createBackup(state) {
  const directory = path.join(state.home, ".token-optimizer-mcp", "backups", `migration-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entries = [];
  const targets = [...new Set([...state.files, path.join(state.home, ".token-optimizer"), path.join(state.home, "Library", "LaunchAgents", "com.softawarest.token-optimizer.env.plist")])];
  targets.forEach((target, index) => {
    const existed = fs.existsSync(target); const stored = path.join(directory, "contents", String(index));
    if (existed) fs.cpSync(target, stored, { recursive: true });
    entries.push({ target, stored: path.relative(directory, stored), existed });
  });
  const manifestPath = path.join(directory, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") { fs.chmodSync(directory, 0o700); fs.chmodSync(manifestPath, 0o600); }
  return { directory, manifestPath, entries };
}

function restoreBackup(backup) {
  for (const entry of backup.entries) {
    fs.rmSync(entry.target, { recursive: true, force: true });
    if (entry.existed) { fs.mkdirSync(path.dirname(entry.target), { recursive: true }); fs.cpSync(path.join(backup.directory, entry.stored), entry.target, { recursive: true }); }
  }
}

function cleanupLegacy(state, providerOptions) {
  const secrets = [state.env.LLM_GATEWAY_TOKEN, state.env.OPENROUTER_BYOK_KEY, state.env.OPENROUTER_API_KEY].filter(Boolean);
  for (const file of state.files) {
    let text = fs.readFileSync(file, "utf8");
    for (const secret of secrets) text = text.split(secret).join("");
    fs.writeFileSync(file, text);
  }
  for (const key of ["LLM_GATEWAY_TOKEN", "OPENROUTER_BYOK_KEY", "OPENROUTER_API_KEY"]) if (providerOptions[key]) delete providerOptions[key];
}

function normalizeClients(clients, home) {
  if (!clients || clients.includes("detected")) return Object.keys(CLIENT_ROOTS).filter((client) => (CLIENT_ROOTS[client] || []).some((root) => fs.existsSync(path.join(home, root))));
  if (clients.includes("all")) return Object.keys(CLIENT_ROOTS);
  return [...new Set(clients)];
}

function walk(root, visit) {
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) { const item = path.join(root, entry.name); if (entry.isDirectory() && !entry.isSymbolicLink()) walk(item, visit); else if (entry.isFile() && fs.statSync(item).size < 1024 * 1024) visit(item); }
}

module.exports = { detectV1State, planMigrationFromHome, migrateInstallation };
