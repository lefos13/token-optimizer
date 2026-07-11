#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

/* Every env key this script may write into a client's MCP config. Selecting a
   provider mode (gateway / gateway+BYOK / local) writes a full values object
   across all of these keys, so switching modes cleanly clears the previous
   mode's leftover values instead of leaving stale, conflicting config behind. */
const MANAGED_ENV_KEYS = [
  "LLM_GATEWAY_URL",
  "LLM_GATEWAY_TOKEN",
  "OPENROUTER_BYOK_KEY",
  "OPENROUTER_BYOK_MODEL",
  "LOCAL_LLM_API_URL",
  "LOCAL_LLM_MODEL",
];
/* New explicit-mode metadata is additive so callers relying on the v1 key
   list continue to work while migrations can persist mode and references. */
const PROVIDER_META_KEYS = ["TOKEN_OPTIMIZER_PROVIDER_MODE", "TOKEN_OPTIMIZER_CREDENTIAL_REF", "OPENROUTER_API_KEY"];
const ALL_MANAGED_ENV_KEYS = [...MANAGED_ENV_KEYS, ...PROVIDER_META_KEYS];
const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";
const DEFAULT_LOCAL_LLM_URL = "http://localhost:8080/v1";
const DEFAULT_LOCAL_LLM_MODEL = "local-model";
/* Same label the npm installer uses: both tools manage the one GUI-session
   LaunchAgent, so re-running either keeps a single agent rather than two. */
const LAUNCH_AGENT_LABEL = "com.softawarest.token-optimizer.env";

function emptyManagedValues() {
  return Object.fromEntries(ALL_MANAGED_ENV_KEYS.map((key) => [key, ""]));
}

const DIRECTIVE_MARKER_START = "<!-- TOKEN_OPTIMIZER_START -->";
const DIRECTIVE_MARKER_END = "<!-- TOKEN_OPTIMIZER_END -->";
/* Mirrors the shipped skill's existing triggers (scout / verdict / triage /
   regression / changed-files-review) as a standing default-on rule instead of
   a heuristic description, so the model reaches for these tools without
   needing to be asked each time. */
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

/* Global instruction files each client reads on its own (not MCP config), so
   this is a separate target list from getManagedTargets — different files,
   different mutation shape (raw text, not JSON). Cursor project rules are not
   included because Cursor has no filesystem-writable global .mdc rule path. */
function getDirectiveTargets(home) {
  const homeDir = path.resolve(home || process.env.HOME || os.homedir());
  return [
    { label: "Claude Code global instructions", filePath: path.join(homeDir, ".claude", "CLAUDE.md") },
    { label: "Codex global instructions", filePath: path.join(homeDir, ".codex", "AGENTS.md") },
    { label: "Antigravity/Gemini global instructions", filePath: path.join(homeDir, ".gemini", "GEMINI.md") },
    { label: "OpenCode global instructions", filePath: path.join(homeDir, ".config", "opencode", "AGENTS.md") },
  ];
}

function hasDirectiveBlock(content) {
  return content.includes(DIRECTIVE_MARKER_START) && content.includes(DIRECTIVE_MARKER_END);
}

function applyDirectiveBlock(content) {
  const startIdx = content.indexOf(DIRECTIVE_MARKER_START);
  const endIdx = content.indexOf(DIRECTIVE_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + DIRECTIVE_MARKER_END.length);
    return `${before}${DIRECTIVE_BLOCK}${after}`;
  }
  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${DIRECTIVE_BLOCK}`;
}

function removeDirectiveBlock(content) {
  const startIdx = content.indexOf(DIRECTIVE_MARKER_START);
  const endIdx = content.indexOf(DIRECTIVE_MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + DIRECTIVE_MARKER_END.length);
  return `${before}${after}`.replace(/(?:\r?\n){3,}/g, "\n\n");
}

function directiveBackupRoot(home) {
  return path.join(path.resolve(home || process.env.HOME || os.homedir()), ".token-optimizer-mcp", "backups");
}

function applyDirectiveToTargets(home) {
  const backupRoot = directiveBackupRoot(home);
  for (const target of getDirectiveTargets(home)) {
    if (fs.existsSync(target.filePath)) {
      backupFileIfPresent(target.filePath, backupRoot);
    }
    ensureDirectory(path.dirname(target.filePath));
    const content = fs.existsSync(target.filePath) ? fs.readFileSync(target.filePath, "utf8") : "";
    fs.writeFileSync(target.filePath, applyDirectiveBlock(content));
  }
}

function removeDirectiveFromTargets(home) {
  const backupRoot = directiveBackupRoot(home);
  for (const target of getDirectiveTargets(home)) {
    if (!fs.existsSync(target.filePath)) {
      continue;
    }
    const content = fs.readFileSync(target.filePath, "utf8");
    if (!hasDirectiveBlock(content)) {
      continue;
    }
    backupFileIfPresent(target.filePath, backupRoot);
    fs.writeFileSync(target.filePath, removeDirectiveBlock(content));
  }
}

function printDirectiveStatus(home) {
  for (const target of getDirectiveTargets(home)) {
    if (!fs.existsSync(target.filePath)) {
      console.log(`- ${target.label} (default-on directive): file not found`);
      continue;
    }
    const content = fs.readFileSync(target.filePath, "utf8");
    console.log(`- ${target.label} (default-on directive): ${hasDirectiveBlock(content) ? "configured" : "not configured"}`);
  }
}

/* Centralize the file mutation targets so setup, update, delete, and status
   all operate on the same stable user-owned surfaces instead of ad hoc
   path-specific logic spread across the command handlers. Derived from a
   passed-in home dir (rather than a module-level constant) so tests can
   point the whole target set at a temp directory. */
function getManagedTargets(home) {
  const homeDir = path.resolve(home || process.env.HOME || os.homedir());
  const backupRoot = path.join(homeDir, ".token-optimizer-mcp", "backups");
  const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
  const geminiConfigPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const antigravityPluginConfigPath = path.join(
    homeDir, ".gemini", "config", "plugins", "token-optimizer", "mcp_config.json"
  );
  const opencodeConfigPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
  const cursorConfigPath = path.join(homeDir, ".cursor", "mcp.json");
  const localTesterServerArgs = [
    path.join(homeDir, ".gemini", "config", "plugins", "token-optimizer", "server", "start.sh"),
  ];
  const opencodeServerCommand = [
    "bash",
    path.join(homeDir, ".config", "opencode", "token-optimizer-server", "start.sh"),
  ];
  const cursorServerArgs = [
    path.join(homeDir, ".cursor", "token-optimizer-server", "start.sh"),
  ];

  return [
    {
      label: "Claude Code settings",
      filePath: claudeSettingsPath,
      backupRoot,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.env = mergeManagedEnvValues(next.env || {}, values);
        return next;
      },
    },
    {
      label: "Gemini CLI MCP config",
      filePath: geminiConfigPath,
      backupRoot,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.token_optimizer?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.token_optimizer.command = next.mcpServers.token_optimizer.command || "bash";
        next.mcpServers.token_optimizer.args =
          Array.isArray(next.mcpServers.token_optimizer.args) && next.mcpServers.token_optimizer.args.length > 0
            ? next.mcpServers.token_optimizer.args : localTesterServerArgs;
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(
          next.mcpServers.token_optimizer.env || {}, values
        );
        return next;
      },
    },
    {
      label: "Antigravity staged plugin config",
      filePath: antigravityPluginConfigPath,
      backupRoot,
      optional: true,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.token_optimizer?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(
          next.mcpServers.token_optimizer.env || {}, values
        );
        return next;
      },
    },
    {
      label: "OpenCode global config",
      filePath: opencodeConfigPath,
      backupRoot,
      readConfig: readJsoncFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcp?.token_optimizer?.environment || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcp = next.mcp || {};
        next.mcp.token_optimizer = next.mcp.token_optimizer || {
          type: "local",
          command: opencodeServerCommand,
          enabled: true,
        };
        next.mcp.token_optimizer.type = next.mcp.token_optimizer.type || "local";
        next.mcp.token_optimizer.command =
          Array.isArray(next.mcp.token_optimizer.command) && next.mcp.token_optimizer.command.length > 0
            ? next.mcp.token_optimizer.command : opencodeServerCommand;
        next.mcp.token_optimizer.enabled = next.mcp.token_optimizer.enabled !== false;
        next.mcp.token_optimizer.environment = mergeManagedEnvValues(
          next.mcp.token_optimizer.environment || {}, values
        );
        return next;
      },
    },
    {
      label: "Cursor global MCP config",
      filePath: cursorConfigPath,
      backupRoot,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.token_optimizer?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.token_optimizer = next.mcpServers.token_optimizer || {
          command: "bash",
          args: cursorServerArgs,
        };
        next.mcpServers.token_optimizer.command = next.mcpServers.token_optimizer.command || "bash";
        next.mcpServers.token_optimizer.args =
          Array.isArray(next.mcpServers.token_optimizer.args) && next.mcpServers.token_optimizer.args.length > 0
            ? next.mcpServers.token_optimizer.args : cursorServerArgs;
        next.mcpServers.token_optimizer.env = mergeManagedEnvValues(
          next.mcpServers.token_optimizer.env || {}, values
        );
        return next;
      },
    },
  ];
}

async function main() {
  const command = normalizeCommand(process.argv[2]);

  if (command === "help" || process.argv.includes("--help")) {
    printHelp();
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const resolvedCommand =
      command || (await promptForCommand(rl));

    if (resolvedCommand === "status") {
      printStatus(undefined);
      return;
    }

    if (resolvedCommand === "enable-defaults") {
      applyDirectiveToTargets();
      console.log("");
      console.log("Default-on usage directive written to all managed global instructions files.");
      printDirectiveStatus();
      return;
    }

    if (resolvedCommand === "disable-defaults") {
      removeDirectiveFromTargets();
      console.log("");
      console.log("Default-on usage directive removed from all managed global instructions files.");
      printDirectiveStatus();
      return;
    }

    if (resolvedCommand === "delete") {
      await deleteConfiguration(rl);
      return;
    }

    if (resolvedCommand === "setup" || resolvedCommand === "update") {
      await upsertConfiguration(rl, resolvedCommand);
      return;
    }

    throw new Error(`Unsupported command: ${resolvedCommand}`);
  } finally {
    rl.close();
  }
}

function normalizeCommand(value) {
  if (!value) {
    return "";
  }

  const lowered = value.toLowerCase();
  if (["setup", "update", "delete", "status", "help", "enable-defaults", "disable-defaults"].includes(lowered)) {
    return lowered;
  }
  return "";
}

function printHelp() {
  console.log(`Usage: node scripts/manage-gateway-config.js [setup|update|delete|status|enable-defaults|disable-defaults]

Commands:
  setup            Prompt for a provider (gateway token, your own OpenRouter key with no token needed, or a local LLM with no token) and write it to all managed clients
  update           Prompt again and replace the managed provider values
  delete           Remove managed provider values from all managed clients
  status           Show current managed provider values, GUI-session state, and directive status
  enable-defaults  Write a default-on usage directive into managed global instructions
  disable-defaults Remove the default-on usage directive from those files

When no command is provided, the script prompts for one interactively.`);
}

async function promptForCommand(rl) {
  console.log("Select an action:");
  console.log("  1. setup");
  console.log("  2. update");
  console.log("  3. delete");
  console.log("  4. status");
  console.log("  5. enable-defaults");
  console.log("  6. disable-defaults");

  while (true) {
    const answer = (await ask(rl, "Action [1-6]: ")).trim();
    if (answer === "1") {
      return "setup";
    }
    if (answer === "2") {
      return "update";
    }
    if (answer === "3") {
      return "delete";
    }
    if (answer === "4") {
      return "status";
    }
    if (answer === "5") {
      return "enable-defaults";
    }
    if (answer === "6") {
      return "disable-defaults";
    }
    console.log("Enter 1, 2, 3, 4, 5, or 6.");
  }
}

/* Ask which LLM provider mode to configure, then collect only the values that
   mode needs.
   - "gateway": shared infrastructure, requires a proxy/issued token, daily-limited.
   - "byok": your own OpenRouter key. NO proxy token is required or asked for
     at all — you aren't using the operator's OpenRouter setup, so the gateway
     never authenticates you; it only proxies the request. You may optionally
     select one OpenRouter model for every task.
     Unlimited usage, billed to your own OpenRouter account.
   - "local": your own OpenAI-compatible endpoint. No token, no gateway, fully
     offline; nothing leaves your machine.
   - "skip": leaves existing config untouched.
   Picking a mode writes a full values object across every managed key, so
   switching modes cleanly clears whatever the previous mode left behind. */
async function promptForProviderMode(rl) {
  console.log("How should the LLM provider be configured?");
  console.log("  1. Gateway access token - shared infrastructure, requires an approved token, 20 calls/day by default");
  console.log("  2. Your own OpenRouter key - unlimited usage, billed to your account, NO token needed at all");
  console.log("  3. Local LLM only - your own OpenAI-compatible endpoint, no token, nothing leaves your machine");
  console.log("  4. Skip for now (leaves current configuration untouched)");
  while (true) {
    const answer = (await ask(rl, "Choice [1-4]: ")).trim();
    if (answer === "1" || answer === "") return "gateway";
    if (answer === "2") return "byok";
    if (answer === "3") return "local";
    if (answer === "4") return "skip";
    console.log("Enter 1, 2, 3, or 4.");
  }
}

async function collectGatewayValues(rl, existing) {
  const values = emptyManagedValues();
  values.TOKEN_OPTIMIZER_PROVIDER_MODE = "gateway-token";
  values.LLM_GATEWAY_TOKEN = await askRequired(
    rl,
    `Gateway proxy token${existing.LLM_GATEWAY_TOKEN ? " [press Enter to keep current]" : ""}: `,
    existing.LLM_GATEWAY_TOKEN,
  );
  const currentUrl = existing.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const urlAnswer = (await ask(rl, `Gateway URL [${currentUrl}]: `)).trim();
  values.LLM_GATEWAY_URL = urlAnswer || currentUrl;
  return values;
}

async function collectByokValues(rl, existing) {
  const values = emptyManagedValues();
  values.TOKEN_OPTIMIZER_PROVIDER_MODE = "gateway-byok";
  const currentUrl = existing.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const urlAnswer = (await ask(rl, `Gateway URL [${currentUrl}]: `)).trim();
  values.LLM_GATEWAY_URL = urlAnswer || currentUrl;
  values.OPENROUTER_BYOK_KEY = await askRequired(
    rl,
    `Your OpenRouter API key (sk-or-...)${existing.OPENROUTER_BYOK_KEY ? " [press Enter to keep current]" : ""}: `,
    existing.OPENROUTER_BYOK_KEY,
  );
  values.OPENROUTER_BYOK_MODEL = await askOptional(
    rl,
    `OpenRouter model ID (optional; Enter to ${existing.OPENROUTER_BYOK_MODEL ? "keep current, - to clear" : "use gateway default"}): `,
    existing.OPENROUTER_BYOK_MODEL,
  );
  console.log("");
  console.log("No proxy token needed: calls are billed to your OpenRouter account, unlimited.");
  return values;
}

async function collectLocalValues(rl, existing) {
  const values = emptyManagedValues();
  values.TOKEN_OPTIMIZER_PROVIDER_MODE = "local";
  const currentUrl = existing.LOCAL_LLM_API_URL || DEFAULT_LOCAL_LLM_URL;
  const urlAnswer = (await ask(rl, `Local LLM endpoint [${currentUrl}]: `)).trim();
  values.LOCAL_LLM_API_URL = urlAnswer || currentUrl;
  const currentModel = existing.LOCAL_LLM_MODEL || DEFAULT_LOCAL_LLM_MODEL;
  const modelAnswer = (await ask(rl, `Local LLM model name [${currentModel}]: `)).trim();
  values.LOCAL_LLM_MODEL = modelAnswer || currentModel;
  console.log("");
  console.log("No token needed. Make sure an OpenAI-compatible endpoint is running and reachable at that URL.");
  return values;
}

async function collectValuesForProviderMode(rl, existing, providerMode) {
  if (providerMode === "byok") return collectByokValues(rl, existing);
  if (providerMode === "local") return collectLocalValues(rl, existing);
  return collectGatewayValues(rl, existing);
}

async function upsertConfiguration(rl, mode) {
  const existing = collectCurrentValues();
  const providerMode = await promptForProviderMode(rl);

  if (providerMode === "skip") {
    console.log("");
    console.log("Skipped. Existing configuration left untouched.");
    printStatus();
    return;
  }

  const values = await collectValuesForProviderMode(rl, existing, providerMode);

  applyToTargets(values);
  applyLaunchctlValues(values);

  console.log("");
  console.log(
    mode === "setup"
      ? "Provider configuration saved for all managed clients."
      : "Provider configuration updated for all managed clients.",
  );
  printStatus();
}

async function deleteConfiguration(rl) {
  const confirmation = (
    await ask(rl, "Remove managed gateway values from all clients and unset the GUI-session environment? [y/N]: ")
  ).trim().toLowerCase();

  if (confirmation !== "y" && confirmation !== "yes") {
    console.log("Delete cancelled.");
    return;
  }

  applyToTargets({});
  clearLaunchctlValues();

  console.log("");
  console.log("Managed gateway values removed.");
  printStatus();
}

function collectCurrentValues(home) {
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const values = target.getValues(config);
    if (Object.keys(values).length > 0) {
      return values;
    }
  }
  return readLaunchctlValues();
}

function printStatus(home) {
  console.log("");
  console.log("Current managed status:");
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const values = target.getValues(config);
    console.log(`- ${target.label}: ${summarizeValues(values)}`);
  }
  console.log(`- macOS GUI session (launchctl): ${summarizeValues(readLaunchctlValues())}`);
  printDirectiveStatus(home);
}

function summarizeValues(values) {
  if (!ALL_MANAGED_ENV_KEYS.some((key) => values[key])) {
    return "not configured";
  }
  const parts = [];
  if (values.LLM_GATEWAY_URL) {
    parts.push(`gateway_url=${values.LLM_GATEWAY_URL}`);
  }
  if (values.LLM_GATEWAY_TOKEN) {
    parts.push(`gateway_token=${redactSecret(values.LLM_GATEWAY_TOKEN)}`);
  }
  if (values.OPENROUTER_BYOK_KEY) {
    parts.push(`byok_key=${redactSecret(values.OPENROUTER_BYOK_KEY)}`);
  }
  if (values.OPENROUTER_BYOK_MODEL) {
    parts.push(`byok_model=${values.OPENROUTER_BYOK_MODEL}`);
  }
  if (values.LOCAL_LLM_API_URL) {
    parts.push(`local_url=${values.LOCAL_LLM_API_URL}`);
  }
  if (values.LOCAL_LLM_MODEL) {
    parts.push(`local_model=${values.LOCAL_LLM_MODEL}`);
  }
  return parts.join(" ");
}

function redactSecret(value) {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function applyToTargets(values, home) {
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const nextConfig = target.applyValues(config, values);
    writeTargetConfig(target, nextConfig);
  }
}

function safeReadTargetConfig(target) {
  if (!fs.existsSync(target.filePath)) {
    if (target.optional) {
      return {};
    }
    return {};
  }
  return target.readConfig(target.filePath);
}

function writeTargetConfig(target, config) {
  ensureDirectory(path.dirname(target.filePath));
  backupFileIfPresent(target.filePath, target.backupRoot);
  target.writeConfig(target.filePath, config);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/* OpenCode accepts JSONC for its global config. The manager only needs to read
   normal config objects and write canonical JSON, so it strips comments and
   trailing commas before parsing instead of introducing a runtime parser
   dependency into this repo-shipped setup script. */
function readJsoncFile(filePath) {
  return JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(filePath, "utf8")));
}

function writeJsonFile(filePath, config) {
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`);
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

    if ((char === "\"" || char === "'")) {
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

function mergeManagedEnvValues(existingEnv, incomingValues) {
  const next = { ...existingEnv };

  for (const envKey of [...MANAGED_ENV_KEYS, "TOKEN_OPTIMIZER_PROVIDER_MODE", "TOKEN_OPTIMIZER_CREDENTIAL_REF"]) {
    const value = incomingValues[envKey];
    if (value) {
      next[envKey] = value;
    } else {
      delete next[envKey];
    }
  }

  return next;
}

function sanitizeEnvObject(envObject) {
  const next = {};
  for (const envKey of [...MANAGED_ENV_KEYS, "TOKEN_OPTIMIZER_PROVIDER_MODE", "TOKEN_OPTIMIZER_CREDENTIAL_REF"]) {
    if (typeof envObject[envKey] === "string" && envObject[envKey].trim() !== "") {
      next[envKey] = envObject[envKey];
    }
  }
  return next;
}

function backupFileIfPresent(filePath, backupRoot) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  ensureDirectory(backupRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = path.basename(filePath);
  const backupPath = path.join(
    backupRoot,
    `${baseName}.${timestamp}.bak`,
  );
  fs.copyFileSync(filePath, backupPath);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/* GUI-launched macOS apps do not inherit shell rc files, so persist the
   gateway variables into the user's launchd session. An immediate
   `launchctl setenv` fixes the current login, but that alone is wiped on the
   next reboot/logout — so a RunAtLoad LaunchAgent re-applies the same values
   at every future login. That lets Codex, Claude, and Antigravity read the
   same values when started from the Dock, Finder, Spotlight, or their own
   launchers, even after a restart. */
function applyLaunchctlValues(values) {
  for (const envKey of ALL_MANAGED_ENV_KEYS) {
    const value = values[envKey];
    if (value) {
      runLaunchctl(["setenv", envKey, value]);
    } else {
      runLaunchctl(["unsetenv", envKey], { allowFailure: true });
    }
  }
  writePersistentLaunchAgent(values);
}

function clearLaunchctlValues() {
  for (const envKey of ALL_MANAGED_ENV_KEYS) {
    runLaunchctl(["unsetenv", envKey], { allowFailure: true });
  }
  writePersistentLaunchAgent(emptyManagedValues());
}

/* Writes (or removes) the RunAtLoad LaunchAgent plist that re-applies the
   managed env at every login. Under the test state-file seam the plist lands
   next to the state file and no real `launchctl bootstrap` runs. */
function launchAgentPlistPath() {
  const statePath =
    process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH ||
    process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
  const dir = statePath
    ? path.dirname(statePath)
    : path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${LAUNCH_AGENT_LABEL}.plist`);
}

function writePersistentLaunchAgent(values) {
  const usingStateHook =
    process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH ||
    process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
  const plistPath = launchAgentPlistPath();
  const hasAny = ALL_MANAGED_ENV_KEYS.some((envKey) => values[envKey]);
  if (!hasAny) {
    if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath, { force: true });
    }
    reloadLaunchAgent(plistPath, true, usingStateHook);
    return;
  }
  ensureDirectory(path.dirname(plistPath));
  fs.writeFileSync(plistPath, buildLaunchAgentPlist(values));
  try {
    fs.chmodSync(plistPath, 0o600);
  } catch {
    /* best-effort on non-POSIX filesystems. */
  }
  reloadLaunchAgent(plistPath, false, usingStateHook);
}

function buildLaunchAgentPlist(values) {
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const command = ALL_MANAGED_ENV_KEYS
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

function reloadLaunchAgent(plistPath, remove, usingStateHook) {
  if (usingStateHook || process.platform !== "darwin") {
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
  } catch {
    /* nothing loaded yet on first run. */
  }
  if (!remove) {
    try {
      execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
    } catch {
      /* a failed reload still leaves a plist that loads on next login. */
    }
  }
}

function readLaunchctlValues() {
  const values = {};
  for (const envKey of ALL_MANAGED_ENV_KEYS) {
    const value = runLaunchctl(["printenv", envKey], {
      allowFailure: true,
      captureOutput: true,
    });
    if (value) {
      values[envKey] = value.trim();
    }
  }
  return values;
}

function runLaunchctl(args, options = {}) {
  const statePath =
    process.env.LOCAL_OPTIMIZER_LAUNCHCTL_STATE_PATH ||
    process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
  if (statePath) {
    return runLaunchctlStateFile(statePath, args, options);
  }

  if (process.platform !== "darwin") {
    if (options.allowFailure) {
      return "";
    }
    throw new Error("launchctl environment persistence is only supported on macOS.");
  }

  try {
    return execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: options.captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
  } catch (error) {
    if (options.allowFailure) {
      return "";
    }
    throw error;
  }
}

function runLaunchctlStateFile(statePath, args, options) {
  let state = {};
  if (fs.existsSync(statePath)) {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  }

  const [command, envKey, value] = args;
  if (command === "setenv") {
    state[envKey] = value;
    ensureDirectory(path.dirname(statePath));
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return "";
  }

  if (command === "unsetenv") {
    delete state[envKey];
    ensureDirectory(path.dirname(statePath));
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return "";
  }

  if (command === "printenv") {
    if (!(envKey in state)) {
      if (options.allowFailure) {
        return "";
      }
      throw new Error(`${envKey} is not set in launchctl state file`);
    }
    return state[envKey];
  }

  throw new Error(`Unsupported simulated launchctl command: ${command}`);
}

function ask(rl, prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function askRequired(rl, prompt, fallbackValue) {
  while (true) {
    const answer = (await ask(rl, prompt)).trim();
    if (answer) {
      return answer;
    }
    if (fallbackValue) {
      return fallbackValue;
    }
    console.log("This value is required.");
  }
}

async function askOptional(rl, prompt, fallbackValue) {
  const answer = (await ask(rl, prompt)).trim();
  if (answer === "-") {
    return "";
  }
  return answer || fallbackValue || "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Gateway config manager failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  MANAGED_ENV_KEYS: ALL_MANAGED_ENV_KEYS,
  PROVIDER_META_KEYS,
  ALL_MANAGED_ENV_KEYS,
  DEFAULT_GATEWAY_URL,
  DEFAULT_LOCAL_LLM_URL,
  DEFAULT_LOCAL_LLM_MODEL,
  emptyManagedValues,
  DIRECTIVE_MARKER_START,
  DIRECTIVE_MARKER_END,
  DIRECTIVE_BLOCK,
  sanitizeEnvObject,
  mergeManagedEnvValues,
  getManagedTargets,
  applyToTargets,
  collectCurrentValues,
  applyLaunchctlValues,
  readLaunchctlValues,
  clearLaunchctlValues,
  LAUNCH_AGENT_LABEL,
  getDirectiveTargets,
  hasDirectiveBlock,
  applyDirectiveBlock,
  removeDirectiveBlock,
  applyDirectiveToTargets,
  removeDirectiveFromTargets,
  stripJsonCommentsAndTrailingCommas,
  stripTrailingCommas,
  collectByokValues,
};
