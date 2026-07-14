const fs = require("fs");
const os = require("os");
const path = require("path");

/* Ownership is persisted separately from installer execution so a later run
   can distinguish files it owns from user edits. Replacement is atomic and
   permissions are private because the manifest contains filesystem metadata. */
const SCHEMA_VERSION = 3;
const RUNTIME_SEGMENTS = new Set(["node_modules", ".data", ".cache", "cache", "logs", ".codex-local-test-runs"]);
const RUNTIME_BASENAMES = new Set(["analytics.json", "analytics-summary.json", "baseline.json", "registry.json"]);
function manifestPath(home) { return path.join(path.resolve(home || process.env.HOME || os.homedir()), ".token-optimizer", "manifest.json"); }

function validateManifest(manifest, home) {
  if (!manifest || ![2, SCHEMA_VERSION].includes(manifest.schemaVersion) || !Array.isArray(manifest.files)) {
    throw new Error(`invalid ownership manifest schema (expected 2 or ${SCHEMA_VERSION})`);
  }
  if (!Array.isArray(manifest.roots) || manifest.roots.length === 0 || manifest.roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("manifest requires absolute allowed roots");
  const roots = manifest.roots.map((root) => path.resolve(root));
  const rootRealpaths = roots.map((root) => realpathWithMissingTail(root));
  const assetRoots = manifest.assetRoots === undefined ? [] : manifest.assetRoots;
  if (!Array.isArray(assetRoots) || assetRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("manifest assetRoots require absolute paths");
  const canonicalAssets = assetRoots.map((root) => realpathWithMissingTail(root));
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || !path.isAbsolute(file.path) || file.path.includes("\0") || file.path.split(path.sep).includes("..")) {
      throw new Error("manifest contains an invalid path");
    }
    const resolved = path.resolve(file.path);
    const canonical = realpathWithMissingTail(resolved);
    if (!rootRealpaths.some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))) throw new Error(`manifest path outside known roots: ${file.path}`);
    if (typeof file.sha256 !== "string" || typeof file.ownership !== "string") throw new Error("manifest file entries require sha256 and ownership");
    if (file.source !== undefined) {
      if (typeof file.source !== "string" || !path.isAbsolute(file.source)) throw new Error("manifest source must be absolute");
      const source = realpathWithMissingTail(file.source);
      if (!canonicalAssets.some((root) => source === root || source.startsWith(`${root}${path.sep}`))) throw new Error("manifest source outside assetRoots");
    }
    if (file.assetPath !== undefined && (typeof file.assetPath !== "string" || path.isAbsolute(file.assetPath) || file.assetPath.split(/[\\/]/).includes(".."))) throw new Error("manifest assetPath must be package-relative");
  }
  if (manifest.cleanupPaths !== undefined) {
    if (!Array.isArray(manifest.cleanupPaths)) throw new Error("manifest cleanupPaths must be an array");
    for (const cleanupPath of manifest.cleanupPaths) {
      if (typeof cleanupPath !== "string" || !path.isAbsolute(cleanupPath) || cleanupPath.includes("\0")) throw new Error("manifest cleanup path must be absolute");
      const canonical = realpathWithMissingTail(cleanupPath);
      if (!rootRealpaths.some((root) => canonical === root || canonical.startsWith(`${root}${path.sep}`))) throw new Error(`manifest cleanup path outside known roots: ${cleanupPath}`);
    }
  }
  if (manifest.credentials !== undefined && (!Array.isArray(manifest.credentials) || manifest.credentials.some((item) => !item || item.ownership !== "installer" || !item.reference || typeof item.reference.store !== "string"))) {
    throw new Error("manifest credentials require installer ownership and a store reference");
  }
  return manifest;
}

/* Only files that can be restored byte-for-byte from packaged assets belong in
   the ownership manifest. Dependency caches and runtime output are disposable
   state and must never become uninstall authority. */
function isSourceRepairableFile(file, assetRoots = []) {
  if (!file || typeof file.path !== "string" || (typeof file.source !== "string" && typeof file.assetPath !== "string")) return false;
  const segments = path.resolve(file.path).split(path.sep);
  if (segments.some((segment) => RUNTIME_SEGMENTS.has(segment)) || RUNTIME_BASENAMES.has(path.basename(file.path)) || /\.(?:log|tmp|cache)$/i.test(file.path)) return false;
  if (file.assetPath) return !path.isAbsolute(file.assetPath) && !file.assetPath.split(/[\\/]/).includes("..");
  const source = path.resolve(file.source);
  return assetRoots.some((root) => source === root || source.startsWith(`${root}${path.sep}`));
}

function compactManifest(manifest) {
  const assetRoots = (manifest.assetRoots || []).filter((root) => typeof root === "string" && path.isAbsolute(root)).map((root) => path.resolve(root));
  const files = (manifest.files || []).filter((file) => isSourceRepairableFile(file, assetRoots));
  return { manifest: { ...manifest, files }, removedEntries: (manifest.files || []).length - files.length };
}

function realpathWithMissingTail(target) {
  let current = path.resolve(target); const tail = [];
  while (!fs.existsSync(current)) { const parent = path.dirname(current); if (parent === current) break; tail.unshift(path.basename(current)); current = parent; }
  let resolved = fs.realpathSync.native(current);
  for (const part of tail) resolved = path.join(resolved, part);
  return resolved;
}

function ensurePrivate(filePath) {
  const directory = path.dirname(filePath);
  if (process.platform !== "win32") {
    fs.chmodSync(directory, 0o700);
    if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
    if ((fs.statSync(directory).mode & 0o777) !== 0o700 || (fs.existsSync(filePath) && (fs.statSync(filePath).mode & 0o777) !== 0o600)) throw new Error("ownership manifest permissions are not private");
  }
}

function writeManifest(home, manifest) {
  const filePath = manifestPath(home);
  const validated = validateManifest(manifest, home);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  ensurePrivate(filePath);
  fs.writeFileSync(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(tempPath, 0o600); } catch { /* best effort on Windows */ }
  fs.renameSync(tempPath, filePath);
  return filePath;
}

function readManifest(home) {
  const filePath = manifestPath(home);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { if (error && error.code === "ENOENT") return null; throw new Error(`unable to read ownership manifest: ${error.message}`); }
  const result = validateManifest(parsed, home);
  ensurePrivate(filePath);
  return result;
}

module.exports = { SCHEMA_VERSION, manifestPath, validateManifest, writeManifest, readManifest, isSourceRepairableFile, compactManifest };
