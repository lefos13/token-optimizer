const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const policy = require("./release-policy");

class PreflightFailure extends Error {
  constructor(code, details) { super(code); this.code = code; this.details = details; }
}

/*
 * The release workflow is a pure orchestration boundary: filesystem, process,
 * environment, and argument inputs can be replaced by deterministic fixtures.
 */
function runPreflight(root, injected = {}) {
  const io = injected.fs || fs;
  const env = injected.env || process.env;
  const argv = injected.argv || process.argv.slice(2);
  const execute = injected.run || ((command, args, options = {}) => spawnSync(command, args, {
    cwd: root, encoding: "utf8", shell: process.platform === "win32", ...options,
  }));
  const commands = injected.commands || {};
  const fail = (code, details) => { throw new PreflightFailure(code, details); };
  const git = args => {
    const result = execute("git", args);
    if (result.status !== 0 || result.error) fail("GIT_COMMAND_FAILED", { command: args[0], status: result.status, error: result.error?.message, stderr: result.stderr });
    return result;
  };
  const readJson = file => JSON.parse(io.readFileSync(path.join(root, file), "utf8"));
  const rootPackage = readJson("package.json");
  const installerPackage = readJson("packages/installer/package.json");
  const artifacts = path.join(root, env.RELEASE_ARTIFACT_DIR || "release-artifacts");

  if (rootPackage.version !== installerPackage.version) fail("VERSION_MISMATCH", [rootPackage.version, installerPackage.version]);
  const lock = readJson("package-lock.json");
  if (lock.version !== rootPackage.version || lock.packages?.[""]?.version !== rootPackage.version) fail("VERSION_MISMATCH", "package-lock.json");
  for (const file of ["src/index.ts", ...["antigravity", "claude", "codex", "opencode", "cursor"].map(name => `scripts/generate-plugin-${name}.js`)]) {
    if (!io.readFileSync(path.join(root, file), "utf8").includes(rootPackage.version)) fail("VERSION_MISMATCH", file);
  }
  for (const directory of ["plugin/claude", "plugin/codex", "packages/installer/assets", ".claude-plugin", ".agents/plugins"]) {
    const walk = current => {
      for (const entry of io.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(?:json|js|md)$/.test(entry.name)) {
          const versions = io.readFileSync(file, "utf8").match(/\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+/g) || [];
          if (versions.some(version => version !== rootPackage.version)) fail("VERSION_MISMATCH", path.relative(root, file));
        }
      }
    };
    walk(path.join(root, directory));
  }

  let distTag;
  try { distTag = policy.distTagForVersion(rootPackage.version); } catch (error) { fail(error.message, rootPackage.version); }
  if (argv.includes("--dist-tag")) return { ok: true, code: "DIST_TAG_DERIVED", version: rootPackage.version, distTag };
  /* GITHUB_REF_NAME is set on every workflow run (branch pushes and PRs included), not just tag
   * pushes, so it must only be trusted as a release tag when GITHUB_REF_TYPE says the triggering
   * ref actually is a tag -- otherwise an ordinary branch push (e.g. "main") gets validated as if
   * it were a release tag and rejected by tag-format policy instead of taking the no-tag path. */
  const tag = env.RELEASE_TAG || (env.GITHUB_REF_TYPE === "tag" ? env.GITHUB_REF_NAME : undefined);
  const tagPolicy = policy.validateReleaseTag(rootPackage.version, tag, argv.includes("--allow-no-tag") || argv.includes("--sbom-only"));
  if (tagPolicy.code) fail(tagPolicy.code, { tag, version: rootPackage.version });

  if (!env.PREFLIGHT_ALLOW_DIRTY && !argv.includes("--sbom-only")) {
    const dirty = git(["status", "--porcelain", "--untracked-files=all"]).stdout.split(/\r?\n/).filter(Boolean).filter(line => !line.slice(3).startsWith("release-artifacts/"));
    if (dirty.length) fail("DIRTY_TREE", dirty);
  }
  const staged = git(["diff", "--cached", "--no-ext-diff", "--unified=0"]).stdout;
  if (policy.SECRET_PATTERN.test(staged)) fail("REPOSITORY_SECRET_REJECTED", "staged diff");
  try {
    const tracked = git(["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
    policy.inspectTrackedFiles(root, tracked);
  } catch (error) { fail(error.message.split(":")[0], error.message); }

  io.mkdirSync(artifacts, { recursive: true });
  for (const [name, directory] of [["root", root], ["installer", path.join(root, "packages/installer")]]) {
    const result = commands.sbom ? commands.sbom(name, directory) : env.PREFLIGHT_SBOM_FIXTURE
      ? { status: 0, stdout: io.readFileSync(env.PREFLIGHT_SBOM_FIXTURE, "utf8") }
      : execute("npm", ["sbom", "--sbom-format", "cyclonedx"], { cwd: directory });
    if (result.status !== 0) fail("SBOM_GENERATION_FAILED", result.stderr);
    let document;
    try { document = JSON.parse(result.stdout); } catch { fail("SBOM_INVALID_JSON", name); }
    if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(document.serialNumber || "")) document.serialNumber = `urn:uuid:${randomUUID()}`;
    else document.serialNumber = document.serialNumber.toLowerCase();
    if (!policy.validateCycloneDx(document)) fail("SBOM_SCHEMA_INVALID", name);
    io.writeFileSync(path.join(artifacts, `${name}.cdx.json`), JSON.stringify(document, null, 2) + "\n");
  }

  if (!argv.includes("--sbom-only")) {
    for (const [key, cmd, args, code] of [["generated", "npm", ["run", "verify:generated"], "GENERATED_CHECK_FAILED"], ["audit", "npm", ["audit", "--audit-level=high"], "AUDIT_POLICY_FAILED"]]) {
      const result = commands[key] ? commands[key]() : execute(env[`PREFLIGHT_${code}_COMMAND`] || cmd, env[`PREFLIGHT_${code}_COMMAND`] ? [] : args);
      if (result.status !== 0) fail(code, result.stderr || result.stdout);
    }
    for (const [kind, packagePath, packageRoot] of [["root", ".", root], ["installer", "./packages/installer", path.join(root, "packages/installer")]]) {
      const code = kind === "root" ? "ROOT_PACK_FAILED" : "INSTALLER_PACK_FAILED";
      const result = commands.pack ? commands.pack(kind, packagePath) : execute("npm", ["pack", packagePath, "--dry-run", "--json"]);
      if (result.status !== 0) fail(code, result.stderr);
      try { const [pack] = JSON.parse(result.stdout); policy.inspectInventory(pack, packageRoot, kind); } catch (error) { fail(error.message.split(":")[0], error.message); }
    }
  }
  return { ok: true, code: "RELEASE_PREFLIGHT_PASSED", version: rootPackage.version, distTag, warnings: tag ? [] : ["NO_RELEASE_TAG"], artifacts: ["root.cdx.json", "installer.cdx.json"] };
}

function runCli() {
  try { console.log(JSON.stringify(runPreflight(path.resolve(__dirname, "..")))); }
  catch (error) {
    const result = error instanceof PreflightFailure ? { ok: false, code: error.code, details: error.details } : { ok: false, code: "PREFLIGHT_INTERNAL_ERROR", details: error.message };
    console.error(JSON.stringify(result)); process.exitCode = 1;
  }
}

if (require.main === module) runCli();
module.exports = { PreflightFailure, runPreflight, runCli };
