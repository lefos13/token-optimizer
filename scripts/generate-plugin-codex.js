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

  const VERSION = "1.0.10";

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
      shortDescription:
        "Run local validation and summarize logs with a local LLM.",
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
    name: "Softaware-marketplace",
    interface: {
      displayName: "Softaware Marketplace",
    },
    plugins: [
      {
        /* MUST equal the manifest name in .codex-plugin/plugin.json. Codex
           resolves the plugin by this entry name, then opens the source path
           and reads plugin.json; a name mismatch fails the install. */
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

  /* Launch the bundled launcher through `bash -c` so the SHELL expands the
     plugin-root variable at runtime. Codex spawns MCP servers from the
     project working directory, not the plugin root, so a bare relative
     command ("./server/start.sh") is never found and the server fails to
     start (its tools then never appear in a thread). Passing a plain
     "${PLUGIN_ROOT}/server/start.sh" arg is also fragile: Codex only
     documents ${...} substitution for hook commands, and bash does not expand
     env vars inside a literal argument. `bash -c` sidesteps both problems and
     lets us probe every plugin-root variable name seen in the wild
     (PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT per OpenAI's docs; CODEX_PLUGIN_ROOT
     in published community plugins). Once any of them resolves, start.sh
     re-derives its own root from BASH_SOURCE, so passing the correct path is
     all that matters. */
  /* Use the camelCase `mcpServers` wrapper key. OpenAI's runtime docs list a
     snake_case `mcp_servers` form too, but the Codex app's marketplace parser
     only recognizes `mcpServers` — with snake_case the plugin page shows zero
     MCP servers and the server is never launched. This matches the working
     community plugins (e.g. session-orchestrator). */
  const launcher =
    'exec bash "${PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}}/server/start.sh"';
  const mcpJson = {
    mcpServers: {
      local_tester: {
        command: "bash",
        args: ["-c", launcher],
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

ROOT="\${PLUGIN_ROOT:-\${CODEX_PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}}}"
DATA="\${PLUGIN_DATA:-\${CLAUDE_PLUGIN_DATA:-$ROOT/.data}}"
mkdir -p "$DATA"

# Diagnostic log at a STABLE, predictable path (overridable) so it is easy to
# find no matter where Codex installs the plugin. Every stderr line from this
# script AND the server is tee'd here while still flowing to the host; stdout is
# left untouched so the JSON-RPC channel stays clean.
LOG_DIR="\${LOCAL_TESTER_LOG_DIR:-$HOME/.local-tester-mcp}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/start.log"
exec 2> >(tee -a "$LOG" >&2)

echo "==== local-tester start: $(date '+%Y-%m-%dT%H:%M:%S%z') (pid $$) ====" >&2
echo "ROOT=$ROOT" >&2
echo "DATA=$DATA" >&2
echo "PWD=$(pwd)" >&2
echo "PATH=$PATH" >&2

# GUI apps (e.g. the Codex desktop app) spawn this server with a minimal PATH
# (/usr/bin:/bin:/usr/sbin:/sbin) and do NOT source the shell profile, so a
# version-manager node (nvm) or a Homebrew node is invisible and the server
# silently fails to start. If node is not already resolvable, prepend the
# common install locations so npm/node can be found.
if ! command -v node >/dev/null 2>&1; then
  echo "node not on inherited PATH; probing common install locations" >&2
  NVM_NODE_BIN="$(ls -d "\${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  for d in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$NVM_NODE_BIN"; do
    if [ -n "$d" ] && [ -x "$d/node" ]; then
      echo "found node in $d" >&2
      PATH="$d:$PATH"
      break
    fi
  done
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "local-tester: 'node' not found on PATH. Install Node.js (or add it to PATH) so the MCP server can start." 1>&2
  exit 127
fi

echo "node=$(command -v node) ($(node -v 2>&1))" >&2
echo "npm=$(command -v npm 2>/dev/null || echo 'NOT FOUND') ($(npm -v 2>&1 || true))" >&2

# (Re)install runtime deps only when the manifest changes. Output goes to
# stderr/null so stdout stays a clean JSON-RPC channel.
if ! diff -q "$ROOT/server/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  echo "installing runtime deps into $DATA" >&2
  cp "$ROOT/server/package.json" "$DATA/package.json"
  ( cd "$DATA" && npm install --omit=dev --no-audit --no-fund ) 1>&2
else
  echo "runtime deps up to date" >&2
fi

echo "exec node $ROOT/server/index.js" >&2
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
- \`.mcp.json\` - registers the \`local_tester\` stdio server via the \`mcpServers\` wrapper, launched via \`bash -c\` so the shell resolves the plugin root at runtime.
- \`server/\` - the compiled MCP server plus a launcher (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` - usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs

\`.mcp.json\` uses the top-level \`mcpServers\` object (the camelCase key the
Codex app recognizes) and launches
the bundled \`server/start.sh\` through \`bash -c\`, so the shell expands the
plugin-root variable at runtime. Codex spawns MCP servers from the project
working directory, not the plugin root, so the launcher resolves the path from
whichever plugin-root variable is set (\`PLUGIN_ROOT\`, \`CODEX_PLUGIN_ROOT\`, or
\`CLAUDE_PLUGIN_ROOT\`) rather than a fragile relative path. On first run the launcher installs
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
