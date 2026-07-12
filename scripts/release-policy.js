const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const ALLOWED_PRERELEASES = new Set(["alpha", "beta", "rc"]);
const DIST_TAGS = new Set(["latest", ...ALLOWED_PRERELEASES]);

function distTagForVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(version);
  if (!match || (match[4] && !ALLOWED_PRERELEASES.has(match[4]))) throw new Error("TAG_POLICY_REJECTED");
  return match[4] || "latest";
}

function validateReleaseTag(version, tag, allowNoTag = false) {
  if (!tag) return allowNoTag ? { distTag: distTagForVersion(version), warning: "NO_RELEASE_TAG" } : { code: "TAG_REQUIRED" };
  let distTag; try { distTag = distTagForVersion(version); } catch (error) { return { code: error.message }; }
  if (!/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(tag)) return { code: "TAG_POLICY_REJECTED" };
  if (tag !== `v${version}`) return { code: "TAG_VERSION_MISMATCH" };
  return { distTag, warning: null };
}

function validateCycloneDx(document) {
  if (!document || !document.serialNumber || !Number.isInteger(document.version) || !document.metadata?.component) return false;
  const directory = path.join(__dirname, "schemas");
  const schema = JSON.parse(fs.readFileSync(path.join(directory, "bom-1.6.schema.json"), "utf8"));
  const referenced = ["jsf-0.82.schema.json", "spdx.schema.json"].map(file => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
  const ajv = new Ajv({ strict: false, schemas: referenced });
  addFormats(ajv);
  ajv.addFormat("iri-reference", true).addFormat("idn-email", true);
  return ajv.validate(schema, document);
}

function inspectInventory(pack, packageRoot, kind) {
  const required = kind === "root" ? ["LICENSE", "NOTICE", "README.md", "package.json", "dist/index.js"] : ["LICENSE", "NOTICE", "README.md", "package.json", "bin/token-optimizer.js"];
  const paths = pack.files.map(file => file.path);
  for (const file of required) if (!paths.includes(file)) throw new Error(`PACKAGE_REQUIRED_FILE_MISSING:${kind}:${file}`);
  const allowed = file => kind === "root" ? ["LICENSE", "NOTICE", "README.md", "package.json"].includes(file) || file.startsWith("dist/") : ["LICENSE", "NOTICE", "README.md", "package.json"].includes(file) || /^(assets|bin|lib)\//.test(file);
  const forbiddenPath = /(?:^|\/)(?:node_modules|\.env(?:\.|$)|\.codex-local-test-runs)(?:\/|$)|\.log$|(?:^|\/)(?:id_rsa|[^/]+\.pem)$/i;
  const secret = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp|github_pat|sk|npm)_[A-Za-z0-9_-]{16,}|\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\/;
  for (const file of paths) {
    if (!allowed(file) || forbiddenPath.test(file)) throw new Error(`PACKAGE_INVENTORY_REJECTED:${kind}:${file}`);
    const absolute = path.resolve(packageRoot, file);
    if (!absolute.startsWith(path.resolve(packageRoot) + path.sep) || !fs.existsSync(absolute)) continue;
    const content = fs.readFileSync(absolute);
    if (content.subarray(0, 8192).includes(0)) continue;
    if (content.length > 1024 * 1024) throw new Error(`PACKAGE_FILE_OVERSIZE:${kind}:${file}`);
    if (secret.test(content.toString("utf8"))) throw new Error(`PACKAGE_SECRET_REJECTED:${kind}:${file}`);
  }
}

const SECRET_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{32,})|(?:password|api[_-]?key|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{16,}["']/i;

function inspectTrackedFiles(root, tracked, readFile = fs.readFileSync, lstat = fs.lstatSync) {
  /* Test fixtures containing deliberate signatures are the only repository
   * exception; production and generated artifacts receive identical scanning. */
  const fixtureAllowlist = [/^test\/fixtures\/security\/(?:private-key|token-signatures)\.txt$/];
  for (const relative of tracked) {
    if (!relative || fixtureAllowlist.some(pattern => pattern.test(relative))) continue;
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(path.resolve(root) + path.sep)) throw new Error(`REPOSITORY_PATH_REJECTED:${relative}`);
    const stat = lstat(absolute); if (stat.isSymbolicLink()) throw new Error(`REPOSITORY_SYMLINK_REJECTED:${relative}`);
    if (!stat.isFile() || stat.size > 1024 * 1024) continue;
    const buffer = readFile(absolute); if (buffer.subarray(0, 8192).includes(0)) continue;
    if (SECRET_PATTERN.test(buffer.toString('utf8'))) throw new Error(`REPOSITORY_SECRET_REJECTED:${relative}`);
  }
}

module.exports = { DIST_TAGS, SECRET_PATTERN, distTagForVersion, validateReleaseTag, validateCycloneDx, inspectInventory, inspectTrackedFiles };
