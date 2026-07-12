const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { distTagForVersion, validateCycloneDx, inspectInventory } = require("./release-policy");
const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, process.env.RELEASE_ARTIFACT_DIR || "release-artifacts");
const run = (command, args, options = {}) => spawnSync(command, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32", ...options });
const fail = (code, details) => { console.error(JSON.stringify({ ok: false, code, details })); process.exit(1); };

/*
 * Release checks are deterministic and emit a single machine-readable result;
 * environment seams allow tests to replace network-dependent audit and SBOM calls.
 */
const rootPackage = require(path.join(root, "package.json"));
const installerPackage = require(path.join(root, "packages/installer/package.json"));
if (rootPackage.version !== installerPackage.version) fail("VERSION_MISMATCH", [rootPackage.version, installerPackage.version]);
const lock = require(path.join(root, "package-lock.json"));
if (lock.version !== rootPackage.version || lock.packages?.[""]?.version !== rootPackage.version) fail("VERSION_MISMATCH", "package-lock.json");
for (const file of ["src/index.ts", ...["antigravity", "claude", "codex", "opencode", "cursor"].map(name => `scripts/generate-plugin-${name}.js`)]) {
  if (!fs.readFileSync(path.join(root, file), "utf8").includes(rootPackage.version)) fail("VERSION_MISMATCH", file);
}
for (const directory of ["plugin/claude", "plugin/codex", "packages/installer/assets", ".claude-plugin", ".agents/plugins"]) {
  const walk = current => { for (const entry of fs.readdirSync(current, { withFileTypes: true })) { const file = path.join(current, entry.name); if (entry.isDirectory()) walk(file); else if (/\.(?:json|js|md)$/.test(entry.name)) { const content = fs.readFileSync(file, "utf8"); const versions = content.match(/2\.0\.0-(?:alpha|beta|rc)\.\d+/g) || []; if (versions.some(version => version !== rootPackage.version)) fail("VERSION_MISMATCH", path.relative(root, file)); } } };
  walk(path.join(root, directory));
}
const tag = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME;
const distTag = (() => { try { return distTagForVersion(rootPackage.version); } catch (error) { fail(error.message, rootPackage.version); } })();
if (process.argv.includes("--dist-tag")) { console.log(JSON.stringify({ ok: true, code: "DIST_TAG_DERIVED", version: rootPackage.version, distTag })); process.exit(0); }
if (!tag && !process.argv.includes("--allow-no-tag") && !process.argv.includes("--sbom-only")) fail("TAG_REQUIRED", null);
if (tag && tag !== `v${rootPackage.version}`) fail("TAG_VERSION_MISMATCH", { tag, version: rootPackage.version });
if (tag && !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(tag)) fail("TAG_POLICY_REJECTED", tag);
if (!process.env.PREFLIGHT_ALLOW_DIRTY && !process.argv.includes("--sbom-only")) {
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=all"]).stdout.split(/\r?\n/).filter(Boolean).filter(line => !line.slice(3).startsWith("release-artifacts/"));
  if (dirty.length) fail("DIRTY_TREE", dirty);
}
const trackedDiff = run("git", ["diff", "--cached", "--no-ext-diff", "--unified=0"]).stdout;
if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp|github_pat|sk|npm)_[A-Za-z0-9_-]{16,}/.test(trackedDiff)) fail("REPOSITORY_SECRET_REJECTED", "staged diff");
fs.mkdirSync(artifacts, { recursive: true });
for (const [name, dir] of [["root", root], ["installer", path.join(root, "packages/installer")]]) {
  const output = path.join(artifacts, `${name}.cdx.json`);
  const result = process.env.PREFLIGHT_SBOM_FIXTURE
    ? { status: 0, stdout: fs.readFileSync(process.env.PREFLIGHT_SBOM_FIXTURE, "utf8") }
    : spawnSync("npm", ["sbom", "--sbom-format", "cyclonedx"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" });
  if (result.status !== 0) fail("SBOM_GENERATION_FAILED", result.stderr);
  let document; try { document = JSON.parse(result.stdout); } catch { fail("SBOM_INVALID_JSON", name); }
  if (!validateCycloneDx(document)) fail("SBOM_SCHEMA_INVALID", name);
  fs.writeFileSync(output, JSON.stringify(document, null, 2) + "\n");
}
if (!process.argv.includes("--sbom-only")) {
  for (const [cmd, args, code] of [["npm", ["run", "verify:generated"], "GENERATED_CHECK_FAILED"], ["npm", ["audit", "--audit-level=high"], "AUDIT_POLICY_FAILED"]]) {
    const result = run(process.env[`PREFLIGHT_${code}_COMMAND`] || cmd, process.env[`PREFLIGHT_${code}_COMMAND`] ? [] : args);
    if (result.status !== 0) fail(code, result.stderr || result.stdout);
  }
  for (const [kind, packagePath, packageRoot] of [["root", ".", root], ["installer", "./packages/installer", path.join(root, "packages/installer")]]) {
    const result = run("npm", ["pack", packagePath, "--dry-run", "--json"]);
    if (result.status !== 0) fail(`${kind.toUpperCase()}_PACK_FAILED`, result.stderr);
    let pack; try { [pack] = JSON.parse(result.stdout); inspectInventory(pack, packageRoot, kind); } catch (error) { fail(error.message.split(":")[0], error.message); }
  }
}
console.log(JSON.stringify({ ok: true, code: "RELEASE_PREFLIGHT_PASSED", version: rootPackage.version, distTag, warnings: tag ? [] : ["NO_RELEASE_TAG"], artifacts: ["root.cdx.json", "installer.cdx.json"] }));
