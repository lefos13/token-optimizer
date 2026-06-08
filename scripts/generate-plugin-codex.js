const fs = require("fs");
const path = require("path");

/* Codex plugin flow.
   Generates a complete, installable, portable Codex plugin under plugin/codex/.
   The repo-root marketplace catalog lets Codex discover the generated plugin
   from this repository, while the plugin itself bundles the compiled MCP server
   and launches a self-locating script from the plugin root.

   Output layout:
     .agents/plugins/marketplace.json              (REPO-ROOT marketplace catalog)
     plugin/codex/.codex-plugin/plugin.json        (plugin manifest)
     plugin/codex/.mcp.json                        (registers the local_tester server)
     plugin/codex/server/*.js                      (compiled server, copied from dist/)
     plugin/codex/server/package.json              (single runtime dep to install)
     plugin/codex/server/start.sh                  (installs deps + execs server)
     plugin/codex/skills/local-llm-subagent/SKILL.md
     plugin/codex/README.md
   Do not edit generated files by hand; run npm run build:plugin:codex. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "codex");
const metaDir = path.join(pluginDir, ".codex-plugin");
const repoMarketplaceDir = path.join(rootDir, ".agents", "plugins");
const PLUGIN_SOURCE_PATH = "./plugin/codex";
const SKILL_NAME = "local-llm-subagent";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
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

console.log("Generating Codex plugin structure...");

try {
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(repoMarketplaceDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const VERSION = "1.0.3";

  const sdkVersion = require(
    path.join(
      rootDir,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "package.json",
    ),
  ).version;

  const description =
    "Local test execution, verification, and local-LLM triage. Runs validation commands in a workspace, keeps raw logs out of context, and returns compact verdicts via the local_tester MCP server.";

  const pluginJson = {
    name: "local-tester",
    version: VERSION,
    description,
    author: { name: "Lefos13" },
    license: "Apache-2.0",
    keywords: ["local-test", "mcp", "verdict", "triage", "validation"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "Local Tester",
      shortDescription: "Run local validation and summarize logs with a local LLM.",
      longDescription:
        "Validate code changes, triage failures, review changed files, check regressions, digest noisy commands, and scout codebases without flooding the conversation with raw logs.",
      developerName: "Lefos13",
      category: "Productivity",
      capabilities: ["Read", "Run"],
      defaultPrompt: [
        "Use Local Tester to validate my current code changes.",
        "Use Local Tester to triage the failing test log.",
      ],
      brandColor: "#10A37F",
    },
  };
  fs.writeFileSync(
    path.join(metaDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );

  const marketplaceJson = {
    name: "local-tester-marketplace",
    interface: {
      displayName: "Local Tester Marketplace",
    },
    plugins: [
      {
        name: "local-tester",
        source: {
          source: "local",
          path: PLUGIN_SOURCE_PATH,
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  };
  fs.writeFileSync(
    path.join(repoMarketplaceDir, "marketplace.json"),
    JSON.stringify(marketplaceJson, null, 2) + "\n",
  );

  const mcpJson = {
    mcp_servers: {
      local_tester: {
        command: "./server/start.sh",
        env: {
          LOCAL_LLM_API_URL: "http://localhost:8080/v1",
          LOCAL_LLM_MODEL: "local-model",
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(pluginDir, ".mcp.json"),
    JSON.stringify(mcpJson, null, 2) + "\n",
  );

  for (const file of SERVER_FILES) {
    const src = path.join(distDir, file);
    if (!fs.existsSync(src)) {
      console.error(
        `Error: compiled server file missing: ${src}. Run \`npm run build\` first.`,
      );
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

  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}}"
DATA="\${PLUGIN_DATA:-\${CLAUDE_PLUGIN_DATA:-$ROOT/.data}}"
mkdir -p "$DATA"

# (Re)install runtime deps only when the manifest changes. Output goes to
# stderr/null so stdout stays a clean JSON-RPC channel.
if ! diff -q "$ROOT/server/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  cp "$ROOT/server/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
fi

export NODE_PATH="$DATA/node_modules"
exec node "$ROOT/server/index.js"
`;
  const startShPath = path.join(serverDir, "start.sh");
  fs.writeFileSync(startShPath, startSh);
  fs.chmodSync(startShPath, 0o755);

  const sourceSkill = path.join(rootDir, "skill", "skill-example.md");
  const destSkill = path.join(skillsDir, "SKILL.md");
  if (!fs.existsSync(sourceSkill)) {
    console.error(`Error: Source skill file not found at ${sourceSkill}`);
    process.exit(1);
  }
  fs.copyFileSync(sourceSkill, destSkill);

  const readme = `# local-tester plugin (Codex)

Bundles the \`local_tester\` MCP server and the \`${SKILL_NAME}\` skill so Codex
can validate code changes, triage failures, review changed files, check
regressions, digest noisy commands, and scout code without flooding chat context
with raw logs.

> Generated by \`npm run build:plugin:codex\`. Do not edit files under \`plugin/\` by hand.

## Contents

- \`.codex-plugin/plugin.json\` - plugin manifest (\`local-tester\` v${VERSION}).
- \`.mcp.json\` - registers the \`local_tester\` stdio server via Codex's documented \`mcp_servers\` wrapper.
- \`server/\` - the compiled MCP server plus a launcher (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` - usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs

\`.mcp.json\` uses the documented top-level \`mcp_servers\` object and launches
\`./server/start.sh\` from the plugin root. On first run the launcher installs
\`@modelcontextprotocol/sdk\` into the plugin data directory when Codex provides
one, or into a local \`.data/\` fallback beside the plugin. No absolute repo paths
are baked in, so the plugin remains portable after Codex installs it into its
cache.

Requirements on the target machine: \`node\` and \`npm\` on \`PATH\`, plus network
access the first time so npm can install the runtime dependency. After that it
runs offline.

## LLM configuration

A local OpenAI-compatible LLM endpoint is expected. Defaults:
\`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`.
Optional per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`,
\`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`,
\`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`,
\`LOCAL_LLM_QUERY_MODEL\`.

## Install

The marketplace catalog lives at the repository root:
\`.agents/plugins/marketplace.json\`. Add the repository as a marketplace, then
install or enable the \`local-tester\` plugin from Codex.

\`\`\`bash
codex plugin marketplace add /path/to/local-tester-mcp
\`\`\`

For local development without marketplace installation, load \`${pluginDir}\`
directly if your Codex surface supports direct plugin paths.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Codex plugin generated successfully under plugin/codex/");
} catch (error) {
  console.error("Failed to generate Codex plugin:", error);
  process.exit(1);
}
