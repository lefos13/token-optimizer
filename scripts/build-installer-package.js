const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const installerDir = path.join(rootDir, "packages", "installer");
const assetsDir = path.join(installerDir, "assets");

const copyTargets = [
  ["plugin/antigravity", "plugin/antigravity"],
  ["plugin/claude", "plugin/claude"],
  ["plugin/codex", "plugin/codex"],
  ["plugin/opencode", "plugin/opencode"],
  ["plugin/cursor", "plugin/cursor"],
  [".claude-plugin", ".claude-plugin"],
  [".agents/plugins", ".agents/plugins"],
];

console.log("Building Token Optimizer installer package assets...");

fs.rmSync(assetsDir, { recursive: true, force: true });
fs.mkdirSync(assetsDir, { recursive: true });

for (const [sourceRelative, destRelative] of copyTargets) {
  const source = path.join(rootDir, sourceRelative);
  const dest = path.join(assetsDir, destRelative);
  if (!fs.existsSync(source)) {
    throw new Error(`Required installer asset is missing: ${source}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true });
}

console.log("Installer package assets written under packages/installer/assets/");
