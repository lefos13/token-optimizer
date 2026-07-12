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

function validateCycloneDx(document) {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "schemas", "cyclonedx-1.6-release.schema.json"), "utf8"));
  const ajv = new Ajv({ strict: true }); addFormats(ajv);
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
    if (!absolute.startsWith(path.resolve(packageRoot) + path.sep) || !fs.existsSync(absolute) || fs.statSync(absolute).size > 1024 * 1024) continue;
    if (secret.test(fs.readFileSync(absolute, "utf8"))) throw new Error(`PACKAGE_SECRET_REJECTED:${kind}:${file}`);
  }
}

module.exports = { DIST_TAGS, distTagForVersion, validateCycloneDx, inspectInventory };
