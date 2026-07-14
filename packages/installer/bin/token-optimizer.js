#!/usr/bin/env node

const readline = require("readline");
const https = require("https");
const { spawnSync } = require("child_process");
const pkg = require("../package.json");
const {
  DEFAULT_GATEWAY_URL,
  DEFAULT_LOCAL_LLM_URL,
  DEFAULT_LOCAL_LLM_MODEL,
  DEFAULT_OPENROUTER_URL,
  normalizeProviderChoice,
  planInstallation,
  applyChangePlan,
  formatChangePlan,
  installSelectedClients,
  persistInstallManifest,
  applyGatewayConfig,
  prepareCredentialOptions,
  applyProviderConfiguration,
  persistProviderCredentialOwnership,
  applyDefaultDirectives,
} = require("../lib/install-core");
const { inspectInstallation, defaultHealthProbe } = require("../lib/doctor");
const { readManifest, writeManifest, manifestPath } = require("../lib/manifest");
const { planRepair, planUninstall, currentStateFromManifest, applyLifecyclePlan, hasRecognizedUninstallState } = require("../lib/uninstall");
const { statusLogs, pruneLogs, purgeLogs } = require("../lib/logs");
const { planMigrationFromHome, migrateInstallation } = require("../lib/migration");
const { createRegistrationAdapter, createFilesystemMarketplaceAdapter, createServiceAdapter } = require("../lib/lifecycle-adapters");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "install";

  if (args.help || command === "help") {
    printHelp();
    return;
  }

  if (command === "status" || command === "doctor") {
    if (args.workspace && !require("path").isAbsolute(args.workspace)) throw new Error("status/doctor --workspace requires an absolute path");
    const report = await inspectInstallation({
      home: args.home,
      installedVersion: args["installed-version"],
      expectedVersion: args["expected-version"] || pkg.version,
      provider: args.provider,
      profile: args.profile,
      workspace: args.workspace,
      logDirectory: args["log-directory"],
      performHealthProbe: command === "doctor",
    });
    if (args.json === true) console.log(JSON.stringify(report, null, 2));
    else printInspection(report, command);
    const errors = report.findings.some((item) => item.severity === "error");
    const warnings = report.findings.some((item) => item.severity === "warning");
    process.exitCode = errors ? 1 : warnings && args.strict === true ? 2 : 0;
    return;
  }

  if (command === "logs") {
    const workspace = args.workspace;
    if (!workspace || !require("path").isAbsolute(workspace)) throw new Error("logs commands require --workspace <absolute-path>");
    const action = args._[1] || "status";
    const operation = action === "status" ? statusLogs(workspace) : action === "prune" ? pruneLogs(workspace) : action === "purge" ? purgeLogs(workspace, { includeBaseline: args["include-baseline"] === true, includeAnalytics: args["include-analytics"] === true }) : null;
    if (!operation) throw new Error(`Unsupported logs command: ${action}`);
    const report = await operation;
    console.log(args.json === true ? JSON.stringify(report, null, 2) : `${action}: ${report.removed.length} removed, ${report.freedBytes} bytes freed`);
    return;
  }

  if (command === "repair" || command === "uninstall") {
    const home = args.home;
    let manifest = readManifest(home);
    let reconstructedUninstall = false;
    if (!manifest) {
      if (command === "uninstall" && !hasRecognizedUninstallState(home || process.env.HOME)) { console.log(args.json === true ? JSON.stringify({ status: "already-uninstalled", operations: [] }, null, 2) : "uninstall: already clean; no changes applied."); return; }
      if (command === "uninstall") { manifest = { schemaVersion: 3, roots: [], files: [], managedBlocks: [], credentials: [], registrations: [], platformServices: [] }; reconstructedUninstall = true; }
      else throw new Error("No Token Optimizer ownership manifest found");
    }
    const report = command === "repair" ? await inspectInstallation({ home, performHealthProbe: false }) : null;
    const assetsRoot = require("path").resolve(__dirname, "..", "assets");
    const managedRoots = [require("path").join(home || process.env.HOME, ".token-optimizer"), require("path").join(home || process.env.HOME, ".config", "opencode"), require("path").join(home || process.env.HOME, ".cursor"), require("path").join(home || process.env.HOME, ".gemini"), require("path").join(home || process.env.HOME, ".claude"), require("path").join(home || process.env.HOME, ".codex")];
    const plan = command === "repair" ? planRepair(report, manifest, { assetsRoot, managedRoots, manifestPath: manifestPath(home) }) : planUninstall(manifest, currentStateFromManifest(manifest), { home: home || process.env.HOME, manifestPath: reconstructedUninstall ? undefined : manifestPath(home) });
    if (args["dry-run"] === true) {
      console.log(args.json === true ? formatChangePlan(plan, "json") : formatChangePlan(plan));
      return;
    }
    const applied = applyLifecyclePlan(plan, { onProgress: createProgressReporter(args), requireExternalAdapters: true, registrationAdapter: createRegistrationAdapter({ marketplaceAdapter: createFilesystemMarketplaceAdapter(home || process.env.HOME) }), serviceAdapter: createServiceAdapter({ home: home || process.env.HOME, services: manifest.platformServices || [], skipLaunchctl: args["skip-launchctl"] === true }), manifest, home, planWarnings: plan.warnings || [] });
    console.log(args.json === true ? JSON.stringify({ action: command, previousVersion: pkg.version, installedVersion: command === "repair" ? pkg.version : null, status: "completed", clients: [...new Set(applied.map((operation) => operation.client).filter(Boolean))], operations: applied, applied, removedStale: applied.filter((operation) => operation.kind === "remove-file" || /normalize|remove/.test(operation.command || "")), preserved: plan.warnings || [], warnings: plan.warnings || [], rollback: { applied: false, operations: [] }, doctorSummary: null }, null, 2) : `${command}: applied ${plan.operations.length} operation(s).`);
    return;
  }

  if (!["install", "config", "defaults"].includes(command)) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: args.json === true ? process.stderr : process.stdout });
  try {
    await checkForUpdate(rl, args);
    const clients = parseList(args.clients || args.client || "detected");
    if (command === "install" && args.migrate === true) {
      const explicitProvider = args.provider !== undefined || args.local === true || args.token !== undefined || args["byok-key"] !== undefined;
      const providerOptions = explicitProvider ? await resolveProviderOptions(args, rl) : {};
      const migrationOptions = {
        home: args.home,
        clients,
        ...providerOptions,
        credentialStore: normalizeCredentialStore(args["credential-store"]),
        cursorProjects: parseList(args["cursor-project"] || args.cursorProject || ""),
        skipClientCommands: true,
        skipLaunchctl: true,
        onProgress: createProgressReporter(args),
      };
      if (args["dry-run"] === true) {
        const plan = planMigrationFromHome(migrationOptions);
        console.log(args.json === true ? formatChangePlan(plan, "json") : formatChangePlan(plan));
        return;
      }
      const result = await migrateInstallation(migrationOptions);
      if (args.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.status === "already-migrated" ? "Migration already complete; no changes applied." : `Migrated Token Optimizer for: ${result.plan.clients.join(", ")}`);
      if (result.status !== "already-migrated") console.log("Follow-up: restart clients; run a normal install to perform client plugin registration and macOS GUI-session service setup, then `doctor`/`repair` to clear any leftover legacy registration.");
      return;
    }
    const existing = command === "install" ? await inspectInstallation({ home: args.home, performHealthProbe: false }) : null;
    const explicitProvider = args.provider !== undefined || args.local === true || args.token !== undefined || args["byok-key"] !== undefined;
    const providerOptions = command === "install" && !explicitProvider && shouldPreserveInstalledProvider(existing)
      ? preservedProviderOptions(existing.provider)
      : await resolveProviderOptions(args, rl);
    const providerWarnings = args["dry-run"] === true ? [] : await validateProviderBeforeMutation({ ...providerOptions, home: args.home });
    const defaults = args.defaults !== "false" && args["no-defaults"] !== true;
    const options = {
      home: args.home,
      clients,
      ...providerOptions,
      defaults,
      cursorProjects: parseList(args["cursor-project"] || args.cursorProject || ""),
      skipClientCommands: args["skip-client-commands"] === true,
      skipLaunchctl: args["skip-launchctl"] === true,
    };

    if (command === "install") {
      if (args["dry-run"] === true) {
        const plan = planInstallation(options);
        console.log(args.json === true ? formatChangePlan(plan, "json") : formatChangePlan(plan));
        return;
      }
      const previous = existing || await inspectInstallation({ home: options.home, performHealthProbe: false });
      const plan = planInstallation(options);
      const applyResult = applyChangePlan(plan, { onProgress: createProgressReporter(args) });
      if (applyResult.error) {
        const rolled = applyResult.rolledBack.length;
        const manual = applyResult.manualRemediation.length;
        console.error(`Installation failed: ${applyResult.error.message}`);
        console.error(`Rollback applied to ${rolled} operation(s); manual remediation required for ${manual}.`);
        process.exitCode = 1;
        return;
      }
      persistInstallManifest({ ...options, credentialRef: applyResult.credentialRef, credentialOwned: applyResult.credentialOwned, credentialOwnershipCleared: applyResult.credentialOwnershipCleared }, applyResult.installedClients);
      const installed = applyResult.installedClients;
      const doctor = await inspectInstallation({ home: options.home, expectedVersion: pkg.version, performHealthProbe: false });
      const cleanupResults = applyResult.operationResults || [];
      const removedStale = cleanupResults.flatMap((result) => result.removedStale || []);
      const preserved = cleanupResults.flatMap((result) => result.preserved || []);
      if (args.json === true) {
        console.log(JSON.stringify({
          action: "install", previousVersion: previous.installedVersion, installedVersion: pkg.version,
          status: "completed", clients: installed, applied: applyResult.applied,
          removedStale,
          preserved, warnings: [...providerWarnings, ...preserved, ...doctor.findings.filter((finding) => finding.severity === "warning")],
          rollback: { applied: false, operations: [] },
          doctorSummary: { healthy: doctor.healthy, findings: doctor.findings.map((finding) => finding.code) },
        }, null, 2));
        return;
      }
      console.log(`Installed Token Optimizer for: ${installed.join(", ")}`);
      for (const warning of providerWarnings) console.warn(`Warning: ${warning.message}`);
      if (clients.includes("all") || clients.includes("cursor")) {
        console.log("Cursor MCP is configured globally; copy the generated Cursor rule into projects or pass --cursor-project for project rules.");
      }
      if (options.provider === "local") {
        console.log(`No token used. Point an OpenAI-compatible endpoint at ${options.localApiUrl || DEFAULT_LOCAL_LLM_URL} before using the tools.`);
      } else if (options.provider === "byok") {
        console.log("No proxy token used: calls are billed to your own OpenRouter account, unlimited.");
      } else if (options.provider === "skip") {
        console.log("No provider configured yet. Run `token-optimizer config` later to add a provider.");
      }
      console.log("Restart or reload each client so it picks up the MCP server and skill.");
      return;
    }

    if (command === "config") {
      const result = applyProviderConfiguration(options);
      persistProviderCredentialOwnership(options, result);
      console.log("Provider configuration written.");
      return;
    }

    if (command === "defaults") {
      applyDefaultDirectives(options);
      console.log("Default-on instructions written.");
    }
  } finally {
    rl.close();
  }
}

function preservedProviderOptions(provider) {
  const options = { provider: provider.mode, credentialRef: provider.credentialReference };
  if (provider.mode === "local") { options.localApiUrl = provider.url; options.localModel = provider.model; }
  else if (provider.mode === "openrouter-direct") { options.openrouterUrl = provider.url; options.byokModel = provider.model; }
  else { options.gatewayUrl = provider.url; if (provider.mode === "gateway-byok") options.byokModel = provider.model; }
  return options;
}

/* Automatic preservation is an upgrade behavior, not fresh-install discovery.
   Ambient legacy variables cannot prove that a client has a usable installation. */
function shouldPreserveInstalledProvider(report) {
  if (!report?.provider?.mode || report.provider.mode === "skip") return false;
  if (report.provider.source !== "registration") return false;
  const active = (report.clients?.registrations || []).some((registration) => registration.stale !== true);
  if (!active) return false;
  return !report.provider.requiresCredential || report.provider.credentialConfigured === true;
}

/* Authentication rejection is deterministic and blocks mutation. Transport
   failures are advisory so a temporary outage cannot strand a valid upgrade. */
async function validateProviderBeforeMutation(options) {
  const mode = normalizeProviderChoice(options.provider);
  if (!mode || !["gateway-token", "gateway-byok", "openrouter-direct"].includes(mode)) return [];
  let credential = options.gatewayToken || options.byokKey || options.openrouterKey;
  if (!credential && options.credentialRef) {
    const report = await inspectInstallation({ provider: mode, credentialRef: options.credentialRef, providerUrl: options.gatewayUrl || options.openrouterUrl, performHealthProbe: false });
    if (report.provider.credentialConfigured) {
      const kind = options.credentialRef.store === "config" || options.credentialRef.store === "protected-config"
        ? "config"
        : options.credentialRef.store === "env" ? "env" : "native";
      const store = require("../lib/credential-store").createCredentialStore(kind, { home: options.home, service: options.credentialRef.service, account: options.credentialRef.account, path: options.credentialRef.path, envVar: options.credentialRef.variable });
      credential = store.get(options.credentialRef);
    }
  }
  try {
    const url = mode === "openrouter-direct" ? (options.openrouterUrl || DEFAULT_OPENROUTER_URL) : (options.gatewayUrl || DEFAULT_GATEWAY_URL);
    const probe = await defaultHealthProbe({ url, mode, credential });
    if (probe.statusCode === 401 || probe.statusCode === 403) throw new Error("Provider rejected the configured credential.");
    if (!probe.ok) return [{ code: "PROVIDER_UNREACHABLE", severity: "warning", message: "Provider validation was unavailable; the structurally valid installation was retained." }];
  } catch (error) {
    if (/rejected the configured credential/i.test(error.message)) throw error;
    return [{ code: "PROVIDER_UNREACHABLE", severity: "warning", message: "Provider validation was unavailable; the structurally valid installation was retained." }];
  }
  return [];
}

/* Human progress follows the sanitized plan on interactive terminals. JSON
   mode reserves stdout for one document and optionally streams NDJSON to stderr. */
function createProgressReporter(args = {}) {
  if (args.quiet === true) return () => {};
  if (args.json === true) return args.verbose === true ? (event) => process.stderr.write(`${JSON.stringify(event)}\n`) : () => {};
  if (args.verbose !== true && !process.stdout.isTTY) return () => {};
  return (event) => {
    if (event.event === "operation-start") console.log(`[${event.sequence}/${event.total}] ${event.phase}: ${event.operationId}`);
    else if (event.event === "operation-complete") console.log(`  ✓ ${event.operationId}`);
    else if (event.event === "operation-rolled-back") console.log(`  ↩ ${event.operationId}`);
    else if (event.event === "complete") console.log(event.status === "completed" ? "Installation steps complete." : "Installation steps failed.");
  };
}

/* Resolves which LLM provider to configure from flags first (for scripted/CI
   use), falling back to an interactive menu only when nothing on the command
   line already decided it.
   - "gateway" needs a token (shared infrastructure, daily-limited).
   - "byok" needs ONLY your own OpenRouter key — no proxy token is asked for
     or written, because a BYOK caller doesn't use the operator's OpenRouter
     setup at all.
   - "local" needs nothing (your own endpoint, no gateway involved).
   - "skip" installs the MCP server with no provider configured at all, to be
     finished later with `token-optimizer config`. */
async function resolveProviderOptions(args, rl) {
  const credentialStore = normalizeCredentialStore(args["credential-store"]);
  const explicit = normalizeProviderChoice(args.provider);
  if (args.provider !== undefined && !explicit) {
    throw new Error(`Unsupported provider mode: ${args.provider}. Choose local, gateway-token, gateway-byok, openrouter-direct, or skip.`);
  }
  if (explicit === "skip") {
    return { provider: "skip" };
  }
  if (explicit === "local" || args.local === true) {
    return {
      provider: "local",
      localApiUrl: args["local-url"] || args.localUrl || "",
      localModel: args["local-model"] || args.localModel || "",
    };
  }
  const byokKeyFlag = args["byok-key"] || args.byokKey;
  if (explicit === "gateway-byok" || explicit === "openrouter-direct" || byokKeyFlag) {
    const byokKey = byokKeyFlag || await askSecretRequired(rl, "Your OpenRouter API key (sk-or-...): ");
    const modelFlag = args["byok-model"] ?? args.byokModel;
    const byokModel = modelFlag !== undefined
      ? String(modelFlag).trim()
      : byokKeyFlag
        ? ""
        : await askOptional(rl, explicit === "gateway-byok" ? "OpenRouter model ID (optional; Enter for gateway default): " : "OpenRouter model ID (optional; Enter for OpenRouter default): ");
    const provider = explicit === "gateway-byok" ? "gateway-byok" : "openrouter-direct";
    return {
      provider,
      credentialStore,
      ...(provider === "gateway-byok" ? { gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL } : { openrouterUrl: args["openrouter-url"] || args.openrouterUrl || DEFAULT_OPENROUTER_URL }),
      byokKey,
      byokModel,
    };
  }
  if (explicit === "gateway-token" || args.token) {
    const gatewayToken = args.token || process.env.LLM_GATEWAY_TOKEN || await askSecretRequired(rl, "Gateway access token: ");
    return {
      provider: args.provider === "gateway" ? "gateway" : "gateway-token",
      credentialStore,
      gatewayToken,
      gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    };
  }
  return promptForProviderInteractive({ ...args, credentialStore }, rl);
}

function normalizeCredentialStore(value) {
  const kind = value === undefined ? "native" : String(value).trim().toLowerCase();
  if (!["native", "env", "config"].includes(kind)) throw new Error(`Unsupported credential store: ${value}. Choose native, env, or config.`);
  return kind;
}

async function promptForProviderInteractive(args, rl) {
  writePromptLine(rl, "How should the LLM provider be configured?");
  writePromptLine(rl, "  1. Gateway access token - shared infrastructure, requires an approved token, 20 calls/day by default");
  writePromptLine(rl, "  2. Your own OpenRouter key - unlimited usage, billed to your account, NO token needed at all");
  writePromptLine(rl, "  3. Local LLM only - your own OpenAI-compatible endpoint, no token, nothing leaves your machine");
  writePromptLine(rl, "  4. Skip for now (configure later with `token-optimizer config`)");
  const answer = (await ask(rl, "Choice [1-4]: ")).trim();

  if (answer === "2") {
    const byokKey = await askSecretRequired(rl, "Your OpenRouter API key (sk-or-...): ");
    const byokModel = await askOptional(rl, "OpenRouter model ID (optional; Enter for OpenRouter default): ");
    writePromptLine(rl, "No proxy token needed: calls are billed to your OpenRouter account, unlimited.");
    return {
      provider: "openrouter-direct",
      openrouterUrl: args["openrouter-url"] || args.openrouterUrl || DEFAULT_OPENROUTER_URL,
      gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
      byokKey,
      credentialStore: args.credentialStore || "native",
      byokModel,
    };
  }
  if (answer === "3") {
    const localApiUrl = (await ask(rl, `Local LLM endpoint [${DEFAULT_LOCAL_LLM_URL}]: `)).trim() || DEFAULT_LOCAL_LLM_URL;
    const localModel = (await ask(rl, `Local LLM model name [${DEFAULT_LOCAL_LLM_MODEL}]: `)).trim() || DEFAULT_LOCAL_LLM_MODEL;
    writePromptLine(rl, "No token needed. Make sure an OpenAI-compatible endpoint is running and reachable at that URL.");
    return { provider: "local", localApiUrl, localModel };
  }
  if (answer === "4") {
    return { provider: "skip" };
  }
  const gatewayToken = await askSecretRequired(rl, "Gateway access token: ");
  return { provider: "gateway", gatewayToken, credentialStore: args.credentialStore || "native", gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL };
}

/* Checks npm for a newer installer version and, when the session is
   interactive, offers to re-run the latest release before proceeding.
   npx can serve a cached build, so an up-to-date install is not guaranteed
   without this check. The check is best-effort: any network/registry error,
   a non-TTY session, or `--skip-update-check` skips it silently and lets the
   current version run. Choosing to update re-execs `npx <name>@latest` with
   the original arguments and exits with that process's status. */
async function checkForUpdate(rl, args) {
  if (args["skip-update-check"] === true || process.env.TOKEN_OPTIMIZER_SKIP_UPDATE_CHECK === "1") {
    return;
  }
  const current = pkg.version;
  const latest = await fetchLatestVersion(pkg.name).catch(() => null);
  if (!latest || compareVersions(latest, current) <= 0) {
    return;
  }
  console.log(`A newer Token Optimizer installer is available: ${latest} (you have ${current}).`);
  if (!process.stdin.isTTY) {
    console.log(`Run \`npx --yes ${pkg.name}@latest\` to update. Continuing with ${current}.`);
    return;
  }
  const answer = (await ask(rl, "Update to the latest version now? [Y/n]: ")).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    console.log(`Continuing with ${current}.`);
    return;
  }
  console.log(`Updating to ${pkg.name}@${latest}...`);
  rl.close();
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(npx, ["--yes", `${pkg.name}@latest`, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(result.status === null ? 1 : result.status);
}

/* Fetches the `latest` dist-tag manifest from the npm registry and returns its
   version string, or null on any non-200/parse/network failure. */
function fetchLatestVersion(name) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    const request = https.get(url, { timeout: 4000 }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`registry status ${response.statusCode}`));
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body).version || null);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("registry timeout")));
    request.on("error", reject);
  });
}

/* Numeric semver comparison of the major.minor.patch core, ignoring any
   prerelease/build suffix. Returns 1 if a > b, -1 if a < b, 0 if equal. */
function compareVersions(a, b) {
  const parse = (value) => String(value).split("-")[0].split(".").map((part) => parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      out[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function parseList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function writePromptLine(rl, message) {
  (rl?.output || process.stdout).write(`${message}\n`);
}

async function askRequired(rl, prompt) {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) {
      return answer;
    }
    writePromptLine(rl, "This value is required.");
  }
}

/* TTY credential entry suppresses readline echo while preserving injectable
   non-terminal readers used by automation and tests. */
async function askSecretRequired(rl, prompt) {
  if (!rl?.output || typeof rl._writeToOutput !== "function") return askRequired(rl, prompt);
  while (true) {
    const original = rl._writeToOutput;
    let promptPending = true;
    rl._writeToOutput = (value) => {
      if (!promptPending) return;
      promptPending = false;
      original.call(rl, value);
    };
    let answer;
    try { answer = await ask(rl, prompt); }
    finally { rl._writeToOutput = original; rl.output.write("\n"); }
    if (answer.trim()) return answer.trim();
    writePromptLine(rl, "This value is required.");
  }
}

async function askOptional(rl, prompt) {
  return (await ask(rl, prompt)).trim();
}

function printHelp() {
  console.log(`Usage:
  npx @softawarest/token-optimizer-installer [install] [options]
  token-optimizer install --clients opencode,cursor
  token-optimizer install --dry-run [--json] [--verbose|--quiet]
  token-optimizer install --migrate [--dry-run --json]
  token-optimizer install --local
  token-optimizer config --token <token>
  token-optimizer defaults --clients claude,codex,opencode
  token-optimizer status [--json] [--strict] [--workspace <absolute-path>]
  token-optimizer doctor [--json] [--strict] [--workspace <absolute-path>]
  token-optimizer repair [--home <path>] [--dry-run] [--verbose|--quiet]
  token-optimizer uninstall [--home <path>] [--dry-run] [--verbose|--quiet]
  token-optimizer uninstall --dry-run
  token-optimizer logs status|prune|purge --workspace <absolute-path>

No token is required to use this tool. With no provider flags, the installer
prompts for one of three providers, plus a skip option:

  gateway  Shared infrastructure. Requires an approved gateway access token
           (request one, then get approved). Limited to 20 calls/day by
           default (operator-adjustable).
  byok     Your own OpenRouter key. NO gateway token is used or needed at
           all — you are not using the operator's OpenRouter setup, so the
           gateway does not authenticate you, only proxies the request.
           Unlimited usage; billed to your own account.
  local    Your own OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama,
           etc.). No token, no gateway involved, nothing leaves your machine.
  skip     Install the MCP server with no provider configured; finish later
           with \`token-optimizer config\`.

Options:
  --provider <mode>            gateway, byok (direct OpenRouter), local, or skip. Overrides prompting.
  --migrate                    Detect v1 state, back it up privately, and migrate transactionally.
  --credential-store <kind>    native (default), env, or config. env/config are explicit plaintext opt-ins.
  --token <token>               Gateway access token. Defaults to LLM_GATEWAY_TOKEN. Implies --provider gateway.
  --url <url>                  Gateway URL. Defaults to ${DEFAULT_GATEWAY_URL}. Used by both gateway and byok modes.
  --byok-key <key>              Your own OpenRouter API key (sk-or-...). Implies --provider byok. No --token needed.
  --byok-model <model-id>       Optional OpenRouter model ID for every task. Defaults to the gateway-selected model.
  --local                      Use a local LLM only; no token required. Implies --provider local.
  --local-url <url>             Local OpenAI-compatible endpoint. Defaults to ${DEFAULT_LOCAL_LLM_URL}.
  --local-model <name>          Local model name. Defaults to ${DEFAULT_LOCAL_LLM_MODEL}.
  --clients <list>             detected, all, claude, codex, antigravity, opencode, cursor.
  --cursor-project <path>      Copy Cursor default-on rule into a project.
  --no-defaults                Skip global default-on instruction writes.
  --skip-client-commands       Do not invoke external client CLIs; launcher runtime validation still runs.
  --skip-launchctl             Do not write macOS GUI-session provider env values.
  --skip-update-check          Do not check npm for a newer installer version.
`);
}

function printInspection(report, command) {
  console.log(`${command === "doctor" ? "Doctor" : "Status"}: ${report.healthy ? "healthy" : "unhealthy"}`);
  console.log(`Provider: ${report.provider.mode || "none"} (${report.provider.credentialStore})`);
  console.log(`Clients: ${report.clients.configured.join(", ") || "none"}`);
  console.log(`Profile: ${report.effectiveProfile}`);
  console.log(`Logs: ${report.logs.files} file(s), ${report.logs.bytes} bytes (${report.logs.usagePercent}% of quota)`);
  for (const item of report.findings) console.log(`[${item.severity}] ${item.code}: ${item.message}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Token Optimizer installer failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  resolveProviderOptions,
  promptForProviderInteractive,
  parseArgs,
  createProgressReporter,
  preservedProviderOptions,
  shouldPreserveInstalledProvider,
  validateProviderBeforeMutation,
  checkForUpdate,
  fetchLatestVersion,
  compareVersions,
  printInspection,
  askSecretRequired,
  main,
};
