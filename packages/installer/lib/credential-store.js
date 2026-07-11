const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Credential stores deliberately separate secret transport from installer
   plans. References contain only stable identity and a one-way fingerprint;
   plaintext is available only through an explicitly selected env/config store. */
function secretOf(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") throw new TypeError("credential must be a string or object");
  const secret = value.value ?? value.secret ?? value.token ?? value.credential ?? value.apiKey ?? value.key;
  if (typeof secret !== "string" || !secret) throw new TypeError("credential secret is required");
  return secret;
}

function identity(value, options = {}) {
  const object = value && typeof value === "object" ? value : {};
  return {
    service: String(object.service || options.service || "token-optimizer"),
    account: String(object.account || options.account || os.userInfo().username),
  };
}

function reference(store, value, options = {}) {
  const id = identity(value, options);
  return { store, service: id.service, account: id.account, fingerprint: `sha256:${crypto.createHash("sha256").update(secretOf(value)).digest("hex")}` };
}

function environmentReferenceStore(options = {}) {
  const env = options.env || process.env;
  const variable = options.envVar || "TOKEN_OPTIMIZER_CREDENTIAL";
  return {
    isAvailable: () => true,
    set(value) { env[variable] = secretOf(value); return reference("env", value, options); },
    get() { return env[variable] || null; },
    delete() { delete env[variable]; return true; },
  };
}

function protectedConfigStore(options = {}) {
  const filePath = path.resolve(options.path || path.join(options.home || os.homedir(), ".token-optimizer", "credentials.json"));
  const read = () => { try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } };
  return {
    isAvailable: () => true,
    set(value) {
      const data = read(); const id = identity(value, options); data[`${id.service}:${id.account}`] = secretOf(value);
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600); return reference("config", value, options);
    },
    get(value = {}) { const id = identity(value, options); return read()[`${id.service}:${id.account}`] || null; },
    delete(value = {}) { const data = read(); const id = identity(value, options); delete data[`${id.service}:${id.account}`]; if (fs.existsSync(filePath)) fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); return true; },
  };
}

function nativeStoreForPlatform(platform, options) {
  if (platform === "darwin") return require("./credential-store-macos").createMacOSCredentialStore(options);
  if (platform === "linux") return require("./credential-store-linux").createLinuxCredentialStore(options);
  if (platform === "win32") return require("./credential-store-windows").createWindowsCredentialStore(options);
  return { isAvailable: () => false };
}

function createCredentialStore(kind, options = {}) {
  if (kind === "env") return environmentReferenceStore(options);
  if (kind === "config" || kind === "protected-config") return protectedConfigStore(options);
  if (kind !== "native") throw new Error(`unsupported credential store: ${kind}`);
  const native = nativeStoreForPlatform(options.platform || process.platform, options);
  if (!native.isAvailable()) {
    const unavailable = () => { throw new Error("Native credential store unavailable; choose env or config explicitly."); };
    return { isAvailable: () => false, set: unavailable, get: unavailable, delete: unavailable };
  }
  return native;
}

module.exports = { createCredentialStore, environmentReferenceStore, protectedConfigStore, reference, secretOf };
