/* Change plans are the installer’s side-effect-free contract. They contain
   declarative operations only, are deeply frozen before being returned, and
   redact values that could accidentally turn a preview into a secret store. */
const OPERATION_KINDS = Object.freeze([
  "create-directory", "write-file", "copy-tree", "managed-block",
  "client-command", "credential", "platform-service",
]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeOperation(operation) {
  if (!operation || typeof operation !== "object") throw new TypeError("operation must be an object");
  if (!OPERATION_KINDS.includes(operation.kind)) throw new TypeError(`unsupported operation kind: ${operation.kind}`);
  const copy = sanitizeObject(operation, operation.kind === "credential");
  if (operation.kind === "credential") {
    for (const key of Object.keys(copy)) {
      if (!["kind", "provider", "reference", "fingerprint"].includes(key)) delete copy[key];
    }
  }
  return copy;
}

function sanitizeObject(value, credentialScope = false) {
  if (Array.isArray(value)) return value.map((child) => sanitizeObject(child, credentialScope));
  if (!value || typeof value !== "object") return typeof value === "string" && /sk-or-|bearer\s|api[_-]?key|secret/i.test(value) ? undefined : value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key|private[_-]?key|contents|value/i.test(key)) continue;
    const clean = sanitizeObject(child, credentialScope);
    if (clean !== undefined && (typeof clean !== "object" || clean !== null || Array.isArray(clean))) result[key] = clean;
  }
  return result;
}

function createChangePlan(metadata = {}, operations = []) {
  if (!Array.isArray(operations)) throw new TypeError("operations must be an array");
  const safeMetadata = sanitizeObject(metadata);
  const plan = { schemaVersion: 2, ...safeMetadata, operations: operations.map(safeOperation) };
  return deepFreeze(plan);
}

function formatChangePlan(plan, format = "human") {
  if (!plan || plan.schemaVersion !== 2 || !Array.isArray(plan.operations)) throw new TypeError("invalid change plan");
  if (format === "json" || format === "JSON") return JSON.stringify(plan, null, 2);
  const header = `Change plan v${plan.schemaVersion}${plan.version ? ` (${plan.version})` : ""}`;
  const lines = plan.operations.map((operation, index) => `${index + 1}. ${operation.kind}${operation.path ? `: ${operation.path}` : ""}`);
  return [header, ...lines].join("\n");
}

function operation(kind, fields = {}) { return safeOperation({ kind, ...fields }); }
const createDirectoryOperation = (path) => operation("create-directory", { path });
const writeFileOperation = (path, sha256) => operation("write-file", { path, sha256 });
const copyTreeOperation = (source, path) => operation("copy-tree", { source, path });
const managedBlockOperation = (path, marker) => operation("managed-block", { path, marker });
const clientCommandOperation = (client, command) => operation("client-command", { client, command });
const credentialOperation = (provider, details = {}) => operation("credential", { provider, ...details });
const platformServiceOperation = (platform, service) => operation("platform-service", { platform, service });

module.exports = {
  OPERATION_KINDS, createChangePlan, formatChangePlan, operation,
  createDirectoryOperation, writeFileOperation, copyTreeOperation,
  managedBlockOperation, clientCommandOperation, credentialOperation,
  platformServiceOperation,
};
