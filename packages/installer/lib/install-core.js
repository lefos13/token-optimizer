const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";
const GATEWAY_ENV_KEYS = ["LLM_GATEWAY_URL", "LLM_GATEWAY_TOKEN"];
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
  tryClientCommand("claude", ["plugin", "marketplace", "add", options.installRoot], options);
  tryClientCommand("claude", ["plugin", "install", "token-optimizer@token-optimizer-marketplace"], options);
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
  tryClientCommand("codex", ["plugin", "marketplace", "add", options.installRoot], options);
  applyGatewayConfig({ ...options, clients: ["codex"] });
  if (options.defaults !== false) {
    applyDefaultDirectives({ ...options, clients: ["codex"] });
  }
}

function applyGatewayConfig(options) {
  const paths = installerPaths(options);
  const values = {
    LLM_GATEWAY_URL: options.gatewayUrl || DEFAULT_GATEWAY_URL,
    LLM_GATEWAY_TOKEN: options.gatewayToken || "",
  };
  if (!values.LLM_GATEWAY_TOKEN) {
    throw new Error("gatewayToken is required");
  }
  for (const target of getGatewayTargets(paths.home)) {
    if (!target.matches(options.clients)) {
      continue;
    }
    const config = safeReadConfig(target);
    writeConfigTarget(target, target.applyValues(config, values), paths.backupRoot);
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
  const localTesterServerArgs = [path.join(home, ".gemini", "config", "plugins", "token-optimizer", "server", "start.sh")];
  const opencodeServerCommand = ["bash", path.join(home, ".config", "opencode", "token-optimizer-server", "start.sh")];
  const cursorServerArgs = [path.join(home, ".cursor", "token-optimizer-server", "start.sh")];
  return [
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
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || { command: "bash", args: localTesterServerArgs };
        next.mcpServers.token_optimizer.command = next.mcpServers.token_optimizer.command || "bash";
        next.mcpServers.token_optimizer.args = Array.isArray(next.mcpServers.token_optimizer.args) && next.mcpServers.token_optimizer.args.length > 0
          ? next.mcpServers.token_optimizer.args : localTesterServerArgs;
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
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || { command: "bash", args: localTesterServerArgs };
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
        next.mcp.token_optimizer = next.mcp.token_optimizer || { type: "local", command: opencodeServerCommand, enabled: true };
        next.mcp.token_optimizer.type = next.mcp.token_optimizer.type || "local";
        next.mcp.token_optimizer.command = Array.isArray(next.mcp.token_optimizer.command) && next.mcp.token_optimizer.command.length > 0
          ? next.mcp.token_optimizer.command : opencodeServerCommand;
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
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || { command: "bash", args: cursorServerArgs };
        next.mcpServers.token_optimizer.command = next.mcpServers.token_optimizer.command || "bash";
        next.mcpServers.token_optimizer.args = Array.isArray(next.mcpServers.token_optimizer.args) && next.mcpServers.token_optimizer.args.length > 0
          ? next.mcpServers.token_optimizer.args : cursorServerArgs;
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
  for (const envKey of GATEWAY_ENV_KEYS) {
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
  for (const envKey of GATEWAY_ENV_KEYS) {
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

function tryClientCommand(command, args, options) {
  if (options.skipClientCommands) {
    return false;
  }
  try {
    execFileSync(command, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function commandExists(command) {
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
};
