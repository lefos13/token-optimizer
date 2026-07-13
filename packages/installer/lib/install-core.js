const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createChangePlan, formatChangePlan } = require("./change-plan");
const { registerPlan, applyChangePlan, defaultAdapters } = require("./apply-plan");
const { writeManifest, readManifest } = require("./manifest");
const crypto = require("crypto");
const { createCredentialStore } = require("./credential-store");

const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";
const DEFAULT_LOCAL_LLM_URL = "http://localhost:8080/v1";
const DEFAULT_LOCAL_LLM_MODEL = "local-model";
/* Every env key installers may write into a client's MCP config. A provider
   mode (gateway / byok / local / skip) always yields a full values object
   across all of these keys so registering the MCP server never requires
   picking a provider, and switching providers later cleanly clears whatever
   the previous choice left behind. */
const MANAGED_ENV_KEYS = [
  "TOKEN_OPTIMIZER_PROVIDER_MODE",
  "TOKEN_OPTIMIZER_CREDENTIAL_REF",
  "LLM_GATEWAY_URL",
  "LLM_GATEWAY_TOKEN",
  "OPENROUTER_BYOK_KEY",
  "OPENROUTER_BYOK_MODEL",
  "LOCAL_LLM_API_URL",
  "LOCAL_LLM_MODEL",
  "OPENROUTER_API_KEY",
];

function emptyManagedValues() {
  return Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, ""]));
}

/* Resolves an install/config options object into the full managed values to
   write.
   - "gateway": shared infrastructure; requires gatewayToken.
   - "byok": your own OpenRouter key via the gateway. Requires byokKey only —
     NO gatewayToken is written or needed, because a BYOK caller isn't using
     the operator's OpenRouter setup and the gateway does not authenticate a
     BYOK-only request at all.
   - "local": your own OpenAI-compatible endpoint; needs nothing.
   - "skip"/unset provider: writes nothing but still returns the empty object
     shape, so callers can still register the MCP server entry itself without
     ever requiring a token. */
function buildProviderValues(options) {
  const requested = options.provider;
  if (requested !== undefined && !normalizeProviderChoice(requested)) {
    throw new Error(`Unsupported provider mode: ${requested}`);
  }
  const provider = normalizeProviderChoice(requested) || inferProvider(options);
  const values = emptyManagedValues();
  values.TOKEN_OPTIMIZER_PROVIDER_MODE = provider === "skip" ? "" : provider;
  values.TOKEN_OPTIMIZER_CREDENTIAL_REF = options.credentialRef
    ? (typeof options.credentialRef === "string" ? options.credentialRef : JSON.stringify(options.credentialRef))
    : "";
  if (provider === "gateway-token") {
    if (!options.gatewayToken && !options.credentialRef) {
      throw new Error("gatewayToken is required for provider 'gateway'");
    }
    values.LLM_GATEWAY_URL = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    if (!options.credentialRef) values.LLM_GATEWAY_TOKEN = options.gatewayToken;
  } else if (provider === "gateway-byok") {
    if (!options.byokKey && !options.credentialRef) {
      throw new Error("byokKey is required for provider 'byok'");
    }
    values.LLM_GATEWAY_URL = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    if (!options.credentialRef) values.OPENROUTER_BYOK_KEY = options.byokKey;
    values.OPENROUTER_BYOK_MODEL = String(options.byokModel || "").trim();
  } else if (provider === "openrouter-direct") {
    if (!options.byokKey && !options.openrouterKey && !options.credentialRef) {
      throw new Error("byokKey is required for provider 'openrouter-direct'");
    }
    if (!options.credentialRef) values.OPENROUTER_API_KEY = options.openrouterKey || options.byokKey;
    values.LLM_GATEWAY_URL = options.openrouterUrl || "https://openrouter.ai/api/v1";
  } else if (provider === "local") {
    values.LOCAL_LLM_API_URL = options.localApiUrl || "";
    values.LOCAL_LLM_MODEL = options.localModel || "";
  }
  return values;
}

function normalizeProviderChoice(provider) {
  if (!provider) {
    return null;
  }
  const normalized = String(provider).trim().toLowerCase();
  const aliases = { gateway: "gateway-token", byok: "gateway-byok", direct: "openrouter-direct" };
  const canonical = aliases[normalized] || normalized;
  return ["gateway-token", "gateway-byok", "openrouter-direct", "local", "skip"].includes(canonical) ? canonical : null;
}

/* Callers that don't pass an explicit provider get one inferred from which
   values they supplied, so existing gatewayToken-only call sites keep working. */
function inferProvider(options) {
  if (options.byokKey) return "gateway-byok";
  if (options.gatewayToken) return "gateway-token";
  if (options.localApiUrl || options.localModel) return "local";
  return "skip";
}

/* Converts provider plaintext into a durable credential reference before any
   client config is written. Native storage is fail-closed; env and config are
   available only when the caller explicitly selects those plaintext stores. */
function prepareCredentialOptions(options = {}) {
  const provider = normalizeProviderChoice(options.provider) || inferProvider(options);
  if (!["gateway-token", "gateway-byok", "openrouter-direct"].includes(provider) || options.credentialRef) return { ...options };
  const kind = options.credentialStore || "native";
  if (!["native", "env", "config"].includes(kind)) throw new Error(`Unsupported credential store: ${kind}. Choose native, env, or config.`);
  if (kind !== "env") return { ...options, provider, credentialStore: kind };
  const variable = provider === "gateway-token" ? "LLM_GATEWAY_TOKEN" : provider === "openrouter-direct" ? "OPENROUTER_API_KEY" : "OPENROUTER_BYOK_KEY";
  const store = createCredentialStore(kind, { home: options.home, service: "token-optimizer", account: provider, envVar: variable, ...(options.credentialStoreOptions || {}) });
  const credentialRef = store.set();
  const prepared = { ...options, provider, credentialStore: kind, credentialRef };
  delete prepared.gatewayToken;
  delete prepared.byokKey;
  delete prepared.openrouterKey;
  delete prepared.credentialStoreOptions;
  return prepared;
}

/* Translate legacy v1 environment state into an explicit provider without
   changing its inference destination. Secrets remain represented by a
   credential reference in the returned plan. */
function planMigration(v1State = {}, choices = {}) {
  const env = v1State.env || v1State.environment || v1State;
  const selected = normalizeProviderChoice(choices.provider);
  const gatewayUrl = env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const hasByok = Boolean(env.OPENROUTER_BYOK_KEY || env.OPENROUTER_API_KEY || choices.byokKey);
  const inferred = selected || (env.LOCAL_LLM_API_URL ? "local" : env.LLM_GATEWAY_TOKEN ? "gateway-token" : hasByok ? "gateway-byok" : "skip");
  const mode = inferred;
  const effectiveProvider = { mode, apiUrl: mode === "openrouter-direct" ? (choices.openrouterUrl || "https://openrouter.ai/api/v1") : mode === "local" ? (env.LOCAL_LLM_API_URL || DEFAULT_LOCAL_LLM_URL) : gatewayUrl };
  if (env.OPENROUTER_BYOK_MODEL || choices.byokModel) effectiveProvider.model = env.OPENROUTER_BYOK_MODEL || choices.byokModel;
  if (env.TOKEN_OPTIMIZER_CREDENTIAL_REF || choices.credentialRef) effectiveProvider.credentialRef = env.TOKEN_OPTIMIZER_CREDENTIAL_REF || choices.credentialRef;
  const warnings = [];
  if (!selected && hasByok && env.LLM_GATEWAY_URL) warnings.push("Legacy BYOK credentials remain routed through the gateway; key is stored as a gateway credential reference.");
  if (env.LLM_GATEWAY_TOKEN && !selected) warnings.push("Legacy gateway token migrated to gateway-token; review credential storage before cleanup.");
  const operations = [{ id: "migrate:provider", kind: "credential", phase: "credentials", provider: mode, reference: effectiveProvider.credentialRef || "provider-env" }];
  if (env.LLM_GATEWAY_TOKEN || env.OPENROUTER_BYOK_KEY || env.OPENROUTER_API_KEY) {
    operations.push({ id: "cleanup:legacy-provider-env", kind: "managed-block", phase: "cleanup", path: "provider-env", marker: "TOKEN_OPTIMIZER_PROVIDER_MODE" });
  }
  return createChangePlan({ action: "migration", effectiveProvider, warnings }, operations);
}
const CLAUDE_MARKETPLACE_NAME = "token-optimizer-marketplace";
const CODEX_MARKETPLACE_NAME = "Softaware-marketplace";
/* macOS GUI-session env is delivered two ways: an immediate `launchctl setenv`
   for the current login, plus a RunAtLoad LaunchAgent that re-applies the same
   values at every future login — `launchctl setenv` alone does NOT survive a
   reboot or logout, which would silently strip credentials from GUI-launched
   clients. */
const LAUNCH_AGENT_LABEL = "com.softawarest.token-optimizer.env";
const DIRECTIVE_MARKER_START = "<!-- TOKEN_OPTIMIZER_START -->";
const DIRECTIVE_MARKER_END = "<!-- TOKEN_OPTIMIZER_END -->";
const DIRECTIVE_BLOCK = `${DIRECTIVE_MARKER_START}
## Token Optimizer (default-on)

Always use the \`token_optimizer\` MCP tools by default:

- \`scout_codebase\` before broad exploration of an unfamiliar area.
- \`run_test_verdict\` before claiming a change works.
- \`run_failure_triage\` on test/build/lint failures instead of reading raw logs.
- \`run_regression_check\` before merging.
- \`run_changed_files_review\` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
${DIRECTIVE_MARKER_END}
`;

function installerPaths(options = {}) {
  const home = path.resolve(options.home || process.env.HOME || os.homedir());
  const installRoot = path.resolve(options.installRoot || path.join(home, ".token-optimizer"));
  const assetsRoot = path.resolve(options.assetsRoot || path.join(__dirname, "..", "assets"));
  return {
    home,
    installRoot,
    assetsRoot,
    backupRoot: path.join(home, ".token-optimizer-mcp", "backups"),
  };
}

/* Installation and provider-only configuration share one credential state
   machine so replacement, superseded cleanup, and rollback cannot diverge. */
function createCredentialTransaction(options, paths) {
  const provider = normalizeProviderChoice(options.provider) || inferProvider(options);
  const runtime = { options: prepareCredentialOptions(options), credentialRef: options.credentialRef, credentialOwned: false };
  const priorOwned = (readManifest(paths.home)?.credentials || []).find((item) => item.ownership === "installer")?.reference;
  const priorStoreKind = priorOwned && (priorOwned.store === "config" || priorOwned.store === "protected-config" ? "config" : "native");
  const requestedStoreKind = options.credentialStore || "native";
  runtime.superseded = priorOwned && (priorOwned.account !== provider || priorStoreKind !== requestedStoreKind) ? priorOwned : null;
  runtime.provider = provider;
  runtime.needsCredential = ["gateway-token", "gateway-byok", "openrouter-direct"].includes(provider) && !options.credentialRef;
  runtime.optionsSource = options;
  runtime.paths = paths;
  return runtime;
}

function executeCredentialOperation(runtime, operation) {
  if (operation.phase === "cleanup") {
    runtime.supersededStore.delete(runtime.superseded);
    runtime.credentialOwnershipCleared = !runtime.credentialRef;
    return;
  }
  if (runtime.options.credentialRef) return;
  const source = runtime.optionsSource;
  const secret = runtime.provider === "gateway-token" ? source.gatewayToken : (source.openrouterKey || source.byokKey);
  runtime.credentialRef = runtime.store.set(secret);
  runtime.credentialOwned = !runtime.priorCredential;
  runtime.options = { ...runtime.options, credentialRef: runtime.credentialRef };
  delete runtime.options.gatewayToken; delete runtime.options.byokKey; delete runtime.options.openrouterKey;
}

function prepareCredentialOperation(runtime, operation) {
  const options = runtime.optionsSource;
  if (operation.phase === "cleanup") {
    const ref = runtime.superseded;
    const kind = ref.store === "config" || ref.store === "protected-config" ? "config" : "native";
    runtime.supersededStore = createCredentialStore(kind, { home: runtime.paths.home, service: ref.service, account: ref.account, path: ref.path, ...(options.credentialStoreOptions || {}) });
    runtime.supersededSecret = runtime.supersededStore.get(ref);
    return { inverse: () => { if (runtime.supersededSecret) runtime.supersededStore.set(runtime.supersededSecret); } };
  }
  const kind = options.credentialStore || "native";
  const variable = runtime.provider === "gateway-token" ? "LLM_GATEWAY_TOKEN" : runtime.provider === "openrouter-direct" ? "OPENROUTER_API_KEY" : "OPENROUTER_BYOK_KEY";
  runtime.store = createCredentialStore(kind, { home: runtime.paths.home, service: "token-optimizer", account: runtime.provider, envVar: variable, ...(options.credentialStoreOptions || {}) });
  runtime.priorCredential = runtime.store.get({ service: "token-optimizer", account: runtime.provider });
  return { inverse: () => runtime.priorCredential ? runtime.store.set(runtime.priorCredential) : runtime.store.delete({ service: "token-optimizer", account: runtime.provider }) };
}

function planInstallation(options = {}) {
  options.lifecycleRegistrations ||= [];
  const paths = installerPaths(options);
  const clients = normalizeClients(options.clients, paths.home);
  const runtime = createCredentialTransaction(options, paths);
  const operations = [
    ...(runtime.needsCredential ? [{ id: "install:provider:credential", kind: "credential", phase: "credentials", provider: runtime.provider, reference: `${options.credentialStore || "native"}:${runtime.provider}` }] : []),
    ...clients.flatMap((client) => [
    { id: `install:${client}:copy`, kind: "copy-tree", phase: "copy", client, path: paths.home, targets: clientTargets(client, paths, options) },
    { id: `install:${client}:config`, kind: "managed-block", phase: "config", client, path: paths.home },
    { id: `install:${client}:service`, kind: "platform-service", phase: "service", client, platform: process.platform },
    { id: `install:${client}:command`, kind: "client-command", phase: "command", client, command: "register" },
  ]),
    ...(runtime.superseded ? [{ id: "install:provider:cleanup", kind: "credential", phase: "cleanup", provider: runtime.provider, reference: runtime.superseded }] : []),
  ];
  const plan = createChangePlan({ action: "install", version: options.version || require("../package.json").version, clients }, operations);
  registerPlan(plan, (operation) => {
    if (operation.kind === "credential") {
      return executeCredentialOperation(runtime, operation);
    }
    if (operation.phase !== "copy") return;
    const installOptions = { ...runtime.options, ...paths };
    if (operation.client === "opencode") installOpenCode(installOptions);
    else if (operation.client === "cursor") installCursor(installOptions);
    else if (operation.client === "antigravity") installAntigravity(installOptions);
    else if (operation.client === "claude") installClaude(installOptions);
    else if (operation.client === "codex") installCodex(installOptions);
    else throw new Error(`Unsupported client: ${operation.client}`);
  }, (operation) => {
    if (operation.kind === "credential") {
      return prepareCredentialOperation(runtime, operation);
    }
    const boundaries = [paths.home, ...(options.cursorProjects || []).map((project) => path.resolve(project))];
    const before = snapshotTargets(operation.targets || [], boundaries);
    return { inverse: () => restoreTargets(before), commit: () => discardSnapshot(before) };
  }, runtime);
  return plan;
}

function installSelectedClients(options) {
  const result = applyChangePlan(planInstallation(options), defaultAdapters());
  if (result.error) throw result.error;
  persistInstallManifest({ ...options, credentialRef: result.credentialRef, credentialOwned: result.credentialOwned, credentialOwnershipCleared: result.credentialOwnershipCleared }, result.installedClients);
  return result.installedClients;
}

/* Provider-only reconfiguration uses the same credential-first transaction as
   installation. Config snapshots and the prior credential are both restored
   if any client write fails after credential mutation. */
function planProviderConfiguration(options = {}) {
  const paths = installerPaths(options);
  /* Unlike planInstallation, this never resolved the "detected"/empty-list placeholder into real
     client names -- every target's matchesClient(options.clients) call compared real names like
     "claude" against the literal string "detected" and always returned false, so `config` (used
     to add a provider after `install --provider skip`, or to switch providers later) silently
     wrote to zero clients while still reporting success. Also fixes the identical bug in this
     function's own rollback-snapshot filter three lines below, which used the same raw list. */
  options.clients = normalizeClients(options.clients, paths.home);
  const runtime = createCredentialTransaction(options, paths);
  const operations = createChangePlan({ action: "config" }, [
    ...(runtime.needsCredential ? [{ id: "config:provider:credential", kind: "credential", phase: "credentials", provider: runtime.provider, reference: `${options.credentialStore || "native"}:${runtime.provider}` }] : []),
    { id: "config:clients", kind: "managed-block", phase: "config", path: paths.home },
    ...(runtime.superseded ? [{ id: "config:provider:cleanup", kind: "credential", phase: "cleanup", provider: runtime.provider, reference: runtime.superseded }] : []),
  ]);
  registerPlan(operations, (operation) => {
    if (operation.kind === "credential") {
      executeCredentialOperation(runtime, operation);
    } else applyGatewayConfig(runtime.options);
  }, (operation) => {
    if (operation.kind === "credential") {
      return prepareCredentialOperation(runtime, operation);
    }
    const targets = getGatewayTargets(paths.home).filter((target) => target.matches(options.clients)).map((target) => target.filePath);
    targets.push(path.join(paths.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`));
    const before = snapshotTargets(targets, [paths.home]);
    return { inverse: () => restoreTargets(before), commit: () => discardSnapshot(before) };
  }, runtime);
  return operations;
}

function applyProviderConfiguration(options = {}) {
  const result = applyChangePlan(planProviderConfiguration(options));
  if (result.error) throw result.error;
  return result;
}

function persistProviderCredentialOwnership(options = {}, result = {}) {
  const paths = installerPaths(options);
  const existing = readManifest(paths.home);
  if (result.credentialOwnershipCleared) {
    if (existing) writeManifest(paths.home, { ...existing, credentials: [] });
    return;
  }
  if (!result.credentialRef || !result.credentialOwned || result.credentialRef.store === "env") return;
  writeManifest(paths.home, existing
    ? { ...existing, credentials: [{ reference: result.credentialRef, ownership: "installer" }] }
    : { schemaVersion: 2, roots: [paths.installRoot], assetRoots: [], managedBlocks: [], credentials: [{ reference: result.credentialRef, ownership: "installer" }], files: [] });
}

/* Capture only installer-owned plugin trees after a successful install. The
   manifest is the durable hand-off used by repair and uninstall; config files
   remain outside these trees so user-authored settings are never deleted. */
function persistInstallManifest(options = {}, clients = []) {
  const paths = installerPaths(options);
  const mappings = clients.flatMap((client) => ({
    opencode: [[path.join(paths.home, ".config", "opencode", "token-optimizer-server"), path.join(paths.assetsRoot, "plugin", "opencode", "server")], [path.join(paths.home, ".config", "opencode", "skills", "token-optimizer"), path.join(paths.assetsRoot, "plugin", "opencode", "skills", "token-optimizer")]],
    cursor: [[path.join(paths.home, ".cursor", "token-optimizer-server"), path.join(paths.assetsRoot, "plugin", "cursor", "server")]],
    antigravity: [[path.join(paths.home, ".gemini", "config", "plugins", "token-optimizer"), path.join(paths.assetsRoot, "plugin", "antigravity")]],
    claude: [[path.join(paths.home, ".claude", "skills", "token-optimizer"), path.join(paths.assetsRoot, "plugin", "claude")], [path.join(paths.installRoot, "plugin", "claude"), path.join(paths.assetsRoot, "plugin", "claude")]],
    codex: [[path.join(paths.home, ".codex", "skills", "token-optimizer"), path.join(paths.assetsRoot, "plugin", "codex", "skills", "token-optimizer")], [path.join(paths.installRoot, "plugin", "codex"), path.join(paths.assetsRoot, "plugin", "codex")]],
  }[client] || [])).filter(([root]) => fs.existsSync(root));
  const roots = mappings.map(([root]) => root);
  const files = [];
  const walk = (directory, sourceRoot) => {
    let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const source = path.join(sourceRoot, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!["node_modules", ".data", ".cache", "cache", "logs", ".codex-local-test-runs"].includes(entry.name)) walk(file, source);
      } else if (entry.isFile() && fs.existsSync(source) && !/\.(?:log|tmp|cache)$/i.test(entry.name)) {
        files.push({ path: file, source, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), ownership: "installer" });
      }
    }
  };
  mappings.forEach(([root, sourceRoot]) => walk(root, sourceRoot));
  const managedBlocks = [
    path.join(paths.home, ".claude", "CLAUDE.md"), path.join(paths.home, ".codex", "AGENTS.md"), path.join(paths.home, ".gemini", "GEMINI.md"),
    path.join(paths.home, ".config", "opencode", "AGENTS.md"),
  ].filter((file) => fs.existsSync(file)).map((file) => {
    const content = fs.readFileSync(file, "utf8");
    const block = content.match(/<!-- TOKEN_OPTIMIZER_START -->[\s\S]*?<!-- TOKEN_OPTIMIZER_END -->/)?.[0] || "";
    return { path: file, marker: "TOKEN_OPTIMIZER_START", blockSha256: crypto.createHash("sha256").update(block).digest("hex") };
  });
  const existingManifest = readManifest(paths.home);
  const credentials = options.credentialOwnershipCleared ? [] : options.credentialRef && options.credentialOwned !== false && options.credentialRef.store !== "env"
    ? [{ reference: options.credentialRef, ownership: "installer" }]
    : (existingManifest?.credentials || []);
  const registrationPaths = {
    claude: [path.join(paths.home, ".claude", "settings.json")], codex: [path.join(paths.home, ".codex", "config.toml")],
    antigravity: [path.join(paths.home, ".gemini", "config", "mcp_config.json")], opencode: [path.join(paths.home, ".config", "opencode", "opencode.jsonc")],
    cursor: [path.join(paths.home, ".cursor", "mcp.json")],
  };
  const registrations = clients.map((client) => { const paths = (registrationPaths[client] || []).filter((file) => fs.existsSync(file)); return { client, paths, canonicalPath: paths[0], template: paths[0] ? captureRegistrationTemplate(paths[0], client) : null, ownership: "installer" }; })
    .concat((options.lifecycleRegistrations || []).map((registration) => ({ ...registration, ownership: "installer" })));
  const launchAgent = path.join(paths.home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const platformServices = process.platform === "darwin" && fs.existsSync(launchAgent)
    ? [{ platform: "darwin", service: LAUNCH_AGENT_LABEL, path: launchAgent, content: fs.readFileSync(launchAgent, "utf8"), managedEnv: buildProviderValues(options), ownership: "installer" }]
    : [];
  writeManifest(paths.home, { schemaVersion: 2, roots: [...new Set(roots.map((root) => path.resolve(root)))], assetRoots: [paths.assetsRoot], managedBlocks, credentials, registrations, platformServices, files });
}

function captureRegistrationTemplate(file, client) { const text = fs.readFileSync(file, "utf8"); if (client === "codex") return text.match(/^\[mcp_servers\.(?:"?token[_-]optimizer"?)\]\s*$[\s\S]*?(?=^\[(?!mcp_servers\.token_optimizer\.env)|(?![\s\S]))/m)?.[0] || null; try { const data = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1")); const container = client === "opencode" ? data.mcp : data.mcpServers; return container?.token_optimizer || container?.["token-optimizer"] || null; } catch (_) { return null; } }

function clientTargets(client, paths, options = {}) {
  const roots = {
    opencode: [path.join(paths.home, ".config", "opencode")],
    cursor: [
      path.join(paths.home, ".cursor"),
      ...(options.cursorProjects || []).map((project) => path.join(path.resolve(project), ".cursor")),
    ],
    antigravity: [path.join(paths.home, ".gemini")],
    claude: [path.join(paths.home, ".claude"), paths.installRoot],
    codex: [path.join(paths.home, ".codex"), paths.installRoot],
  };
  return roots[client] || [];
}

/*
 * Rollback snapshots are restricted to the client-owned roots listed in the
 * plan. Traversing the whole home directory can cross unrelated macOS TCC
 * boundaries such as Music, Photos, or other privacy-protected folders.
 */
function snapshotTargets(targets, boundaries = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-optimizer-plan-"));
  try {
    const entries = [...new Set(targets.map((target) => path.resolve(target)))].map((target, index) => {
      const source = path.join(root, String(index));
      const existed = fs.existsSync(target);
      if (existed) fs.cpSync(target, source, { recursive: true });
      const boundary = boundaries
        .map((candidate) => path.resolve(candidate))
        .filter((candidate) => target === candidate || target.startsWith(`${candidate}${path.sep}`))
        .sort((left, right) => right.length - left.length)[0];
      return { target, source, existed, boundary };
    });
    return { root, entries };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restoreTargets(snapshot) {
  for (const entry of snapshot.entries) {
    fs.rmSync(entry.target, { recursive: true, force: true });
    if (entry.existed) fs.cpSync(entry.source, entry.target, { recursive: true });
    else pruneEmptyParents(path.dirname(entry.target), entry.boundary);
  }
  fs.rmSync(snapshot.root, { recursive: true, force: true });
}

function discardSnapshot(snapshot) {
  fs.rmSync(snapshot.root, { recursive: true, force: true });
}

function pruneEmptyParents(directory, boundary) {
  let current = path.resolve(directory);
  const stop = boundary ? path.resolve(boundary) : current;
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try { fs.rmdirSync(current); }
    catch { break; }
    current = path.dirname(current);
  }
}

function normalizeClients(clients, home = process.env.HOME || os.homedir()) {
  if (!clients || clients.length === 0 || clients.includes("detected")) {
    const detected = detectClients(home);
    return detected.length > 0 ? detected : ["opencode", "cursor"];
  }
  if (clients.includes("all")) {
    return ["claude", "codex", "antigravity", "opencode", "cursor"];
  }
  return [...new Set(clients.map((client) => client.trim().toLowerCase()).filter(Boolean))];
}

function detectClients(home = process.env.HOME || os.homedir()) {
  const clients = [];
  const shouldProbeCommands = path.resolve(home) === path.resolve(process.env.HOME || os.homedir());
  if ((shouldProbeCommands && commandExists("claude")) || fs.existsSync(path.join(home, ".claude"))) {
    clients.push("claude");
  }
  if ((shouldProbeCommands && commandExists("codex")) || fs.existsSync(path.join(home, ".codex"))) {
    clients.push("codex");
  }
  if (fs.existsSync(path.join(home, ".gemini"))) {
    clients.push("antigravity");
  }
  if ((shouldProbeCommands && commandExists("opencode")) || fs.existsSync(path.join(home, ".config", "opencode"))) {
    clients.push("opencode");
  }
  if (fs.existsSync(path.join(home, ".cursor"))) {
    clients.push("cursor");
  }
  return clients;
}

function installOpenCode(options) {
  const serverDest = path.join(options.home, ".config", "opencode", "token-optimizer-server");
  const skillDest = path.join(options.home, ".config", "opencode", "skills", "token-optimizer");
  copyDirectory(path.join(options.assetsRoot, "plugin", "opencode", "server"), serverDest);
  copyDirectory(path.join(options.assetsRoot, "plugin", "opencode", "skills", "token-optimizer"), skillDest);
  applyGatewayConfig({ ...options, clients: ["opencode"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["opencode"] });
  }
}

function installCursor(options) {
  const serverDest = path.join(options.home, ".cursor", "token-optimizer-server");
  copyDirectory(path.join(options.assetsRoot, "plugin", "cursor", "server"), serverDest);
  applyGatewayConfig({ ...options, clients: ["cursor"] });
  const projects = options.cursorProjects || [];
  for (const project of projects) {
    const ruleDest = path.join(path.resolve(project), ".cursor", "rules", "token-optimizer.mdc");
    copyFile(path.join(options.assetsRoot, "plugin", "cursor", "rules", "token-optimizer.mdc"), ruleDest);
  }
}

function installAntigravity(options) {
  const pluginDest = path.join(options.home, ".gemini", "config", "plugins", "token-optimizer");
  copyDirectory(path.join(options.assetsRoot, "plugin", "antigravity"), pluginDest);
  applyGatewayConfig({ ...options, clients: ["gemini", "antigravity"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["gemini"] });
  }
}

function installClaude(options) {
  const pluginDest = path.join(options.installRoot, "plugin", "claude");
  copyDirectory(path.join(options.assetsRoot, "plugin", "claude"), pluginDest);
  const marketplaceSrc = path.join(options.assetsRoot, ".claude-plugin");
  if (fs.existsSync(marketplaceSrc)) {
    copyDirectory(marketplaceSrc, path.join(options.installRoot, ".claude-plugin"));
  }
  /* Try the CLI route first. When the claude CLI is unavailable (desktop-app
     installs, common on Windows), fall back to a skills-directory plugin:
     Claude Code loads any folder under ~/.claude/skills/ that carries a
     .claude-plugin/plugin.json as a full plugin (token-optimizer@skills-dir)
     on the next session — MCP server and skill included, no CLI needed. */
  const marketplaceAdded = tryClientCommand("claude", ["plugin", "marketplace", "add", options.installRoot], options);
  /* Claude owns installed marketplace versions separately from the source
     directory. Refresh that version first, then install only when absent. */
  const pluginInstalled = marketplaceAdded && (
    tryClientCommand("claude", ["plugin", "update", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], options)
    || tryClientCommand("claude", ["plugin", "install", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], options)
  );
  if (pluginInstalled) (options.lifecycleRegistrations ||= []).push({ client: "claude", kind: "marketplace", remove: ["plugin", "uninstall", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], restore: ["plugin", "install", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`] });
  if (!pluginInstalled) {
    copyDirectory(path.join(options.assetsRoot, "plugin", "claude"), path.join(options.home, ".claude", "skills", "token-optimizer"));
  }
  applyGatewayConfig({ ...options, clients: ["claude"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["claude"] });
  }
}

function installCodex(options) {
  const pluginDest = path.join(options.installRoot, "plugin", "codex");
  copyDirectory(path.join(options.assetsRoot, "plugin", "codex"), pluginDest);
  ensureDirectory(path.join(options.installRoot, ".agents", "plugins"));
  const marketplaceSrc = path.join(options.assetsRoot, ".agents", "plugins", "marketplace.json");
  if (fs.existsSync(marketplaceSrc)) {
    copyFile(marketplaceSrc, path.join(options.installRoot, ".agents", "plugins", "marketplace.json"));
  }
  /* Marketplace registration keeps the plugin available for Codex skill
     discovery. The direct server registration remains authoritative because it
     carries the installer-managed provider environment into the MCP process. */
  const marketplaceAdded = tryClientCommand("codex", ["plugin", "marketplace", "add", options.installRoot], options);
  if (marketplaceAdded) {
    /* Codex caches installed marketplace plugins by version. Removing is
       harmless on first install and forces a fresh cache before adding. */
    tryClientCommand("codex", ["plugin", "remove", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options);
    tryClientCommand("codex", ["plugin", "add", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options);
    (options.lifecycleRegistrations ||= []).push({ client: "codex", kind: "marketplace", remove: ["plugin", "remove", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], restore: ["plugin", "add", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME] });
  }
  const startJs = path.join(pluginDest, "server", "start.js");
  const configPath = path.join(options.home, ".codex", "config.toml");
  ensureDirectory(path.dirname(configPath));
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  if (existing) {
    backupFile(configPath, installerPaths(options).backupRoot);
  }
  fs.writeFileSync(configPath, upsertCodexTomlServer(existing, startJs, buildProviderValues(options)));
  const skillSrc = path.join(options.assetsRoot, "plugin", "codex", "skills", "token-optimizer");
  if (fs.existsSync(skillSrc)) {
    copyDirectory(skillSrc, path.join(options.home, ".codex", "skills", "token-optimizer"));
  }
  applyGatewayConfig({ ...options, clients: ["codex"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["codex"] });
  }
}

function applyGatewayConfig(options) {
  const paths = installerPaths(options);
  const values = options.providerValues || buildProviderValues(options);
  /* Defensive: callers are expected to normalize "detected"/empty client lists before reaching
     here (see planProviderConfiguration), but normalizeClients is idempotent on an already-real
     list, so re-running it here costs nothing and guards any future caller that forgets to. */
  const clients = normalizeClients(options.clients, paths.home);
  for (const target of getGatewayTargets(paths.home)) {
    if (!target.matches(clients)) {
      continue;
    }
    const config = safeReadConfig(target);
    const nextConfig = target.applyValues(config, values);
    /* A target may return null to signal "nothing to write" (e.g. the codex
       config.toml target when no token_optimizer section exists). */
    if (nextConfig != null) {
      writeConfigTarget(target, nextConfig, paths.backupRoot);
    }
  }
  applyLaunchctlValues(values, options);
}

function applyDefaultDirectives(options) {
  const paths = installerPaths(options);
  for (const target of getDirectiveTargets(paths.home)) {
    if (!target.matches(options.clients)) {
      continue;
    }
    if (fs.existsSync(target.filePath)) {
      backupFile(target.filePath, paths.backupRoot);
    }
    ensureDirectory(path.dirname(target.filePath));
    const existing = fs.existsSync(target.filePath) ? fs.readFileSync(target.filePath, "utf8") : "";
    fs.writeFileSync(target.filePath, applyDirectiveBlock(existing));
  }
}

function getGatewayTargets(home) {
  /* All launch commands use `node` + the cross-platform start.js launcher —
     Windows has no usable bash on PATH (System32 bash.exe is WSL). Command and
     args are overwritten on every write so stale bash/start.sh entries from
     older installs are repaired in place. */
  const localTesterServerArgs = [path.join(home, ".gemini", "config", "plugins", "token-optimizer", "server", "start.js")];
  const opencodeServerCommand = ["node", path.join(home, ".config", "opencode", "token-optimizer-server", "start.js")];
  const cursorServerArgs = [path.join(home, ".cursor", "token-optimizer-server", "start.js")];
  const codexInstallRoot = path.join(home, ".token-optimizer");
  const codexStartJs = path.join(codexInstallRoot, "plugin", "codex", "server", "start.js");
  return [
    {
      /* Codex CLI-free installs keep their server in ~/.codex/config.toml.
         Only update env values when the token_optimizer section already
         exists — plugin-based installs must not gain a duplicate server. */
      clients: ["codex"],
      filePath: path.join(home, ".codex", "config.toml"),
      readConfig: (filePath) => fs.readFileSync(filePath, "utf8"),
      writeConfig: (filePath, content) => fs.writeFileSync(filePath, content),
      matches: matchesClient,
      applyValues(config, values) {
        const content = typeof config === "string" ? config : "";
        if (!content.includes("[mcp_servers.token_optimizer]")) {
          return null;
        }
        return upsertCodexTomlServer(content, codexStartJs, values);
      },
    },
    {
      clients: ["claude"],
      filePath: path.join(home, ".claude", "settings.json"),
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      matches: matchesClient,
      applyValues(config, values) {
        const next = config;
        next.env = mergeManagedEnvValues(next.env || {}, values);
        return next;
      },
    },
    {
      clients: ["gemini"],
      filePath: path.join(home, ".gemini", "config", "mcp_config.json"),
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      matches: matchesClient,
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {};
        next.mcpServers.token_optimizer.command = "node";
        next.mcpServers.token_optimizer.args = localTesterServerArgs;
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(next.mcpServers.token_optimizer.env || {}, values);
        return next;
      },
    },
    {
      clients: ["antigravity"],
      filePath: path.join(home, ".gemini", "config", "plugins", "token-optimizer", "mcp_config.json"),
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      matches: matchesClient,
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {};
        next.mcpServers.token_optimizer.command = "node";
        next.mcpServers.token_optimizer.args = localTesterServerArgs;
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(next.mcpServers.token_optimizer.env || {}, values);
        return next;
      },
    },
    {
      clients: ["opencode"],
      filePath: path.join(home, ".config", "opencode", "opencode.jsonc"),
      readConfig: readJsoncFile,
      writeConfig: writeJsonFile,
      matches: matchesClient,
      applyValues(config, values) {
        const next = config;
        next.mcp = next.mcp || {};
        delete next.mcp.local_tester;
        next.mcp.token_optimizer = next.mcp.token_optimizer || {};
        next.mcp.token_optimizer.type = next.mcp.token_optimizer.type || "local";
        next.mcp.token_optimizer.command = opencodeServerCommand;
        next.mcp.token_optimizer.enabled = next.mcp.token_optimizer.enabled !== false;
        next.mcp.token_optimizer.environment = mergeManagedEnvValues(next.mcp.token_optimizer.environment || {}, values);
        return next;
      },
    },
    {
      clients: ["cursor"],
      filePath: path.join(home, ".cursor", "mcp.json"),
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      matches: matchesClient,
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {};
        next.mcpServers.token_optimizer.command = "node";
        next.mcpServers.token_optimizer.args = cursorServerArgs;
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(next.mcpServers.token_optimizer.env || {}, values);
        return next;
      },
    },
  ];
}

function getDirectiveTargets(home) {
  return [
    { clients: ["claude"], filePath: path.join(home, ".claude", "CLAUDE.md"), matches: matchesClient },
    { clients: ["codex"], filePath: path.join(home, ".codex", "AGENTS.md"), matches: matchesClient },
    { clients: ["gemini"], filePath: path.join(home, ".gemini", "GEMINI.md"), matches: matchesClient },
    { clients: ["opencode"], filePath: path.join(home, ".config", "opencode", "AGENTS.md"), matches: matchesClient },
  ];
}

function matchesClient(selectedClients) {
  if (!selectedClients || selectedClients.length === 0 || selectedClients.includes("all")) {
    return true;
  }
  return this.clients.some((client) => selectedClients.includes(client));
}

function safeReadConfig(target) {
  if (!fs.existsSync(target.filePath)) {
    return {};
  }
  return target.readConfig(target.filePath);
}

function writeConfigTarget(target, config, backupRoot) {
  ensureDirectory(path.dirname(target.filePath));
  if (fs.existsSync(target.filePath)) {
    backupFile(target.filePath, backupRoot);
  }
  target.writeConfig(target.filePath, config);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsoncFile(filePath) {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(filePath, "utf8")));
}

function writeJsonFile(filePath, config) {
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

function mergeManagedEnvValues(existingEnv, incomingValues) {
  const next = { ...existingEnv };
  for (const envKey of MANAGED_ENV_KEYS) {
    const value = incomingValues[envKey];
    if (value) {
      next[envKey] = value;
    } else {
      delete next[envKey];
    }
  }
  return next;
}

function applyDirectiveBlock(content) {
  const startIdx = content.indexOf(DIRECTIVE_MARKER_START);
  const endIdx = content.indexOf(DIRECTIVE_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    return `${content.slice(0, startIdx)}${DIRECTIVE_BLOCK}${content.slice(endIdx + DIRECTIVE_MARKER_END.length)}`;
  }
  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${DIRECTIVE_BLOCK}`;
}

function stripJsonCommentsAndTrailingCommas(content) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return stripTrailingCommas(out);
}

function stripTrailingCommas(content) {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < content.length && /\s/.test(content[j])) {
        j += 1;
      }
      if (content[j] === "}" || content[j] === "]") {
        continue;
      }
    }
    out += char;
  }
  return out;
}

function applyLaunchctlValues(values, options = {}) {
  if (options.skipLaunchctl) {
    return;
  }
  /* Mirror managed client config updates so a provider switch cannot leave
     stale credentials or model overrides in the GUI-session environment. The
     immediate setenv fixes the current login; the LaunchAgent makes it stick
     across reboots. */
  for (const envKey of MANAGED_ENV_KEYS) {
    if (values[envKey]) {
      runLaunchctl(["setenv", envKey, values[envKey]], options);
    } else {
      runLaunchctl(["unsetenv", envKey], options);
    }
  }
  writePersistentLaunchAgent(values, options);
}

/* Writes (or removes) the RunAtLoad LaunchAgent that re-applies the managed
   env at every login. The plist file always tracks the current provider
   values; the actual `launchctl bootstrap` reload only runs for a real macOS
   install (not under the test state-path hook, not off a temporary home). */
function writePersistentLaunchAgent(values, options = {}) {
  const home = path.resolve(options.home || process.env.HOME || os.homedir());
  const plistPath = path.join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
  const hasAny = MANAGED_ENV_KEYS.some((envKey) => values[envKey]);
  if (!hasAny) {
    if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath, { force: true });
    }
    reloadLaunchAgent(plistPath, true, options, home);
    return;
  }
  ensureDirectory(path.dirname(plistPath));
  fs.writeFileSync(plistPath, buildLaunchAgentPlist(values));
  try {
    fs.chmodSync(plistPath, 0o600);
  } catch {
    /* best-effort: a non-POSIX FS may reject chmod; the plist is still valid. */
  }
  reloadLaunchAgent(plistPath, false, options, home);
}

function buildLaunchAgentPlist(values) {
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = MANAGED_ENV_KEYS
    .filter((envKey) => values[envKey])
    .map((envKey) => `launchctl setenv ${envKey} ${shQuote(values[envKey])}`)
    .join("; ");
  const xmlEscape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCH_AGENT_LABEL}</string>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>/bin/sh</string>",
    "    <string>-c</string>",
    `    <string>${xmlEscape(command)}</string>`,
    "  </array>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function reloadLaunchAgent(plistPath, remove, options = {}, home) {
  const usingStateHook = options.launchctlStatePath || process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH;
  const realHome = path.resolve(home) === path.resolve(process.env.HOME || os.homedir());
  if (usingStateHook || process.platform !== "darwin" || !realHome) {
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
  } catch {
    /* No existing agent to unload on first install; ignore. */
  }
  if (!remove) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      /* Reload failure still leaves a valid plist that loads on next login. */
    }
  }
}

function runLaunchctl(args, options = {}) {
  const statePath = options.launchctlStatePath || process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH;
  if (statePath) {
    let state = {};
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    }
    const [command, envKey, value] = args;
    if (command === "setenv") {
      state[envKey] = value;
      ensureDirectory(path.dirname(statePath));
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    } else if (command === "unsetenv") {
      delete state[envKey];
      ensureDirectory(path.dirname(statePath));
      fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return;
  }
  if (process.platform !== "darwin") {
    return;
  }
  execFileSync("launchctl", args, { stdio: "ignore" });
}

/* Runs a client CLI, returning whether it succeeded. On Windows, npm-installed
   client CLIs are .cmd shims that cannot be spawned directly by name (and
   recent Node throws EINVAL for .cmd without a shell), so failures are retried
   through cmd.exe. A false return triggers each client's CLI-free fallback. */
function tryClientCommand(command, args, options) {
  if (options.skipClientCommands) {
    return false;
  }
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    if (process.platform === "win32") {
      try {
        execFileSync("cmd.exe", ["/c", command, ...args], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/* Migration phases are exposed separately so one registered change plan can
   keep rollback state alive through credential validation and legacy cleanup. */
function copyClientAssets(client, options) {
  if (client === "opencode") {
    copyDirectory(path.join(options.assetsRoot, "plugin", "opencode", "server"), path.join(options.home, ".config", "opencode", "token-optimizer-server"));
    copyDirectory(path.join(options.assetsRoot, "plugin", "opencode", "skills", "token-optimizer"), path.join(options.home, ".config", "opencode", "skills", "token-optimizer"));
  } else if (client === "cursor") {
    copyDirectory(path.join(options.assetsRoot, "plugin", "cursor", "server"), path.join(options.home, ".cursor", "token-optimizer-server"));
    for (const project of options.cursorProjects || []) copyFile(path.join(options.assetsRoot, "plugin", "cursor", "rules", "token-optimizer.mdc"), path.join(path.resolve(project), ".cursor", "rules", "token-optimizer.mdc"));
  } else if (client === "antigravity") copyDirectory(path.join(options.assetsRoot, "plugin", "antigravity"), path.join(options.home, ".gemini", "config", "plugins", "token-optimizer"));
  else if (client === "claude" || client === "codex") copyDirectory(path.join(options.assetsRoot, "plugin", client), path.join(options.installRoot, "plugin", client));
  else throw new Error(`Unsupported client: ${client}`);
}

function configureMigratedClient(client, options) {
  if (client === "codex") {
    const file = path.join(options.home, ".codex", "config.toml");
    ensureDirectory(path.dirname(file));
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.writeFileSync(file, upsertCodexTomlServer(existing, path.join(options.installRoot, "plugin", "codex", "server", "start.js"), options.providerValues));
    const skill = path.join(options.assetsRoot, "plugin", "codex", "skills", "token-optimizer");
    if (fs.existsSync(skill)) copyDirectory(skill, path.join(options.home, ".codex", "skills", "token-optimizer"));
  } else applyGatewayConfig({ ...options, clients: client === "antigravity" ? ["gemini", "antigravity"] : [client], skipLaunchctl: true });
  if (options.defaults !== false && client !== "cursor") applyDefaultDirectives({ ...options, clients: client === "antigravity" ? ["gemini"] : [client] });
}

function registerMigratedClient(client, options) {
  if (client === "claude") {
    const added = tryClientCommand("claude", ["plugin", "marketplace", "add", options.installRoot], options);
    const installed = added && (tryClientCommand("claude", ["plugin", "update", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], options) || tryClientCommand("claude", ["plugin", "install", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], options));
    if (!installed) copyDirectory(path.join(options.assetsRoot, "plugin", "claude"), path.join(options.home, ".claude", "skills", "token-optimizer"));
    return installed;
  }
  if (client === "codex") {
    const added = tryClientCommand("codex", ["plugin", "marketplace", "add", options.installRoot], options);
    if (added) { tryClientCommand("codex", ["plugin", "remove", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options); tryClientCommand("codex", ["plugin", "add", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options); }
    return added;
  }
  return false;
}

function commandExists(command) {
  const [probe, probeArgs] = process.platform === "win32"
    ? ["where", [command]]
    : ["sh", ["-lc", `command -v ${command}`]];
  try {
    execFileSync(probe, probeArgs, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/* Replaces (or appends) the [mcp_servers.token_optimizer] section — including
   its .env subtable — in a Codex config.toml, leaving all other content
   untouched. Used by CLI-free Codex installs. Paths are written as TOML
   literal strings so Windows backslashes need no escaping. */
function upsertCodexTomlServer(content, startJsPath, values) {
  const sectionPattern = /^\[mcp_servers\.token_optimizer(?:\.[A-Za-z0-9_.]+)?\][^\S\r\n]*\r?\n(?:(?!^\[).*(?:\r?\n|$))*/gm;
  let base = String(content || "").replace(sectionPattern, "");
  if (base && !base.endsWith("\n")) {
    base += "\n";
  }
  const env = mergeManagedEnvValues({}, values);
  const tomlString = (value) => (value.includes("'") ? JSON.stringify(value) : `'${value}'`);
  const lines = [
    "[mcp_servers.token_optimizer]",
    "command = 'node'",
    `args = [${tomlString(startJsPath)}]`,
    /* First launch runs npm install; give it headroom beyond Codex's default. */
    "startup_timeout_sec = 120",
    "",
    "[mcp_servers.token_optimizer.env]",
    ...Object.entries(env).map(([key, value]) => `${key} = ${tomlString(value)}`),
  ];
  const separator = base ? "\n" : "";
  return `${base}${separator}${lines.join("\n")}\n`;
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Installer asset missing: ${src}`);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`Installer asset missing: ${src}`);
  }
  ensureDirectory(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function backupFile(filePath, backupRoot) {
  ensureDirectory(backupRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(filePath, path.join(backupRoot, `${path.basename(filePath)}.${timestamp}.bak`));
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  DEFAULT_LOCAL_LLM_URL,
  DEFAULT_LOCAL_LLM_MODEL,
  MANAGED_ENV_KEYS,
  LAUNCH_AGENT_LABEL,
  emptyManagedValues,
  buildProviderValues,
  prepareCredentialOptions,
  normalizeProviderChoice,
  planMigration,
  DIRECTIVE_MARKER_START,
  installerPaths,
  planInstallation,
  applyChangePlan,
  formatChangePlan,
  detectClients,
  installSelectedClients,
  planProviderConfiguration,
  applyProviderConfiguration,
  persistProviderCredentialOwnership,
  persistInstallManifest,
  installOpenCode,
  installCursor,
  installAntigravity,
  installClaude,
  installCodex,
  applyGatewayConfig,
  applyDefaultDirectives,
  applyDirectiveBlock,
  stripJsonCommentsAndTrailingCommas,
  upsertCodexTomlServer,
  copyClientAssets,
  configureMigratedClient,
  registerMigratedClient,
  applyLaunchctlValues,
};
