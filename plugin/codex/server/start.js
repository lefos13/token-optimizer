#!/usr/bin/env node
/* Cross-platform launcher for the bundled token_optimizer MCP server.
   Installs runtime dependencies into a persistent data dir on first run, when
   server/package.json changes, or when the cache is incomplete. stdout is the
   JSON-RPC channel, so all npm output is routed to stderr. */
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

/* start.js always sits in the same directory as index.js and package.json,
   in every bundle layout, so everything resolves from __dirname. */
const data =
  process.env.CLAUDE_PLUGIN_DATA ||
  process.env.PLUGIN_DATA ||
  process.env.ANTIGRAVITY_PLUGIN_DATA ||
  path.join(__dirname, ".data");
fs.mkdirSync(data, { recursive: true });

const manifest = fs.readFileSync(path.join(__dirname, "package.json"), "utf8");
const manifestDest = path.join(data, "package.json");

/* A matching manifest and node_modules directory do not prove npm completed.
   Resolve the entries used at runtime so partial extraction is repaired. */
function dependenciesResolve() {
  try {
    require.resolve("@modelcontextprotocol/sdk/server/index.js", { paths: [data] });
    require.resolve("zod/v3", { paths: [data] });
    return true;
  } catch {
    return false;
  }
}

const upToDate =
  fs.existsSync(manifestDest) &&
  fs.readFileSync(manifestDest, "utf8") === manifest &&
  dependenciesResolve();

if (!upToDate) {
  fs.rmSync(path.join(data, "node_modules"), { recursive: true, force: true });
  fs.writeFileSync(manifestDest, manifest);
  /* npm is npm.cmd on Windows and cannot be spawned without a shell there.
     The whole command is one fixed string (no interpolated args), which also
     avoids DEP0190. */
  const npmArgs = ["install", "--omit=dev", "--no-audit", "--no-fund"];
  const result = process.platform === "win32"
    ? spawnSync("npm " + npmArgs.join(" "), { cwd: data, stdio: ["ignore", 2, 2], shell: true })
    : spawnSync("npm", npmArgs, { cwd: data, stdio: ["ignore", 2, 2] });
  if (result.status !== 0) {
    console.error("token-optimizer launcher: npm install failed in " + data);
    process.exit(1);
  }
  if (!dependenciesResolve()) {
    console.error("token-optimizer launcher: runtime dependencies remain invalid after npm install in " + data);
    process.exit(1);
  }
}

const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
  stdio: "inherit",
  env: { ...process.env, NODE_PATH: path.join(data, "node_modules") },
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code == null ? 1 : code));
child.on("error", (error) => {
  console.error("token-optimizer launcher: " + error.message);
  process.exit(1);
});
