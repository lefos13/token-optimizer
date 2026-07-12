const { spawnSync } = require("node:child_process");

/*
 * Regeneration followed by a Git comparison makes generated assets reproducible
 * while restoring the caller's working tree when drift is detected.
 */
const before = spawnSync("git", ["diff", "--binary", "HEAD", "--", ".claude-plugin", ".agents", "plugin/claude", "plugin/codex", "packages/installer/assets"], { encoding: "utf8" });
const generated = spawnSync("npm", ["run", "build:installer"], { stdio: "inherit", shell: process.platform === "win32" });
if (generated.status !== 0) process.exit(20);
const status = spawnSync("git", ["status", "--porcelain", "--", ".claude-plugin", ".agents", "plugin/claude", "plugin/codex", "packages/installer/assets"], { encoding: "utf8" });
if (status.stdout.trim()) {
  spawnSync("git", ["checkout", "HEAD", "--", ".claude-plugin", ".agents", "plugin/claude", "plugin/codex", "packages/installer/assets"]);
  if (before.stdout) spawnSync("git", ["apply", "--binary", "-"], { input: before.stdout });
  console.error(JSON.stringify({ ok: false, code: "GENERATED_ASSET_DRIFT", files: status.stdout.trim().split(/\r?\n/) }));
  process.exit(21);
}
console.log(JSON.stringify({ ok: true, code: "GENERATED_ASSETS_CURRENT" }));
