const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFileSync } = require("child_process");
const pkg = require("../package.json");
const { createCredentialStore } = require("./credential-store");

const CLIENTS = ["claude", "codex", "antigravity", "opencode", "cursor"];
const PLACEHOLDER = /^(?:none|null|undefined|placeholder|change[-_ ]?me|.*(?:your|insert|replace)[-_ ]?(?:with[-_ ]?)?(?:token|key).*|<[^>]+>|\$\{[^}]+\})$/i;
const SECRET_KEYS = ["LLM_GATEWAY_TOKEN", "OPENROUTER_BYOK_KEY", "OPENROUTER_API_KEY"];

/* Diagnostics are deliberately implemented as bounded reads of known managed
   locations. Every finding has a stable code and enough machine-readable
   context for repair without including credentials or mutating inspected state. */
async function inspectInstallation(options = {}) {
  const home = path.resolve(options.home || process.env.HOME || os.homedir());
  const expectedVersion = options.expectedVersion || pkg.version;
  const registrations = inspectClients(home, options);
  const versions = inspectVersions(registrations.registrations, expectedVersion);
  const explicitVersion = usable(options.installedVersion) ? { version: String(options.installedVersion), source: "option-installed-version", path: null }
    : usable(options.detectedVersion) ? { version: String(options.detectedVersion), source: "option-detected-version", path: null } : null;
  const provider = inspectProviderReference(home, options, registrations.registrations);
  const manifest = inspectManifest(home, options);
  const logs = inspectLogState(home, options);
  const runtime = inspectRuntime(registrations.registrations, options);
  const platformService = inspectPlatformService(home, provider, registrations.registrations, options);
  const findings = [];

  if (!provider.mode || provider.mode === "skip") add(findings, "PROVIDER_MISSING", "error", "No LLM provider is configured.", "Run `token-optimizer config` or reinstall with a provider option.", { operation: "configure-provider" });
  else if (provider.requiresCredential && !provider.credentialConfigured) add(findings, provider.credentialError === "inaccessible" ? "CREDENTIAL_INACCESSIBLE" : "CREDENTIAL_MISSING", "error", provider.credentialError === "inaccessible" ? "The configured credential store cannot be accessed." : "The configured provider has no usable credential.", "Configure the provider again with an accessible credential store.", { operation: "configure-provider" });
  for (const registration of registrations.registrations.filter((item) => item.stale)) add(findings, "STALE_REGISTRATION", "warning", `${registration.client} registration points to a missing or obsolete launcher.`, "Repair the managed client registration.", { client: registration.client, path: registration.configPath, operation: "rewrite-registration" });
  for (const client of CLIENTS) if (registrations.registrations.filter((item) => item.client === client).length > 1) add(findings, "DUPLICATE_REGISTRATION", "warning", `${client} has multiple Token Optimizer MCP registrations.`, "Keep one managed registration and remove stale duplicates.", { client, operation: "deduplicate-registration" });
  if (!registrations.configured.length) add(findings, "CLIENT_NOT_CONFIGURED", "warning", "No Token Optimizer MCP registration was detected.", "Install for a client with `--clients <name>`.", { operation: "install-client" });
  const versionCandidates = explicitVersion ? [explicitVersion] : versions.detected;
  for (const item of versionCandidates.filter((entry) => entry.version !== expectedVersion)) add(findings, "VERSION_MISMATCH", "warning", `Installed server ${item.version} differs from expected ${expectedVersion}.`, `Repair or reinstall Token Optimizer ${expectedVersion}.`, { client: item.client, path: item.path, operation: "refresh-assets" });
  for (const issue of runtime) add(findings, issue.code, "error", issue.message, "Repair the installed server runtime.", { client: issue.client, path: issue.path, operation: "refresh-runtime" });
  for (const issue of manifest.findings) findings.push(issue);
  for (const issue of platformService) findings.push(issue);
  for (const legacy of inspectLegacySecrets(home, registrations.registrations)) add(findings, "LEGACY_RAW_CREDENTIAL", "warning", "A legacy client configuration contains a raw provider credential.", "Migrate it to a credential reference, then remove the raw value.", { path: legacy, operation: "migrate-credential" });
  if (logs.error) add(findings, logs.error.code, "error", logs.error.message, logs.error.remediation, { path: logs.directory, operation: "repair-log-store" });
  else if (logs.bytes > logs.quotaBytes) add(findings, "LOG_QUOTA_EXCEEDED", "warning", "Workspace run logs exceed the configured quota.", "Run `token-optimizer logs prune --workspace <absolute-path>`.", { path: logs.directory, operation: "prune-logs" });

  if (options.performHealthProbe === true && provider.url && provider.mode !== "skip") {
    if (provider.requiresCredential && !provider.credentialValue) add(findings, "PROVIDER_AUTH_FAILED", "error", "Provider authentication could not be attempted with a usable credential.", "Configure a valid provider credential.", { operation: "configure-provider" });
    else {
      try {
        const probe = await (options.healthProbe || defaultHealthProbe)({ url: provider.url, mode: provider.mode, credential: provider.credentialValue, timeoutMs: options.healthProbeTimeoutMs });
        if (!probe || probe.ok === false) add(findings, probe && (probe.statusCode === 401 || probe.statusCode === 403) ? "PROVIDER_AUTH_FAILED" : "PROVIDER_UNREACHABLE", probe && (probe.statusCode === 401 || probe.statusCode === 403) ? "error" : "warning", "The authenticated provider liveness check failed.", "Verify the provider URL and credential.", { operation: "configure-provider" });
      } catch (_) { add(findings, "PROVIDER_UNREACHABLE", "warning", "The provider liveness endpoint could not be reached.", "Check the endpoint URL and network connectivity.", { operation: "configure-provider" }); }
    }
  }
  delete provider.credentialValue;
  const detected = explicitVersion || versions.detected[0] || null;
  const publicClients = { ...registrations, registrations: registrations.registrations.map((item) => ({ ...item, env: Object.fromEntries(Object.keys(item.env || {}).map((key) => [key, "<configured>"])) })) };
  return { schemaVersion: 3, installedVersion: detected ? detected.version : null, installedVersionSource: detected ? detected.source : "not-detected", installedVersionPath: detected ? detected.path : null, detectedVersions: versions.detected, expectedVersion, healthy: findings.every((item) => item.severity !== "error"), effectiveProfile: options.effectiveProfile || options.profile || "standard", provider, clients: publicClients, runtime, manifest: manifest.summary, platformService: platformService.length ? "inconsistent" : "ok", logs, findings };
}

function add(list, code, severity, message, remediation, details = {}) { list.push({ code, severity, message, remediation, ...details }); }
function usable(value) { const text = String(value || "").trim(); return Boolean(text && !PLACEHOLDER.test(text)); }
function canonicalProvider(value) { const normalized = String(value || "").trim().toLowerCase(); return ({ gateway: "gateway-token", byok: "gateway-byok", direct: "openrouter-direct" })[normalized] || normalized || null; }
function redactUrl(value) { if (!value) return null; try { const parsed = new URL(String(value)); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; return parsed.toString().replace(/\/$/, ""); } catch (_) { return String(value).replace(/\?.*$/, ""); } }

function inspectProviderReference(home, options = {}, registrations = []) {
  const env = options.env !== undefined ? options.env : process.env;
  const values = Object.assign({}, ...registrations.map((item) => item.env || {}), env);
  const mode = canonicalProvider(options.providerMode || options.provider || values.TOKEN_OPTIMIZER_PROVIDER_MODE || inferMode(values));
  const rawRef = options.credentialRef || values.TOKEN_OPTIMIZER_CREDENTIAL_REF;
  let ref = rawRef;
  if (typeof ref === "string" && ref.trim().startsWith("{")) { try { ref = JSON.parse(ref); } catch (_) { ref = null; } }
  const key = mode === "gateway-token" ? "LLM_GATEWAY_TOKEN" : mode === "openrouter-direct" ? "OPENROUTER_API_KEY" : "OPENROUTER_BYOK_KEY";
  let credentialValue = null; let credentialError = null;
  if (ref && typeof ref === "object") {
    try {
      const kind = ["config", "protected-config"].includes(ref.store) ? "config" : ref.store === "env" ? "env" : "native";
      const store = (options.createCredentialStore || createCredentialStore)(kind, { home, service: ref.service, account: ref.account, path: ref.path, envVar: ref.variable, env, platform: options.platform || process.platform, ...(options.credentialStoreOptions || {}) });
      credentialValue = store.get(ref);
      if (!usable(credentialValue)) credentialError = credentialValue ? "invalid" : "missing";
    } catch (_) { credentialError = "inaccessible"; }
  } else credentialValue = usable(values[key]) ? values[key] : null;
  if (credentialValue && !usable(credentialValue)) { credentialValue = null; credentialError = "invalid"; }
  const requiresCredential = ["gateway-token", "gateway-byok", "openrouter-direct"].includes(mode);
  const url = options.providerUrl || values.LLM_GATEWAY_URL || values.LOCAL_LLM_API_URL || (mode === "openrouter-direct" ? "https://openrouter.ai/api/v1" : requiresCredential ? "https://llm-proxy.lnf.gr/v1" : null);
  return { mode, url: redactUrl(url), credentialStore: ref && typeof ref === "object" ? ref.store : credentialValue ? "environment" : "none", credentialConfigured: requiresCredential ? Boolean(credentialValue) : true, credentialError, credentialFingerprint: ref && typeof ref === "object" ? ref.fingerprint : undefined, requiresCredential, credentialValue };
}
function inferMode(env) { if (env.TOKEN_OPTIMIZER_PROVIDER_MODE) return env.TOKEN_OPTIMIZER_PROVIDER_MODE; if (env.LOCAL_LLM_API_URL) return "local"; if (env.LLM_GATEWAY_TOKEN) return "gateway-token"; if (env.OPENROUTER_BYOK_KEY) return "gateway-byok"; if (env.OPENROUTER_API_KEY) return "openrouter-direct"; return null; }

/* Registration discovery parses only the five clients' documented config
   files and returns every real token_optimizer entry so duplicates remain visible. */
function inspectClients(home, options = {}) {
  const files = [
    ["claude", path.join(home, ".claude.json"), "json"], ["claude", path.join(home, ".claude", "settings.json"), "json"],
    ["codex", path.join(home, ".codex", "config.toml"), "toml"],
    ["antigravity", path.join(home, ".gemini", "config", "mcp_config.json"), "json"], ["antigravity", path.join(home, ".gemini", "config", "plugins", "token-optimizer", "mcp_config.json"), "json"],
    ["opencode", path.join(home, ".config", "opencode", "opencode.jsonc"), "jsonc"], ["cursor", path.join(home, ".cursor", "mcp.json"), "json"],
  ];
  const registrations = [];
  for (const [client, configPath, type] of files) {
    let text; try { text = fs.readFileSync(configPath, "utf8"); } catch (_) { continue; }
    if (type === "toml") {
      const matches = [...text.matchAll(/^\[mcp_servers\.(?:"?)(token[_-]optimizer)(?:"?)\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/gm)];
      for (const match of matches) { const body = match[2]; const command = valueOf(body, "command"); const args = arrayOf(body, "args"); registrations.push(registration(client, configPath, command, args, envOfToml(text), match[1])); }
      continue;
    }
    let data; try { data = JSON.parse(type === "jsonc" ? text.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1") : text); } catch (_) { continue; }
    const containers = client === "opencode" ? [data.mcp] : [data.mcpServers, data.projects && Object.assign({}, ...Object.values(data.projects).map((p) => p && p.mcpServers || {}))];
    for (const container of containers.filter(Boolean)) for (const [name, entry] of Object.entries(container)) if (/^token[_-]optimizer$/.test(name) && entry && typeof entry === "object") {
      const command = Array.isArray(entry.command) ? entry.command[0] : entry.command; const args = Array.isArray(entry.command) ? entry.command.slice(1) : entry.args || [];
      registrations.push(registration(client, configPath, command, args, entry.env || entry.environment || {}, name));
    }
  }
  registrations.push(...inspectMarketplaceRegistrations(home, options));
  return { supported: CLIENTS, configured: [...new Set(registrations.map((item) => item.client))], registrations };
}

/* Marketplace discovery is filesystem-only in production. Optional listing
   text remains injectable for parser fixtures but no client process is ever
   launched by status or doctor. */
function inspectMarketplaceRegistrations(home, options = {}) {
  const provided = options.pluginListings || {};
  const result = [];
  const caches = [
    ["claude", path.join(home, ".claude", "plugins", "cache", "token-optimizer-marketplace", "token-optimizer")],
    ["codex", path.join(home, ".codex", "plugins", "cache", "Softaware-marketplace", "token-optimizer")],
    ["codex", path.join(home, ".codex", "plugins", "token-optimizer")],
  ];
  for (const [client, root] of caches) {
    let versions = []; try { versions = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch (_) { continue; }
    for (const versionDir of versions) {
      const installedPath = path.join(root, versionDir); const manifest = [path.join(installedPath, ".claude-plugin", "plugin.json"), path.join(installedPath, ".codex-plugin", "plugin.json")].find((file) => fs.existsSync(file));
      let version = versionDir; try { version = JSON.parse(fs.readFileSync(manifest, "utf8")).version || version; } catch (_) {}
      const launcherPath = [path.join(installedPath, "server", "start.js"), path.join(installedPath, "server", "start.sh")].find((file) => fs.existsSync(file)) || null;
      result.push({ client, configPath: manifest || installedPath, name: "token-optimizer", command: "marketplace-cache", args: [], env: {}, launcherPath, marketplace: true, version, installedPath, stale: fs.existsSync(path.join(installedPath, ".orphaned_at")) || !launcherPath });
    }
  }
  for (const [client, output] of Object.entries(provided)) {
    for (const line of String(output || "").split(/\r?\n/).filter((item) => /token[_-]optimizer/i.test(item))) {
      const version = line.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] || null;
      const discoveredPath = line.match(/(?:path|root)\s*[=:]\s*("[^"]+"|'[^']+'|\S+)/i)?.[1]?.replace(/^['"]|['"]$/g, "") || null;
      const launcherPath = discoveredPath ? [path.join(discoveredPath, "server", "start.js"), path.join(discoveredPath, "start.js")].find((candidate) => fs.existsSync(candidate)) || null : null;
      result.push({ client, configPath: "injected plugin listing", name: "token-optimizer", command: "marketplace", args: [], env: {}, launcherPath, marketplace: true, version, installedPath: discoveredPath, stale: /disabled|stale|missing/i.test(line) || Boolean(discoveredPath && !fs.existsSync(discoveredPath)) });
    }
  }
  return result;
}
function registration(client, configPath, command, args, env, name) { const launcherPath = (args || []).find((arg) => /(?:start\.(?:js|sh)|server)/.test(String(arg))) || null; return { client, configPath, name, command: command || null, args: args || [], env, launcherPath, stale: !command || !launcherPath || !fs.existsSync(launcherPath) }; }
function valueOf(text, key) { const match = text.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, "m")); return match ? match[1] : null; }
function arrayOf(text, key) { const match = text.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m")); return match ? [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]) : []; }
function envOfToml(text) { const match = text.match(/^\[mcp_servers\.token_optimizer\.env\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m); if (!match) return {}; return Object.fromEntries([...match[1].matchAll(/^([A-Z0-9_]+)\s*=\s*["']([^"']*)["']/gm)].map((item) => [item[1], item[2]])); }

function inspectVersions(registrations, expectedVersion) {
  const detected = [];
  for (const item of registrations) {
    if (item.marketplace && item.version) { detected.push({ client: item.client, version: item.version, source: "client-plugin-list", path: item.installedPath || item.configPath }); continue; }
    if (!item.launcherPath) continue;
    const server = path.basename(item.launcherPath).startsWith("start.") ? path.dirname(item.launcherPath) : item.launcherPath;
    for (const candidate of [path.join(server, "package.json"), path.join(path.dirname(server), "package.json")]) try { const version = JSON.parse(fs.readFileSync(candidate, "utf8")).version; if (version) { detected.push({ client: item.client, version, source: "server-package", path: candidate }); break; } } catch (_) {}
  }
  return { expectedVersion, detected };
}
function inspectRuntime(registrations, options = {}) { const issues = []; const resolve = options.resolveModule || require.resolve; for (const item of registrations) { if (item.marketplace && !item.installedPath) continue; if (!item.launcherPath || !fs.existsSync(item.launcherPath)) { issues.push({ code: "MISSING_LAUNCHER", client: item.client, path: item.launcherPath || item.installedPath || item.configPath, message: "The registered launcher entrypoint is missing." }); continue; } try { const stat = fs.statSync(item.launcherPath); if (!stat.isFile()) throw new Error("not a file"); if (item.launcherPath.endsWith(".sh") && !(stat.mode & 0o111)) issues.push({ code: "LAUNCHER_NOT_EXECUTABLE", client: item.client, path: item.launcherPath, message: "The shell launcher is not executable." }); } catch (_) { issues.push({ code: "MISSING_LAUNCHER", client: item.client, path: item.launcherPath, message: "The registered launcher entrypoint is not a regular file." }); continue; } const server = path.dirname(item.launcherPath); const cacheRoots = [path.join(server, ".data", "node_modules"), path.join(server, "node_modules"), path.join(path.dirname(server), ".data", "node_modules")]; const cache = cacheRoots.find((root) => fs.existsSync(root)); try { if (!cache) throw new Error("cache missing"); const cachePath = canonicalPath(cache); for (const id of ["@modelcontextprotocol/sdk/server/index.js", "zod/v3"]) { const resolved = canonicalPath(resolve(id, { paths: [cache] })); if (!(resolved === cachePath || resolved.startsWith(`${cachePath}${path.sep}`))) throw new Error("dependency resolved outside launcher cache"); } } catch (_) { issues.push({ code: "DEPENDENCY_CACHE_INCOMPLETE", client: item.client, path: cache || cacheRoots[0], message: "The launcher cache cannot resolve the MCP SDK server entrypoint and zod/v3." }); } } return issues; }

/* Manifest inspection validates each entry independently and never trusts a
   lexical prefix: canonical paths must remain under canonical declared roots. */
function inspectManifest(home, options = {}) {
  const file = path.join(home, ".token-optimizer", "manifest.json"); let data;
  const manifestMaxBytes = positiveLimit(options.manifestMaxBytes, 1024 * 1024);
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > manifestMaxBytes) throw Object.assign(new Error("unsafe manifest"), { code: stat.size > manifestMaxBytes ? "MANIFEST_TOO_LARGE" : "MANIFEST_INVALID" }); data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { const code = error.code === "MANIFEST_TOO_LARGE" ? "MANIFEST_TOO_LARGE" : "MANIFEST_INVALID"; return { summary: { path: file, exists: error.code !== "ENOENT", valid: false, repairable: false }, findings: error.code === "ENOENT" ? [] : [manifestFinding(code, code === "MANIFEST_TOO_LARGE" ? "The ownership manifest exceeds the inspection limit." : "The ownership manifest is unreadable.", file)] }; }
  const findings = []; const schemaValid = data && data.schemaVersion === 2 && Array.isArray(data.files) && Array.isArray(data.roots) && data.roots.length > 0;
  if (!schemaValid) findings.push(manifestFinding("MANIFEST_INVALID", "The ownership manifest schema is invalid.", file));
  const allowedRoots = knownManifestRoots(home, options).map(canonicalPath); const roots = [];
  if (schemaValid) for (const root of data.roots) { if (typeof root !== "string" || !path.isAbsolute(root)) { findings.push(manifestFinding("MANIFEST_ROOT_INVALID", "A manifest root is not a valid absolute path.", file)); continue; } try { const canonical = canonicalPath(root); if (!withinRoots(canonical, allowedRoots)) findings.push(manifestFinding("MANIFEST_ROOT_UNTRUSTED", "A manifest root is outside installer-managed locations.", root)); else roots.push(canonical); } catch (_) { findings.push(manifestFinding("MANIFEST_ROOT_INACCESSIBLE", "A manifest root cannot be resolved safely.", root)); } }
  const maxEntries = positiveLimit(options.manifestMaxEntries, 10000); const maxFileBytes = positiveLimit(options.manifestMaxFileBytes, 10 * 1024 * 1024); const maxTotalBytes = positiveLimit(options.manifestMaxTotalBytes, 100 * 1024 * 1024); let totalBytes = 0;
  const entries = schemaValid ? data.files.slice(0, maxEntries) : [];
  const declaredAssetRoots = Array.isArray(data.assetRoots) ? data.assetRoots.filter((root) => typeof root === "string" && path.isAbsolute(root)).map(canonicalPath) : [];
  if (schemaValid && data.files.length > maxEntries) findings.push(manifestFinding("MANIFEST_ENTRY_LIMIT_EXCEEDED", "The ownership manifest has too many file entries.", file));
  for (const entry of entries) {
    const entryPath = entry && entry.path;
    if (!entry || typeof entryPath !== "string" || !path.isAbsolute(entryPath) || typeof entry.sha256 !== "string" || typeof entry.ownership !== "string") { findings.push(manifestFinding("MANIFEST_ENTRY_INVALID", "A manifest file entry is malformed.", entryPath || file)); continue; }
    if (entry.source !== undefined) { let source; try { source = canonicalPath(entry.source); } catch (_) { source = null; } if (!source || !withinRoots(source, declaredAssetRoots)) { findings.push(manifestFinding("MANIFEST_SOURCE_UNTRUSTED", "A managed file source is outside declared packaged assets.", entryPath)); continue; } }
    let stat; try { stat = fs.lstatSync(entryPath); } catch (error) { if (error.code !== "ENOENT") findings.push(manifestFinding("MANIFEST_ENTRY_INACCESSIBLE", "A managed file cannot be inspected.", entryPath)); continue; }
    if (stat.isSymbolicLink()) { findings.push(manifestFinding("MANIFEST_ENTRY_SYMLINK", "A managed file is a symbolic link.", entryPath)); continue; }
    let canonical; try { canonical = canonicalPath(entryPath); } catch (_) { findings.push(manifestFinding("MANIFEST_ENTRY_INACCESSIBLE", "A managed path cannot be resolved safely.", entryPath)); continue; }
    if (!withinRoots(canonical, roots) || !withinRoots(canonical, allowedRoots)) { findings.push(manifestFinding("MANIFEST_PATH_ESCAPE", "A managed path escapes installer-managed roots.", entryPath)); continue; }
    if (!stat.isFile()) { findings.push(manifestFinding("MANIFEST_ENTRY_NOT_FILE", "A managed path is not a regular file.", entryPath)); continue; }
    if (stat.size > maxFileBytes) { findings.push(manifestFinding("MANIFEST_ENTRY_TOO_LARGE", "A managed file exceeds the per-file inspection limit.", entryPath)); continue; }
    if (totalBytes + stat.size > maxTotalBytes) { findings.push(manifestFinding("MANIFEST_TOTAL_BYTES_EXCEEDED", "Managed files exceed the total inspection limit.", entryPath)); continue; }
    totalBytes += stat.size;
    try { const hash = crypto.createHash("sha256").update(fs.readFileSync(entryPath)).digest("hex"); if (hash !== entry.sha256) add(findings, "MANIFEST_HASH_MISMATCH", "warning", "A managed file differs from its manifest hash.", "Repair from a trusted installer asset source.", { path: entryPath, operation: "restore-managed-file" }); } catch (_) { findings.push(manifestFinding("MANIFEST_ENTRY_INACCESSIBLE", "A managed file cannot be read.", entryPath)); }
  }
  const trustedAssetRoot = canonicalPath(path.resolve(options.assetsRoot || path.join(__dirname, "..", "assets")));
  const sources = (Array.isArray(data.assetRoots) ? data.assetRoots : []).filter((root) => { try { return typeof root === "string" && withinRoots(canonicalPath(root), [trustedAssetRoot]) && fs.existsSync(root); } catch (_) { return false; } }); const repairable = sources.length > 0 || Boolean(options.assetsRoot && fs.existsSync(options.assetsRoot));
  if (findings.length && !repairable) add(findings, "MANIFEST_SOURCE_UNAVAILABLE", "error", "No trusted runtime-cache or installer asset source is available for repair.", "Reinstall from the package before running repair.", { path: file, operation: "reinstall" });
  return { summary: { path: file, exists: true, valid: schemaValid && findings.every((item) => !item.code.startsWith("MANIFEST_") || item.code === "MANIFEST_HASH_MISMATCH"), repairable }, findings };
}
function positiveLimit(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback; }
function withinRoots(target, roots) { return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`)); }
function knownManifestRoots(home, options = {}) { const installRoot = path.resolve(options.installRoot || path.join(home, ".token-optimizer")); const assetsRoot = path.resolve(options.assetsRoot || path.join(__dirname, "..", "assets")); return [installRoot, assetsRoot, path.join(home, ".config", "opencode", "token-optimizer-server"), path.join(home, ".config", "opencode", "skills", "token-optimizer"), path.join(home, ".cursor", "token-optimizer-server"), path.join(home, ".cursor", "rules"), path.join(home, ".gemini", "config", "plugins", "token-optimizer"), path.join(home, ".claude", "skills", "token-optimizer"), path.join(home, ".codex", "skills", "token-optimizer"), ...(options.cursorProjects || []).map((root) => path.join(path.resolve(root), ".cursor", "rules"))]; }
function manifestFinding(code, message, entryPath) { return { code, severity: "error", message, remediation: "Reinstall or repair from a trusted installer source.", path: entryPath, operation: "recreate-manifest" }; }
function canonicalPath(target) { let current = path.resolve(target); const tail = []; while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) break; tail.unshift(path.basename(current)); current = parent; } let resolved = fs.realpathSync.native(current); for (const part of tail) resolved = path.join(resolved, part); return resolved; }

function inspectLegacySecrets(home, registrations) { const paths = [...new Set(registrations.map((item) => item.configPath))]; return paths.filter((file) => { try { const text = fs.readFileSync(file, "utf8"); return SECRET_KEYS.some((key) => new RegExp(`${key}[^\\n]*(?:=|:)\\s*["']?(?!placeholder|changeme|your-token|your-key)[^"'\\s,}]+`, "i").test(text)); } catch (_) { return false; } }); }
function inspectPlatformService(home, provider, registrations, options = {}) { if ((options.platform || process.platform) !== "darwin") return []; const file = path.join(home, "Library", "LaunchAgents", "com.softawarest.token-optimizer.env.plist"); const exists = fs.existsSync(file); const findings = []; if (provider.requiresCredential && !exists) add(findings, "LAUNCH_AGENT_MISSING", "warning", "The macOS provider environment LaunchAgent is missing.", "Repair the LaunchAgent and reload it.", { path: file, operation: "rewrite-launch-agent" }); if (exists) { try { const plist = fs.readFileSync(file, "utf8"); if (!plist.includes("<string>com.softawarest.token-optimizer.env</string>") || !plist.includes("<key>RunAtLoad</key>")) add(findings, "LAUNCH_AGENT_INVALID", "error", "The managed LaunchAgent plist is malformed or has the wrong label.", "Rewrite and reload the managed LaunchAgent.", { path: file, operation: "rewrite-launch-agent" }); } catch (_) { add(findings, "LAUNCH_AGENT_INVALID", "error", "The managed LaunchAgent plist cannot be read.", "Rewrite and reload the managed LaunchAgent.", { path: file, operation: "rewrite-launch-agent" }); } } const exec = options.execFileSync || execFileSync; const uid = typeof process.getuid === "function" ? process.getuid() : ""; let loaded = false; try { exec("launchctl", ["print", `gui/${uid}/com.softawarest.token-optimizer.env`], { encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024 }); loaded = true; } catch (_) {} if (exists && !loaded) add(findings, "LAUNCHCTL_MISMATCH", "warning", "The LaunchAgent plist exists but is not loaded.", "Reload the managed LaunchAgent.", { path: file, operation: "reload-launch-agent" }); const expected = Object.assign({}, ...registrations.map((item) => item.env || {})); for (const [key, expectedValue] of Object.entries(expected)) if (/^(?:TOKEN_OPTIMIZER_|LLM_GATEWAY_|LOCAL_LLM_|OPENROUTER_)/.test(key)) { let actual = null; try { actual = String(exec("launchctl", ["getenv", key], { encoding: "utf8", timeout: 1500, maxBuffer: 16 * 1024 })).trim(); } catch (_) {} if (actual !== String(expectedValue)) add(findings, "LAUNCHCTL_ENV_MISMATCH", "warning", `The GUI-session ${key} value differs from managed configuration.`, "Reload the managed LaunchAgent environment.", { path: file, operation: "reload-launch-agent" }); } return findings; }

function inspectLogState(home, options = {}) { const directory = path.resolve(options.workspace ? path.join(options.workspace, ".codex-local-test-runs") : options.logDirectory || path.join(home, ".codex-local-test-runs")); const quotaBytes = Number(options.logQuotaBytes || 500 * 1024 * 1024); let bytes = 0; let files = 0; let error = null; try { if (fs.existsSync(directory)) { const stat = fs.lstatSync(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) throw Object.assign(new Error("Workspace log directory must be a real directory."), { code: "LOG_PATH_UNSAFE" }); for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".log")) { files++; bytes += fs.statSync(path.join(directory, entry.name)).size; } } } catch (cause) { error = { code: cause.code === "LOG_PATH_UNSAFE" ? cause.code : "LOG_PATH_INACCESSIBLE", message: cause.message, remediation: "Restore a readable, non-symlink workspace log directory." }; } return { directory, workspace: options.workspace ? path.resolve(options.workspace) : null, exists: fs.existsSync(directory), files, bytes, quotaBytes, usagePercent: quotaBytes ? Math.round(bytes / quotaBytes * 10000) / 100 : 0, error };
}

/* Doctor checks the provider's authenticated metadata endpoint. It never sends
   a prompt or completion request, so liveness verification cannot consume model quota. */
function defaultHealthProbe({ url, mode, credential, timeoutMs = 2500 }) { const raw = String(url).replace(/\/+$/, ""); const withoutV1 = raw.replace(/\/v1$/, ""); const target = mode === "local" ? `${raw}/models` : mode === "openrouter-direct" ? `${raw}/auth/key` : mode === "gateway-byok" ? `${raw}/provider-health` : `${withoutV1}/health`; const transport = target.startsWith("https:") ? https : http; const headers = {}; if (credential) { const header = mode === "gateway-byok" ? "x-openrouter-key" : "authorization"; headers[header] = header === "authorization" ? `Bearer ${credential}` : credential; } return new Promise((resolve, reject) => { const request = transport.get(target, { timeout: timeoutMs, headers }, (response) => { response.resume(); resolve({ ok: response.statusCode >= 200 && response.statusCode < 400, statusCode: response.statusCode }); }); request.on("timeout", () => request.destroy(new Error("health probe timeout"))); request.on("error", reject); }); }

module.exports = { inspectInstallation, inspectProviderReference, inspectClients, inspectLogState, defaultHealthProbe };
