const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createChangePlan } = require("./change-plan");
const { registerPlan, applyChangePlan } = require("./apply-plan");
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
const LEGACY_SECRET_KEYS = ["LLM_GATEWAY_TOKEN", "OPENROUTER_BYOK_KEY", "OPENROUTER_API_KEY"];

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
  const plan = createChangePlan({ action: "migration", version: require("../package.json").version, clients: state.clients, effectiveProvider: legacy.effectiveProvider, warnings: legacy.warnings }, operations);
  const runtime = { state, options, providerOptions, backup: null, credentialRuntime: null, doctor: null };
  registerPlan(plan, null, null, runtime, () => executeMigrationPlan(plan, runtime));
  return plan;
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
  const result = await applyChangePlan(plan);
  if (result.error) throw new Error(`Migration rolled back: ${result.error.message}`);
  return { status: "migrated", plan, appliedOperationIds: result.applied.map((operation) => operation.id), backup: result.backup, doctor: result.doctor };
}

/* The registered preview is the sole source of execution order. One bounded
   backup remains live until authenticated validation and cleanup both finish. */
async function executeMigrationPlan(plan, runtime) {
  const { state, options, providerOptions } = runtime;
  const applied = []; const rolledBack = []; const manualRemediation = []; const externalRollbacks = [];
  let credentialRef = providerOptions.credentialRef || null; let credentialOwned = false;
  try {
    for (const operation of plan.operations) {
      if (operation.id === "migrate:backup") runtime.backup = createBackup(state, options);
      else if (operation.kind === "credential" && operation.phase === "credentials") {
        const credential = createMigrationCredential(state, providerOptions, options, plan.effectiveProvider.mode);
        credentialRef = credential.reference; credentialOwned = credential.owned; runtime.credentialRuntime = credential;
      } else if (operation.phase === "copy") installer.copyClientAssets(operation.client, migrationInstallOptions(runtime, credentialRef));
      else if (operation.phase === "config") installer.configureMigratedClient(operation.client, migrationInstallOptions(runtime, credentialRef));
      else if (operation.phase === "service") {
        const installOptions = migrationInstallOptions(runtime, credentialRef);
        installer.applyLaunchctlValues(installer.buildProviderValues(installOptions), installOptions);
        if (!options.skipLaunchctl) externalRollbacks.push({ operation, rollback: () => installer.applyLaunchctlValues(legacyProviderValues(state.env), installOptions) });
      }
      else if (operation.phase === "command") {
        const transaction = options.clientRegistrationAdapter
          ? options.clientRegistrationAdapter(operation.client, migrationInstallOptions(runtime, credentialRef))
          : installer.registerMigratedClient(operation.client, migrationInstallOptions(runtime, credentialRef));
        if (transaction && typeof transaction.rollback === "function") externalRollbacks.push({ operation, rollback: transaction.rollback });
      }
      else if (operation.id === "migrate:doctor") runtime.doctor = await authenticatedDoctor(plan, runtime, credentialRef);
      else if (operation.id === "cleanup:legacy-provider-env") cleanupLegacy(state);
      applied.push(operation);
    }
    installer.persistInstallManifest({ ...options, ...providerOptions, credentialRef, credentialOwned }, state.clients);
    const marker = path.join(state.home, ".token-optimizer", "migration-v2.json");
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    fs.writeFileSync(marker, `${JSON.stringify({ schemaVersion: 1, migratedAt: new Date().toISOString(), clients: state.clients })}\n`, { mode: 0o600 });
    return { applied, rolledBack, manualRemediation, installedClients: [...state.clients], credentialRef, credentialOwned, backup: { directory: runtime.backup.directory, manifestPath: runtime.backup.manifestPath }, doctor: runtime.doctor };
  } catch (error) {
    for (const transaction of externalRollbacks.reverse()) {
      try { await transaction.rollback(); rolledBack.push(transaction.operation); }
      catch { manualRemediation.push(transaction.operation); }
    }
    if (runtime.backup) { try { restoreBackup(runtime.backup); rolledBack.push(...applied.slice().reverse()); } catch { manualRemediation.push(...applied.slice().reverse()); } }
    if (credentialRef) {
      try {
        if (runtime.credentialRuntime.prior) runtime.credentialRuntime.store.set(runtime.credentialRuntime.prior);
        else if (credentialOwned) runtime.credentialRuntime.store.delete(credentialRef);
      } catch { manualRemediation.push(plan.operations.find((item) => item.phase === "credentials")); }
    }
    return { applied, rolledBack, manualRemediation, error, installedClients: [...state.clients] };
  }
}

function legacyProviderValues(env) {
  const values = Object.fromEntries(installer.MANAGED_ENV_KEYS.map((key) => [key, ""]));
  for (const key of installer.MANAGED_ENV_KEYS) if (env[key]) values[key] = env[key];
  return values;
}

function migrationInstallOptions(runtime, credentialRef) {
  const values = installer.buildProviderValues({ ...runtime.options, ...runtime.providerOptions, credentialRef });
  return { ...runtime.options, ...runtime.providerOptions, clients: runtime.state.clients, home: runtime.state.home, installRoot: runtime.options.installRoot || path.join(runtime.state.home, ".token-optimizer"), assetsRoot: runtime.options.assetsRoot || path.join(__dirname, "..", "assets"), credentialRef, providerValues: values };
}

function createMigrationCredential(state, providerOptions, options, mode) {
  if (!["gateway-token", "gateway-byok", "openrouter-direct"].includes(mode)) return { reference: null, owned: false, store: null };
  const kind = options.credentialStore || "native";
  const secret = mode === "gateway-token" ? providerOptions.gatewayToken : (providerOptions.openrouterKey || providerOptions.byokKey);
  const store = createCredentialStore(kind, { home: state.home, service: "token-optimizer", account: mode, ...(options.credentialStoreOptions || {}) });
  const prior = store.get({ service: "token-optimizer", account: mode });
  const reference = store.set(secret);
  return { reference, owned: !prior, prior, store };
}

async function authenticatedDoctor(plan, runtime, credentialRef) {
  const mode = plan.effectiveProvider.mode;
  let secret = null;
  if (credentialRef && runtime.credentialRuntime?.store) secret = runtime.credentialRuntime.store.get(credentialRef);
  else if (credentialRef && typeof credentialRef === "object") {
    const kind = credentialRef.store === "config" || credentialRef.store === "protected-config" ? "config" : credentialRef.store === "env" ? "env" : "native";
    const store = createCredentialStore(kind, { home: runtime.state.home, service: credentialRef.service, account: credentialRef.account, path: credentialRef.path, envVar: credentialRef.variable, ...(runtime.options.credentialStoreOptions || {}) });
    secret = store.get(credentialRef);
  }
  if (["gateway-token", "gateway-byok", "openrouter-direct"].includes(mode) && !secret) throw new Error("post-migration doctor could not resolve credential reference");
  const headers = {};
  if (mode === "gateway-token") headers.Authorization = `Bearer ${secret}`;
  else if (mode === "gateway-byok") headers["X-OpenRouter-Key"] = secret;
  else if (mode === "openrouter-direct") headers.Authorization = `Bearer ${secret}`;
  const healthProbe = runtime.options.healthProbe
    ? ((url, timeout) => runtime.options.healthProbe(url, { timeoutMs: timeout, mode, headers, credentialRef }))
    : ((url, timeout) => authenticatedHealthProbe(url, headers, timeout));
  const report = await inspectInstallation({ home: runtime.state.home, provider: mode, credentialRef, providerUrl: plan.effectiveProvider.apiUrl, performHealthProbe: true, healthProbe });
  if (report.findings.some((item) => item.code === "PROVIDER_UNREACHABLE" || item.code === "CREDENTIAL_MISSING")) throw new Error("post-migration doctor failed");
  return report;
}

async function authenticatedHealthProbe(url, headers, timeoutMs = 2500) {
  const target = `${String(url).replace(/\/+$/, "").replace(/\/v1$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetch(target, { headers, signal: controller.signal }); return { ok: response.ok }; }
  finally { clearTimeout(timer); }
}

function providerOptionsFromState(state, choices, mode) {
  const env = state.env;
  const credentialRef = choices.credentialRef || env.TOKEN_OPTIMIZER_CREDENTIAL_REF;
  if (mode === "gateway-token") return { provider: mode, credentialRef, gatewayUrl: choices.gatewayUrl || env.LLM_GATEWAY_URL, gatewayToken: choices.gatewayToken || env.LLM_GATEWAY_TOKEN };
  if (mode === "gateway-byok") return { provider: mode, credentialRef, gatewayUrl: choices.gatewayUrl || env.LLM_GATEWAY_URL, byokKey: choices.byokKey || env.OPENROUTER_BYOK_KEY || env.OPENROUTER_API_KEY, byokModel: choices.byokModel || env.OPENROUTER_BYOK_MODEL };
  if (mode === "openrouter-direct") return { provider: mode, credentialRef, openrouterUrl: choices.openrouterUrl, openrouterKey: choices.openrouterKey || choices.byokKey || env.OPENROUTER_API_KEY || env.OPENROUTER_BYOK_KEY, byokModel: choices.byokModel || env.OPENROUTER_BYOK_MODEL };
  if (mode === "local") return { provider: mode, localApiUrl: choices.localApiUrl || env.LOCAL_LLM_API_URL, localModel: choices.localModel || env.LOCAL_LLM_MODEL };
  return { provider: "skip" };
}

function createBackup(state, options = {}) {
  const directory = path.join(state.home, ".token-optimizer-mcp", "backups", `migration-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entries = [];
  const clientRoots = state.clients.flatMap((client) => CLIENT_ROOTS[client] || []).map((root) => path.join(state.home, root));
  const cursorRoots = (options.cursorProjects || []).map((root) => path.join(path.resolve(root), ".cursor"));
  const targets = [...new Set([...clientRoots, ...cursorRoots, ...state.files, options.installRoot || path.join(state.home, ".token-optimizer"), path.join(state.home, ".token-optimizer-mcp", "manifest.json"), path.join(state.home, "Library", "LaunchAgents", "com.softawarest.token-optimizer.env.plist"), ...(options.launchctlStatePath ? [path.resolve(options.launchctlStatePath)] : [])])];
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

function cleanupLegacy(state) {
  for (const file of state.files) {
    const text = fs.readFileSync(file, "utf8");
    if (/\.toml$/i.test(file)) {
      fs.writeFileSync(file, text.split(/\r?\n/).filter((line) => !LEGACY_SECRET_KEYS.some((key) => new RegExp(`^\\s*${key}\\s*=`).test(line))).join("\n"));
      continue;
    }
    const parsed = JSON.parse(installer.stripJsonCommentsAndTrailingCommas(text));
    removeLegacyKeys(parsed);
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

function removeLegacyKeys(value) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (LEGACY_SECRET_KEYS.includes(key)) delete value[key];
    else removeLegacyKeys(value[key]);
  }
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
