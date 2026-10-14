#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

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

/* Global instruction files each client reads on its own (not MCP config).
   Cursor project rules are not included because Cursor has no filesystem-writable
   global .mdc rule path. */
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

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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
    `${baseName}.${timestamp}.bak`
  );
  fs.copyFileSync(filePath, backupPath);
}

function normalizeCommand(value) {
  if (!value) {
    return "";
  }
  const lowered = value.toLowerCase();
  if (["enable-defaults", "disable-defaults", "status", "help"].includes(lowered)) {
    return lowered;
  }
  return "";
}

function printHelp() {
  console.log(`Usage: node scripts/manage-defaults.js [enable-defaults|disable-defaults|status]

Commands:
  enable-defaults  Write a default-on usage directive into managed global instructions
  disable-defaults Remove the default-on usage directive from those files
  status           Show current default-on directive status across managed files

When no command is provided, the script prompts for one interactively.`);
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

async function promptForCommand(rl) {
  console.log("Select an action:");
  console.log("  1. enable-defaults");
  console.log("  2. disable-defaults");
  console.log("  3. status");

  while (true) {
    const answer = (await ask(rl, "Action [1-3]: ")).trim();
    if (answer === "1") return "enable-defaults";
    if (answer === "2") return "disable-defaults";
    if (answer === "3") return "status";
    console.log("Please enter 1, 2, or 3.");
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = normalizeCommand(argv[0]);

  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const resolvedCommand = command || (await promptForCommand(rl));

    if (resolvedCommand === "status") {
      printDirectiveStatus();
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

    throw new Error(`Unsupported command: ${resolvedCommand}`);
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Default instructions manager failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DIRECTIVE_MARKER_START,
  DIRECTIVE_MARKER_END,
  DIRECTIVE_BLOCK,
  getDirectiveTargets,
  hasDirectiveBlock,
  applyDirectiveBlock,
  removeDirectiveBlock,
  directiveBackupRoot,
  applyDirectiveToTargets,
  removeDirectiveFromTargets,
  printDirectiveStatus,
  normalizeCommand,
  printHelp,
  main,
};
