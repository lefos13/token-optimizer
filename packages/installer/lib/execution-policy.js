const fs = require("fs");
const os = require("os");
const path = require("path");

/* User-owned execution policy (~/.config/token-optimizer/config.json). The MCP
   server reads `execution.profile` and `execution.allowedCommandPrefixes` from
   this file as the authoritative ceiling; projects and tool calls can only
   narrow it. Writes keep unrelated keys and the private 0600 mode. */

const PROFILES = ["safe", "standard", "unrestricted"];

const PROFILE_DESCRIPTIONS = {
  standard: "Your project's build/test/lint scripts, common test runners and linters (vitest, jest, pytest, cargo, go, tsc, eslint, ruff, ...), and read-only inspection (git status/log/diff, ls, grep, cat). Nothing that installs packages, edits files in place, or runs arbitrary scripts.",
  safe: "Only the command prefixes you add with `token-optimizer allow`.",
  unrestricted: "Any command your agent asks for. Use only for repositories you trust: a malicious repository or a prompt injection could then run any program with your user's privileges.",
};

const ALWAYS_BLOCKED = "In every profile: no command chaining, pipes, redirection, network tools, nested shells, destructive commands, secret files (.env, keys), environment variables, or paths outside the workspace.";

/* Prefixes the server would still reject in every profile; refusing them here
   avoids an allowlist entry that silently never takes effect. */
const DENIED_EXECUTABLES = new Set(["curl", "wget", "nc", "netcat", "socat", "scp", "ssh", "ftp", "telnet", "sh", "bash", "zsh", "fish", "cmd", "powershell", "eval", "env", "printenv", "mkfs", "fdisk", "dd", "shutdown", "reboot"]);

function policyPath(home) {
  return path.join(path.resolve(home || os.homedir()), ".config", "token-optimizer", "config.json");
}

function readConfig(home) {
  const filePath = policyPath(home);
  if (!fs.existsSync(filePath)) return {};
  let config;
  try { config = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw new Error(`Invalid Token Optimizer configuration at ${filePath}; fix or remove it: ${error.message}`); }
  if (!config || Array.isArray(config) || typeof config !== "object") throw new Error(`Invalid Token Optimizer configuration at ${filePath}; expected a JSON object`);
  if (config.execution !== undefined && (!config.execution || Array.isArray(config.execution) || typeof config.execution !== "object")) {
    throw new Error(`Invalid Token Optimizer execution configuration at ${filePath}; expected a JSON object`);
  }
  return config;
}

function writeConfig(home, config) {
  const filePath = policyPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Non-POSIX filesystems may not support chmod. */ }
  return filePath;
}

function readPolicy(home) {
  const execution = readConfig(home).execution || {};
  return {
    profile: PROFILES.includes(execution.profile) ? execution.profile : undefined,
    allowedCommandPrefixes: Array.isArray(execution.allowedCommandPrefixes) ? execution.allowedCommandPrefixes.filter((entry) => typeof entry === "string") : [],
  };
}

function normalizeProfile(value) {
  const profile = String(value || "").trim().toLowerCase();
  if (!PROFILES.includes(profile)) throw new Error(`Unsupported execution profile: ${value}. Choose safe, standard, or unrestricted.`);
  return profile;
}

function setProfile(home, value) {
  const profile = normalizeProfile(value);
  const config = readConfig(home);
  config.execution = { ...(config.execution || {}), profile };
  return { profile, path: writeConfig(home, config) };
}

function validatePrefix(value) {
  const prefix = String(value || "").trim().replace(/\s+/g, " ");
  if (!prefix) throw new Error("Provide a command prefix, for example: token-optimizer allow \"npm install\"");
  if (prefix.length > 200) throw new Error("Command prefix is too long (200 characters max).");
  if (/[;&|`<>$"'\\\r\n]/.test(prefix)) throw new Error("Command prefixes cannot contain shell operators, quotes, or variables.");
  const executable = prefix.split(" ")[0].toLowerCase().replace(/\.exe$/, "");
  if (DENIED_EXECUTABLES.has(executable)) throw new Error(`"${executable}" is blocked in every profile, so allowing it would have no effect.`);
  return prefix;
}

function addAllowedPrefix(home, value) {
  const prefix = validatePrefix(value);
  const config = readConfig(home);
  const execution = { ...(config.execution || {}) };
  const current = Array.isArray(execution.allowedCommandPrefixes) ? execution.allowedCommandPrefixes : [];
  const added = !current.includes(prefix);
  execution.allowedCommandPrefixes = added ? [...current, prefix] : current;
  if (!execution.profile) execution.profile = "standard";
  config.execution = execution;
  return { prefix, added, path: writeConfig(home, config) };
}

function removeAllowedPrefix(home, value) {
  const prefix = String(value || "").trim().replace(/\s+/g, " ");
  const config = readConfig(home);
  const execution = { ...(config.execution || {}) };
  const current = Array.isArray(execution.allowedCommandPrefixes) ? execution.allowedCommandPrefixes : [];
  const removed = current.includes(prefix);
  execution.allowedCommandPrefixes = current.filter((entry) => entry !== prefix);
  config.execution = execution;
  return { prefix, removed, path: writeConfig(home, config) };
}

/* Interactive profile choice used by install and `profile`. Unrestricted needs
   a typed confirmation so it is never picked by a stray keypress. */
async function promptForProfile(ask, log) {
  const order = ["standard", "safe", "unrestricted"];
  log("\nWhich commands may Token Optimizer run on your agent's behalf?");
  order.forEach((name, index) => log(`  ${index + 1}) ${name}${name === "standard" ? " (recommended)" : ""}: ${PROFILE_DESCRIPTIONS[name]}`));
  log(`${ALWAYS_BLOCKED}\n`);
  while (true) {
    const answer = String(await ask("Choose 1-3 [1]: ")).trim();
    const profile = answer === "" ? "standard" : order[Number(answer) - 1];
    if (!profile) { log("Please enter 1, 2, or 3."); continue; }
    if (profile !== "unrestricted") return profile;
    const confirm = String(await ask('Unrestricted lets the agent run any program as you. Type "unrestricted" to confirm, or press Enter to go back: ')).trim().toLowerCase();
    if (confirm === "unrestricted") return profile;
  }
}

module.exports = {
  promptForProfile,
  PROFILES, PROFILE_DESCRIPTIONS, ALWAYS_BLOCKED,
  policyPath, readPolicy, normalizeProfile, setProfile, validatePrefix, addAllowedPrefix, removeAllowedPrefix,
};
