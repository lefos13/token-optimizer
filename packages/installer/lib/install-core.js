const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";
const DEFAULT_LOCAL_LLM_URL = "http://localhost:8080/v1";
const DEFAULT_LOCAL_LLM_MODEL = "local-model";
/* Every env key installers may write into a client's MCP config. A provider
   mode (gateway / byok / local / skip) always yields a full values object
   across all of these keys so registering the MCP server never requires
   picking a provider, and switching providers later cleanly clears whatever
   the previous choice left behind. */
const MANAGED_ENV_KEYS = [
  "LLM_GATEWAY_URL",
  "LLM_GATEWAY_TOKEN",
  "OPENROUTER_BYOK_KEY",
  "LOCAL_LLM_API_URL",
  "LOCAL_LLM_MODEL",
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
  const provider = normalizeProviderChoice(options.provider) || inferProvider(options);
  const values = emptyManagedValues();
  if (provider === "gateway") {
    if (!options.gatewayToken) {
      throw new Error("gatewayToken is required for provider 'gateway'");
    }
    values.LLM_GATEWAY_URL = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    values.LLM_GATEWAY_TOKEN = options.gatewayToken;
  } else if (provider === "byok") {
    if (!options.byokKey) {
      throw new Error("byokKey is required for provider 'byok'");
    }
    values.LLM_GATEWAY_URL = options.gatewayUrl || DEFAULT_GATEWAY_URL;
    values.OPENROUTER_BYOK_KEY = options.byokKey;
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
  return ["gateway", "byok", "local", "skip"].includes(normalized) ? normalized : null;
}

/* Callers that don't pass an explicit provider get one inferred from which
   values they supplied, so existing gatewayToken-only call sites keep working. */
function inferProvider(options) {
  if (options.byokKey) return "byok";
  if (options.gatewayToken) return "gateway";
  if (options.localApiUrl || options.localModel) return "local";
  return "skip";
}
const CLAUDE_MARKETPLACE_NAME = "token-optimizer-marketplace";
const CODEX_MARKETPLACE_NAME = "Softaware-marketplace";
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

function installSelectedClients(options) {
  const paths = installerPaths(options);
  const clients = normalizeClients(options.clients, paths.home);
  const installed = [];
  for (const client of clients) {
    if (client === "opencode") {
      installOpenCode({ ...options, ...paths });
      installed.push(client);
    } else if (client === "cursor") {
      installCursor({ ...options, ...paths });
      installed.push(client);
    } else if (client === "antigravity") {
      installAntigravity({ ...options, ...paths });
      installed.push(client);
    } else if (client === "claude") {
      installClaude({ ...options, ...paths });
      installed.push(client);
    } else if (client === "codex") {
      installCodex({ ...options, ...paths });
      installed.push(client);
    } else {
      throw new Error(`Unsupported client: ${client}`);
    }
  }
  return installed;
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
  const pluginInstalled = marketplaceAdded
    && tryClientCommand("claude", ["plugin", "install", `token-optimizer@${CLAUDE_MARKETPLACE_NAME}`], options);
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
  /* Try the CLI route first. When the codex CLI is unavailable (desktop-app
     installs, common on Windows), fall back to registering the bundled server
     directly in ~/.codex/config.toml and copying the skill into
     ~/.codex/skills/, which Codex reads without any plugin machinery. */
  const marketplaceAdded = tryClientCommand("codex", ["plugin", "marketplace", "add", options.installRoot], options);
  const pluginInstalled = marketplaceAdded
    && tryClientCommand("codex", ["plugin", "add", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options);
  if (!pluginInstalled) {
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
  }
  applyGatewayConfig({ ...options, clients: ["codex"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["codex"] });
  }
}

function applyGatewayConfig(options) {
  const paths = installerPaths(options);
  const values = buildProviderValues(options);
  for (const target of getGatewayTargets(paths.home)) {
    if (!target.matches(options.clients)) {
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
  for (const envKey of MANAGED_ENV_KEYS) {
    if (values[envKey]) {
      runLaunchctl(["setenv", envKey, values[envKey]], options);
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
  emptyManagedValues,
  buildProviderValues,
  normalizeProviderChoice,
  DIRECTIVE_MARKER_START,
  installerPaths,
  detectClients,
  installSelectedClients,
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
};
