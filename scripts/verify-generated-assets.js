const { spawnSync } = require("node:child_process");

const targets = [".claude-plugin", ".agents", "plugin/claude", "plugin/codex", "packages/installer/assets"];
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });
const fail = (code, details, status) => { console.error(JSON.stringify({ ok: false, code, details })); process.exit(status); };
const git = args => {
  const result = run("git", args);
  if (result.status !== 0 || result.error) fail("GENERATED_GIT_FAILED", { command: args[0], status: result.status, stderr: result.stderr, error: result.error?.message }, 23);
  return result;
};

/*
 * Generation starts only from a pristine repository, so verification cannot
 * overwrite or reconstruct caller-owned index, worktree, or untracked state.
 */
const initial = git(["status", "--porcelain", "--untracked-files=all"]);
if (initial.stdout.trim()) fail("GENERATED_CHECK_DIRTY", initial.stdout.trim().split(/\r?\n/), 22);
const generated = run("npm", ["run", "build:installer"], { stdio: "inherit", shell: process.platform === "win32" });
if (generated.status !== 0 || generated.error) fail("GENERATED_BUILD_FAILED", generated.error?.message || generated.status, 20);
const status = git(["status", "--porcelain", "--untracked-files=all", "--", ...targets]);
if (status.stdout.trim()) {
  for (const target of targets) {
    if (git(["ls-files", "--", target]).stdout.trim()) git(["checkout", "HEAD", "--", target]);
  }
  git(["clean", "-fd", "--", ...targets]);
  const restored = git(["status", "--porcelain", "--untracked-files=all", "--", ...targets]);
  if (restored.stdout.trim()) fail("GENERATED_RESTORE_FAILED", restored.stdout.trim().split(/\r?\n/), 24);
  fail("GENERATED_ASSET_DRIFT", status.stdout.trim().split(/\r?\n/), 21);
}
console.log(JSON.stringify({ ok: true, code: "GENERATED_ASSETS_CURRENT" }));
