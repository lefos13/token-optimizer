#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const GATEWAY_ENV_KEYS = ["LLM_GATEWAY_URL", "LLM_GATEWAY_TOKEN"];
const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";

/* Centralize the file mutation targets so setup, update, delete, and status
   all operate on the same stable user-owned surfaces instead of ad hoc
   path-specific logic spread across the command handlers. Derived from a
   passed-in home dir (rather than a module-level constant) so tests can
   point the whole target set at a temp directory. */
function getManagedTargets(home) {
  const homeDir = path.resolve(home || process.env.HOME || os.homedir());
  const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
  const geminiConfigPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const antigravityPluginConfigPath = path.join(
    homeDir, ".gemini", "config", "plugins", "local-tester", "mcp_config.json"
  );
  const localTesterServerArgs = [
    path.join(homeDir, ".gemini", "config", "plugins", "local-tester", "server", "start.sh"),
  ];

  return [
    {
      label: "Claude Code settings",
      filePath: claudeSettingsPath,
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
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.local_tester?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.local_tester = next.mcpServers.local_tester || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.local_tester.command = next.mcpServers.local_tester.command || "bash";
        next.mcpServers.local_tester.args =
          Array.isArray(next.mcpServers.local_tester.args) && next.mcpServers.local_tester.args.length > 0
            ? next.mcpServers.local_tester.args : localTesterServerArgs;
        next.mcpServers.local_tester.env = mergeManagedEnvValues(
          next.mcpServers.local_tester.env || {}, values
        );
        return next;
      },
    },
    {
      label: "Antigravity staged plugin config",
      filePath: antigravityPluginConfigPath,
      optional: true,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.local_tester?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.local_tester = next.mcpServers.local_tester || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.local_tester.env = mergeManagedEnvValues(
          next.mcpServers.local_tester.env || {}, values
        );
        return next;
      },
    },
  ];
}

const backupRoot = path.join(path.resolve(process.env.HOME || os.homedir()), ".local-tester-mcp", "backups");

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
  if (["setup", "update", "delete", "status", "help"].includes(lowered)) {
    return lowered;
  }
  return "";
}

function printHelp() {
  console.log(`Usage: node scripts/manage-gateway-config.js [setup|update|delete|status]

Commands:
  setup   Prompt for your gateway proxy token and write it to all managed clients
  update  Prompt again and replace the managed gateway values
  delete  Remove managed gateway values from all managed clients
  status  Show current managed gateway values and GUI-session state

When no command is provided, the script prompts for one interactively.`);
}

async function promptForCommand(rl) {
  console.log("Select an action:");
  console.log("  1. setup");
  console.log("  2. update");
  console.log("  3. delete");
  console.log("  4. status");

  while (true) {
    const answer = (await ask(rl, "Action [1-4]: ")).trim();
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
    console.log("Enter 1, 2, 3, or 4.");
  }
}

/* Collect the one per-person proxy token (required) and an optional gateway URL
   (defaults to the shared gateway), then fan them out to every managed client
   surface plus the macOS GUI session. */
async function upsertConfiguration(rl, mode) {
  const existing = collectCurrentValues();
  const values = {};

  values.LLM_GATEWAY_TOKEN = await askRequired(
    rl,
    `Gateway proxy token${existing.LLM_GATEWAY_TOKEN ? " [press Enter to keep current]" : ""}: `,
    existing.LLM_GATEWAY_TOKEN,
  );
  const currentUrl = existing.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const urlAnswer = (await ask(rl, `Gateway URL [${currentUrl}]: `)).trim();
  values.LLM_GATEWAY_URL = urlAnswer || currentUrl;

  applyToTargets(values);
  applyLaunchctlValues(values);

  console.log("");
  console.log(
    mode === "setup"
      ? "Gateway configuration saved for all managed clients."
      : "Gateway configuration updated for all managed clients.",
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
    if (values.LLM_GATEWAY_TOKEN || values.LLM_GATEWAY_URL) {
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
}

function summarizeValues(values) {
  if (!values.LLM_GATEWAY_TOKEN && !values.LLM_GATEWAY_URL) {
    return "not configured";
  }
  const parts = [];
  if (values.LLM_GATEWAY_URL) {
    parts.push(`url=${values.LLM_GATEWAY_URL}`);
  }
  if (values.LLM_GATEWAY_TOKEN) {
    parts.push(`token=${redactSecret(values.LLM_GATEWAY_TOKEN)}`);
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
  backupFileIfPresent(target.filePath);
  target.writeConfig(target.filePath, config);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

function sanitizeEnvObject(envObject) {
  const next = {};
  for (const envKey of GATEWAY_ENV_KEYS) {
    if (typeof envObject[envKey] === "string" && envObject[envKey].trim() !== "") {
      next[envKey] = envObject[envKey];
    }
  }
  return next;
}

function backupFileIfPresent(filePath) {
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
   gateway variables into the user's launchd session. That lets Codex,
   Claude, and Antigravity read the same values when started normally from the
   Dock, Finder, Spotlight, or their own launchers. */
function applyLaunchctlValues(values) {
  for (const envKey of GATEWAY_ENV_KEYS) {
    const value = values[envKey];
    if (value) {
      runLaunchctl(["setenv", envKey, value]);
    } else {
      runLaunchctl(["unsetenv", envKey], { allowFailure: true });
    }
  }
}

function clearLaunchctlValues() {
  for (const envKey of GATEWAY_ENV_KEYS) {
    runLaunchctl(["unsetenv", envKey], { allowFailure: true });
  }
}

function readLaunchctlValues() {
  const values = {};
  for (const envKey of GATEWAY_ENV_KEYS) {
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
  const statePath = process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
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
  GATEWAY_ENV_KEYS,
  DEFAULT_GATEWAY_URL,
  sanitizeEnvObject,
  mergeManagedEnvValues,
  getManagedTargets,
  applyToTargets,
  collectCurrentValues,
  applyLaunchctlValues,
  readLaunchctlValues,
  clearLaunchctlValues,
};
