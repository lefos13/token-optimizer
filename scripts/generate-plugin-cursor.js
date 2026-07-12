const fs = require("fs");
const path = require("path");
const { buildStartJs } = require("./launcher-template");

/* Cursor plugin flow.
   Generates a portable token_optimizer bundle under plugin/cursor/ for Cursor
   (https://cursor.com). Cursor has no plugin/marketplace mechanism either —
   MCP servers are a static "mcpServers" block in mcp.json (global
   ~/.cursor/mcp.json or project .cursor/mcp.json), and standing agent
   guidance is a `.mdc` rule file under .cursor/rules/ (see
   cursor.com/docs/mcp and cursor.com/docs/rules). Cursor has no
   filesystem-writable *global* rule — only Settings-UI rules apply across
   every project — so this generator ships a project-scoped rule and documents
   that limitation rather than solving it.

   Output layout:
     plugin/cursor/server/*.js                 (compiled server, copied from dist/)
     plugin/cursor/server/package.json         (single runtime dep to install)
     plugin/cursor/server/start.sh             (self-locating launcher)
     plugin/cursor/rules/token-optimizer.mdc      (alwaysApply:true, project-scoped)
     plugin/cursor/mcp-snippet.json            (block to merge into mcp.json's "mcpServers")
     plugin/cursor/README.md
   This output is gitignored (see plugin/cursor/ in .gitignore) — like
   Antigravity and opencode, there is no marketplace to fetch it from.
   Do not edit generated files by hand; run `npm run build:plugin:cursor`. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "cursor");
const rulesDir = path.join(pluginDir, "rules");
const serverDir = path.join(pluginDir, "server");
const distDir = path.join(rootDir, "dist");

const SERVER_FILES = [
  "index.js",
  "analytics.js",
  "command-policy.js",
  "execution-metadata.js",
  "log-excerpt.js",
  "log-store.js",
  "process-tree.js",
  "detector.js",
  "llm.js",
  "providers.js",
  "llm-schemas.js",
  "redaction.js",
  "config.js",
  "registry.js",
  "runner.js",
  "types.js",
];

const installedServerDir = "${HOME}/.cursor/token-optimizer-server";

console.log("Generating Cursor plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const VERSION = "2.0.0-rc.4";

  const sdkVersion = require(
    path.join(rootDir, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
  ).version;

  for (const file of SERVER_FILES) {
    const src = path.join(distDir, file);
    if (!fs.existsSync(src)) {
      console.error(`Error: compiled server file missing: ${src}. Run \`npm run build\` first.`);
      process.exit(1);
    }
    fs.copyFileSync(src, path.join(serverDir, file));
  }

  const serverPackageJson = {
    name: "token-optimizer-server",
    version: VERSION,
    private: true,
    description: "Bundled token_optimizer MCP server (compiled).",
    main: "index.js",
    dependencies: {
      "@modelcontextprotocol/sdk": `^${sdkVersion}`,
    },
  };
  fs.writeFileSync(
    path.join(serverDir, "package.json"),
    JSON.stringify(serverPackageJson, null, 2) + "\n",
  );

  /* Preserve Cursor's flat, self-locating data path, then delegate cache
     validation and server startup to the shared launcher. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
export PLUGIN_DATA="$ROOT/.data"
exec node "$ROOT/start.js"
`;
  const startShPath = path.join(serverDir, "start.sh");
  fs.writeFileSync(startShPath, startSh);
  fs.chmodSync(startShPath, 0o755);

  /* Cross-platform launcher referenced by the MCP config (start.sh stays for
     POSIX scripting compatibility). */
  const startJsPath = path.join(serverDir, "start.js");
  fs.writeFileSync(startJsPath, buildStartJs());
  fs.chmodSync(startJsPath, 0o755);

  /* Same directive content as scripts/manage-gateway-config.js's
     DIRECTIVE_BLOCK, authored directly here since Cursor's rule format
     (.mdc frontmatter) differs from the Markdown-heading blocks written into
     CLAUDE.md/AGENTS.md/GEMINI.md. Keep the bullet list wording identical if
     that block's wording ever changes. */
  const ruleMdc = `---
alwaysApply: true
---

Always use the \`token_optimizer\` MCP tools by default:

- \`scout_codebase\` before broad exploration of an unfamiliar area.
- \`run_test_verdict\` before claiming a change works.
- \`run_failure_triage\` on test/build/lint failures instead of reading raw logs.
- \`run_regression_check\` before merging.
- \`run_changed_files_review\` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
`;
  fs.writeFileSync(path.join(rulesDir, "token-optimizer.mdc"), ruleMdc);

  const mcpSnippet = {
    mcpServers: {
      token_optimizer: {
        command: "node",
        args: [path.join(installedServerDir, "start.js")],
        env: {
          LLM_GATEWAY_URL: "${env:LLM_GATEWAY_URL}",
          LLM_GATEWAY_TOKEN: "${env:LLM_GATEWAY_TOKEN}",
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(pluginDir, "mcp-snippet.json"),
    JSON.stringify(mcpSnippet, null, 2) + "\n",
  );

  const readme = `# Token Optimizer bundle (Cursor)

Bundles the \`token_optimizer\` MCP server and a default-on usage rule for
[Cursor](https://cursor.com). Cursor has no plugin/marketplace mechanism, so
this bundle is installed by copying files and running the repo config manager.

> Generated by \`npm run build:plugin:cursor\`. Do not edit files under
> \`plugin/\` by hand. This output is gitignored — there is no marketplace to
> fetch it from, so nothing needs to be committed.

## Contents

- \`server/\` — the compiled MCP server plus a self-locating launcher
  (\`start.sh\`) and a minimal \`package.json\`.
- \`rules/token-optimizer.mdc\` — \`alwaysApply: true\` rule instructing the agent
  to use the \`token_optimizer\` tools by default.
- \`mcp-snippet.json\` — the block the config manager writes into your
  \`mcp.json\`'s \`"mcpServers"\` object, also useful for manual installs.

## Install

1. Copy the server bundle to a stable location:

   \`\`\`bash
   mkdir -p ~/.cursor/token-optimizer-server
   cp -R plugin/cursor/server/* ~/.cursor/token-optimizer-server/
   \`\`\`

2. Provide your gateway token from a repo clone:

   \`\`\`bash
   npm run gateway:config -- setup
   \`\`\`

   This writes the \`token_optimizer\` MCP block and gateway environment into
   \`~/.cursor/mcp.json\`. If you are not using the config manager, merge
   \`mcp-snippet.json\` manually into \`~/.cursor/mcp.json\` (global, applies to
   every project) or \`.cursor/mcp.json\` in a specific project.

3. Copy the rule into each project where you want it enforced:

   \`\`\`bash
   mkdir -p .cursor/rules
   cp plugin/cursor/rules/token-optimizer.mdc .cursor/rules/token-optimizer.mdc
   \`\`\`

   **Limitation:** Cursor has no filesystem-writable *global* rule — only
   rules added via Cursor Settings apply across every project. This \`.mdc\`
   file only takes effect in the project you copy it into. For a true
   cross-project default, add the same instruction as a rule in Cursor
   Settings manually.

4. Restart Cursor (or reload the window) so it picks up the new MCP server
   and rule.

**Requirements:** \`node\` and \`npm\` on \`PATH\`; network access on
first run only.

To pick up changes, re-run \`npm run build:plugin:cursor\`, re-copy the
\`server/\` contents, re-run \`npm run gateway:config -- setup\` if the MCP
config shape changed, and re-copy \`rules/token-optimizer.mdc\` into each
project using it.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Cursor plugin generated successfully under plugin/cursor/");
} catch (error) {
  console.error("Failed to generate Cursor plugin:", error);
  process.exit(1);
}
