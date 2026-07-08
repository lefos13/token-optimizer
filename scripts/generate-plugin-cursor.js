const fs = require("fs");
const path = require("path");
const os = require("os");

/* Cursor plugin flow.
   Generates a portable local_tester bundle under plugin/cursor/ for Cursor
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
     plugin/cursor/rules/local-tester.mdc      (alwaysApply:true, project-scoped)
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
  "detector.js",
  "llm.js",
  "registry.js",
  "runner.js",
  "types.js",
];

const installedServerDir = path.join(os.homedir(), ".cursor", "local-tester-server");

console.log("Generating Cursor plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const VERSION = "1.5.0";

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
    name: "local-tester-server",
    version: VERSION,
    private: true,
    description: "Bundled local_tester MCP server (compiled).",
    main: "index.js",
    dependencies: {
      "@modelcontextprotocol/sdk": `^${sdkVersion}`,
    },
  };
  fs.writeFileSync(
    path.join(serverDir, "package.json"),
    JSON.stringify(serverPackageJson, null, 2) + "\n",
  );

  /* Flat path structure as required by Task 3 instructions. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DATA="$ROOT/.data"
mkdir -p "$DATA"

if ! diff -q "$ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cp "$ROOT/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
fi

export NODE_PATH="$DATA/node_modules"
exec node "$ROOT/index.js"
`;
  const startShPath = path.join(serverDir, "start.sh");
  fs.writeFileSync(startShPath, startSh);
  fs.chmodSync(startShPath, 0o755);

  /* Same directive content as scripts/manage-gateway-config.js's
     DIRECTIVE_BLOCK, authored directly here since Cursor's rule format
     (.mdc frontmatter) differs from the Markdown-heading blocks written into
     CLAUDE.md/AGENTS.md/GEMINI.md. Keep the bullet list wording identical if
     that block's wording ever changes. */
  const ruleMdc = `---
alwaysApply: true
---

Always use the \`local_tester\` MCP tools by default:

- \`scout_codebase\` before broad exploration of an unfamiliar area.
- \`run_test_verdict\` before claiming a change works.
- \`run_failure_triage\` on test/build/lint failures instead of reading raw logs.
- \`run_regression_check\` before merging.
- \`run_changed_files_review\` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
`;
  fs.writeFileSync(path.join(rulesDir, "local-tester.mdc"), ruleMdc);

  const mcpSnippet = {
    mcpServers: {
      local_tester: {
        command: "bash",
        args: [path.join(installedServerDir, "start.sh")],
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

  const readme = `# local-tester bundle (Cursor)

Bundles the \`local_tester\` MCP server and a default-on usage rule for
[Cursor](https://cursor.com). Cursor has no plugin/marketplace mechanism, so
this bundle is installed by copying files and merging one JSON snippet by
hand.

> Generated by \`npm run build:plugin:cursor\`. Do not edit files under
> \`plugin/\` by hand. This output is gitignored — there is no marketplace to
> fetch it from, so nothing needs to be committed.

## Contents

- \`server/\` — the compiled MCP server plus a self-locating launcher
  (\`start.sh\`) and a minimal \`package.json\`.
- \`rules/local-tester.mdc\` — \`alwaysApply: true\` rule instructing the agent
  to use the \`local_tester\` tools by default.
- \`mcp-snippet.json\` — the exact block to merge into your \`mcp.json\`'s
  \`"mcpServers"\` object.

## Install

1. Copy the server bundle to a stable location:

   \`\`\`bash
   mkdir -p ~/.cursor/local-tester-server
   cp -R plugin/cursor/server/* ~/.cursor/local-tester-server/
   \`\`\`

2. Merge the contents of \`mcp-snippet.json\` into \`~/.cursor/mcp.json\`
   (global, applies to every project) or \`.cursor/mcp.json\` in a specific
   project (create the file with \`{"mcpServers": {}}\` first if it does not
   exist).

3. Copy the rule into each project where you want it enforced:

   \`\`\`bash
   mkdir -p .cursor/rules
   cp plugin/cursor/rules/local-tester.mdc .cursor/rules/local-tester.mdc
   \`\`\`

   **Limitation:** Cursor has no filesystem-writable *global* rule — only
   rules added via Cursor Settings apply across every project. This \`.mdc\`
   file only takes effect in the project you copy it into. For a true
   cross-project default, add the same instruction as a rule in Cursor
   Settings manually.

4. Provide your gateway token: from a repo clone run
   \`npm run gateway:config -- setup\` and paste your token (it is written to
   the macOS GUI session via \`launchctl\`, which Cursor inherits), or set
   \`LLM_GATEWAY_TOKEN\` / \`LLM_GATEWAY_URL\` in your own shell/session
   environment before launching Cursor.

5. Restart Cursor (or reload the window) so it picks up the new MCP server
   and rule.

**Requirements:** \`node\`, \`npm\`, and \`bash\` on \`PATH\`; network access on
first run only.

To pick up changes, re-run \`npm run build:plugin:cursor\`, re-copy the
\`server/\` contents, re-merge \`mcp-snippet.json\` if it changed, and re-copy
\`rules/local-tester.mdc\` into each project using it.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Cursor plugin generated successfully under plugin/cursor/");
} catch (error) {
  console.error("Failed to generate Cursor plugin:", error);
  process.exit(1);
}
