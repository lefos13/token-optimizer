const fs = require("fs");
const os = require("os");
const path = require("path");
const pkg = require("../package.json");
const http = require("http");
const https = require("https");

/* Read-only installation inspection is intentionally independent from the
   installer mutation paths. It gathers bounded metadata from known client
   locations and emits stable finding codes without ever returning secrets. */
async function inspectInstallation(options = {}) {
  const home = path.resolve(options.home || process.env.HOME || os.homedir());
  const expectedVersion = options.expectedVersion || pkg.version;
  const detectedVersion = options.detectedVersion || null;
  const provider = inspectProviderReference(home, options);
  const clients = inspectClients(home, options);
  const logs = inspectLogState(home, options);
  const effectiveProfile = options.effectiveProfile || options.profile || "standard";
  const findings = [];

  if (options.installedVersion && expectedVersion && options.installedVersion !== expectedVersion) {
    findings.push(finding("VERSION_MISMATCH", "warning", "Installed launcher version differs from the expected version.", `Reinstall or update the installer to ${expectedVersion}.`));
  }
  if (!provider.mode || provider.mode === "skip") {
    findings.push(finding("PROVIDER_MISSING", "error", "No LLM provider is configured.", "Run `token-optimizer config` or reinstall with a provider option."));
  } else if (provider.requiresCredential && !provider.credentialConfigured) {
    findings.push(finding("CREDENTIAL_MISSING", "error", "The configured provider has no usable credential reference.", "Configure the provider again and select a supported credential store."));
  }
  if (clients.configured.length === 0) {
    findings.push(finding("CLIENT_NOT_CONFIGURED", "warning", "No supported client installation was detected.", "Install for a client with `--clients <name>`."));
  }
  if (logs.bytes > logs.quotaBytes) {
    findings.push(finding("LOG_QUOTA_EXCEEDED", "warning", "Local run logs exceed the configured quota.", "Prune `.codex-local-test-runs` logs or increase the retention quota."));
  }
  if (options.performHealthProbe !== false && provider.url && ["gateway-token", "gateway-byok", "openrouter-direct"].includes(provider.mode)) {
    try {
      const probe = await (options.healthProbe || defaultHealthProbe)(provider.url, options.healthProbeTimeoutMs);
      if (probe === false || (probe && probe.ok === false)) findings.push(finding("PROVIDER_UNREACHABLE", "warning", "The configured provider endpoint did not respond successfully.", "Check the endpoint URL and network connectivity."));
    } catch (error) {
      findings.push(finding("PROVIDER_UNREACHABLE", "warning", "The configured provider endpoint could not be reached.", "Check the endpoint URL and network connectivity."));
    }
  }
  return {
    schemaVersion: 2,
    installedVersion: options.installedVersion || detectedVersion || expectedVersion,
    installedVersionSource: options.installedVersion ? "supplied" : detectedVersion ? "detected" : "assumed",
    detectedVersion,
    expectedVersion,
    healthy: findings.every((item) => item.severity !== "error"),
    effectiveProfile,
    provider,
    clients,
    logs,
    findings,
  };
}

function finding(code, severity, message, remediation, client) {
  const result = { code, severity, message, remediation };
  if (client) result.client = client;
  return result;
}

function inspectProviderReference(home, options) {
  const env = options.env || process.env;
  const mode = canonicalProvider(options.providerMode || options.provider || env.TOKEN_OPTIMIZER_PROVIDER_MODE || inferMode(env, home));
  const credentialRef = options.credentialRef || env.TOKEN_OPTIMIZER_CREDENTIAL_REF || null;
  const requiresCredential = ["gateway", "gateway-token", "gateway-byok", "openrouter-direct", "byok"].includes(String(mode));
  const configCredential = configContains(home, /(LLM_GATEWAY_TOKEN|OPENROUTER_BYOK_KEY|OPENROUTER_API_KEY|TOKEN_OPTIMIZER_CREDENTIAL_REF)/);
  const credentialConfigured = Boolean(nonBlank(credentialRef) || nonBlank(env.LLM_GATEWAY_TOKEN) || nonBlank(env.OPENROUTER_BYOK_KEY) || nonBlank(env.OPENROUTER_API_KEY) || configCredential);
  const url = options.providerUrl || env.LLM_GATEWAY_URL || env.LOCAL_LLM_API_URL || (requiresCredential ? "https://llm-proxy.lnf.gr/v1" : null);
  return {
    mode: mode || null,
    url: redactUrl(url),
    credentialStore: credentialRef && typeof credentialRef === "object" ? credentialRef.store || "unknown" : credentialRef ? "reference" : credentialConfigured ? "environment" : "none",
    credentialConfigured,
    credentialFingerprint: credentialRef && typeof credentialRef === "object" && credentialRef.fingerprint ? credentialRef.fingerprint : undefined,
    requiresCredential,
  };
}

function canonicalProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ({ gateway: "gateway-token", byok: "gateway-byok", direct: "openrouter-direct" })[normalized] || normalized || null;
}

function nonBlank(value) {
  if (value && typeof value === "object") return Boolean(value.fingerprint || value.store || value.service);
  const text = String(value || "").trim().toLowerCase();
  return Boolean(text && !["none", "null", "undefined", "placeholder", "changeme", "your-token", "your-key"].includes(text));
}

function configContains(home, pattern) {
  const candidates = [path.join(home, ".codex", "config.toml"), path.join(home, ".cursor", "mcp.json"), path.join(home, ".config", "opencode", "opencode.jsonc"), path.join(home, ".gemini", "config", "plugins", "token-optimizer", "config.json")];
  return candidates.some((file) => { try {
    const text = fs.readFileSync(file, "utf8");
    /* Installer-managed JSON can encode a credential reference as an escaped
       JSON string. Match the named key and reject only empty/placeholder
       assignments instead of assuming the value contains no quote. */
    return text.split(/\r?\n/).some((line) => {
      if (!pattern.test(line)) return false;
      const assignment = line.slice(Math.max(line.indexOf(":"), line.indexOf("=")) + 1).trim();
      return Boolean(assignment) && !/^["']?(?:["']|none|null|undefined|placeholder|changeme|your-token|your-key)(?:["']|\s|[,}\]])/i.test(assignment);
    });
  } catch (_) { return false; } });
}

function redactUrl(value) {
  if (!value) return null;
  try { const parsed = new URL(String(value)); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; return parsed.toString().replace(/\/$/, ""); } catch (_) { return String(value).replace(/\?.*$/, ""); }
}

function defaultHealthProbe(url, timeoutMs = 2500) {
  const base = String(url).replace(/\/+$/, "").replace(/\/v1$/, "");
  const target = `${base}/health`;
  const transport = target.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(target, { timeout: timeoutMs }, (response) => { response.resume(); resolve({ ok: response.statusCode >= 200 && response.statusCode < 400 }); });
    request.on("timeout", () => request.destroy(new Error("health probe timeout")));
    request.on("error", reject);
  });
}

function inferMode(env, home) {
  if (env.LOCAL_LLM_API_URL) return "local";
  if (env.LLM_GATEWAY_TOKEN) return "gateway-token";
  if (env.OPENROUTER_BYOK_KEY) return "gateway-byok";
  if (env.OPENROUTER_API_KEY) return "openrouter-direct";
  const candidates = [path.join(home, ".codex", "config.toml"), path.join(home, ".cursor", "mcp.json"), path.join(home, ".config", "opencode", "opencode.jsonc")];
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/TOKEN_OPTIMIZER_PROVIDER_MODE\s*[=:]\s*["']?([A-Za-z-]+)/);
      if (match) return match[1];
    } catch (_) { /* absent client config */ }
  }
  return null;
}

function inspectClients(home, options = {}) {
  const roots = {
    claude: path.join(home, ".claude"), codex: path.join(home, ".codex"),
    antigravity: path.join(home, ".gemini"), opencode: path.join(home, ".config", "opencode"), cursor: path.join(home, ".cursor"),
  };
  const configured = Object.keys(roots).filter((name) => fs.existsSync(roots[name]));
  return { supported: Object.keys(roots), configured, paths: options.includePaths ? Object.fromEntries(configured.map((name) => [name, roots[name]])) : undefined };
}

function inspectLogState(home, options = {}) {
  const directory = path.resolve(options.logDirectory || path.join(home, ".codex-local-test-runs"));
  const quotaBytes = Number(options.logQuotaBytes || 500 * 1024 * 1024);
  let bytes = 0; let files = 0;
  const walk = (dir) => { let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; } for (const entry of entries) { const item = path.join(dir, entry.name); if (entry.isDirectory()) walk(item); else { files += 1; try { bytes += fs.statSync(item).size; } catch (_) {} } } };
  walk(directory);
  return { directory, exists: fs.existsSync(directory), files, bytes, quotaBytes, usagePercent: quotaBytes ? Math.round((bytes / quotaBytes) * 10000) / 100 : 0 };
}

module.exports = { inspectInstallation, inspectProviderReference, inspectClients, inspectLogState, defaultHealthProbe };
