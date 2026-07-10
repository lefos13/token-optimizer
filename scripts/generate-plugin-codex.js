const fs = require("fs");
const path = require("path");
const { buildStartJs } = require("./launcher-template");

/* Codex plugin flow.
   Generates a complete, installable, portable Codex plugin under plugin/codex/.
   The repo-root marketplace catalog lets Codex discover the generated plugin
   from this repository, while the plugin itself bundles the compiled MCP server
   and launches a self-locating script from the plugin root.

   Output layout:
     .agents/plugins/marketplace.json              (REPO-ROOT marketplace catalog)
     plugin/codex/.codex-plugin/plugin.json        (plugin manifest)
     plugin/codex/.mcp.json                        (registers the token_optimizer server)
     plugin/codex/server/*.js                      (compiled server, copied from dist/)
     plugin/codex/server/package.json              (single runtime dep to install)
     plugin/codex/server/start.sh                  (installs deps + execs server)
     plugin/codex/skills/token-optimizer/SKILL.md
     plugin/codex/README.md
   Do not edit generated files by hand; run npm run build:plugin:codex. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "codex");
const metaDir = path.join(pluginDir, ".codex-plugin");
const repoMarketplaceDir = path.join(rootDir, ".agents", "plugins");
const PLUGIN_SOURCE_PATH = "./plugin/codex";
const SKILL_NAME = "token-optimizer";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
const serverDir = path.join(pluginDir, "server");
const distDir = path.join(rootDir, "dist");

const SERVER_FILES = [
  "index.js",
  "analytics.js",
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

console.log("Generating Codex plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(repoMarketplaceDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const VERSION = "2.0.0-alpha.1";

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
    "Token Optimizer runs validation commands in a workspace, keeps raw logs out of context, and returns compact verdicts via the token_optimizer MCP server.";

  const pluginJson = {
    name: "token-optimizer",
    version: VERSION,
    description,
    author: { name: "Lefos13" },
    license: "Apache-2.0",
    keywords: ["local-test", "mcp", "verdict", "triage", "validation"],
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      displayName: "Token Optimizer",
      shortDescription:
        "Run local validation and summarize logs with a local LLM.",
      longDescription:
        "Validate code changes, triage failures, review changed files, check regressions, digest noisy commands, and scout codebases without flooding the conversation with raw logs.",
      developerName: "Lefos13",
      category: "Productivity",
      capabilities: ["Read", "Run"],
      defaultPrompt: [
        "Use Token Optimizer to validate my current code changes.",
        "Use Token Optimizer to triage the failing test log.",
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
        name: "token-optimizer",
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

  /* Anchor the launcher at the plugin root via `cwd: "."`. Codex resolves a
     plugin MCP server's `cwd` relative to the plugin root (proven by working
     community plugins like task-scheduler and codex-rg-guard that ship
     `cwd: "."` with relative commands). Critically, Codex does NOT inject
     PLUGIN_ROOT/CODEX_PLUGIN_ROOT/CLAUDE_PLUGIN_ROOT into MCP server processes
     — those are only documented for hook commands — so a launcher that relies
     solely on them expands to an empty root ("/server/start.sh"), the process
     dies instantly, and no tools ever bind. The `bash -c` form lets the shell
     expand the path at runtime; we still probe the plugin-root variables in
     case a future Codex sets them, but the real workhorse is the `$PWD`
     fallback, which equals the plugin root once `cwd: "."` is applied.

     Use the camelCase `mcpServers` wrapper key. OpenAI's runtime docs list a
     snake_case `mcp_servers` form too, but the Codex app's marketplace parser
     only recognizes `mcpServers` — with snake_case the plugin page shows zero
     MCP servers. */
  /* Codex passes `LLM_GATEWAY_TOKEN` through from the session via `env_vars`
     (the value that varies per person); `LLM_GATEWAY_URL` is baked as the
     default gateway address. If a session also provides `LLM_GATEWAY_URL`,
     precedence between the baked default and the passthrough depends on
     Codex's env-merge behavior — not verified here.

     `node server/start.js` relies on the same `cwd: "."` anchor the previous
     bash launcher used ($PWD == plugin root): node resolves the relative
     script path against the cwd. Using node instead of bash makes the plugin
     work on Windows, where no usable bash exists on PATH. */
  const mcpJson = {
    mcpServers: {
      token_optimizer: {
        command: "node",
        /* Forward slash stays portable: node accepts it on Windows too, and
           the committed output must not vary by the OS that generated it. */
        args: ["server/start.js"],
        cwd: ".",
        env_vars: [
          "LLM_GATEWAY_TOKEN",
          "LLM_GATEWAY_URL",
          "OPENROUTER_BYOK_KEY",
          "OPENROUTER_BYOK_MODEL",
        ],
        env: {
          LLM_GATEWAY_URL: "https://llm-proxy.lnf.gr/v1",
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

  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${PLUGIN_ROOT:-\${CODEX_PLUGIN_ROOT:-\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}}}"
DATA="\${PLUGIN_DATA:-\${CLAUDE_PLUGIN_DATA:-$ROOT/.data}}"
mkdir -p "$DATA"

# Diagnostic log at a STABLE, predictable path (overridable) so it is easy to
# find no matter where Codex installs the plugin. Every stderr line from this
# script AND the server is tee'd here while still flowing to the host; stdout is
# left untouched so the JSON-RPC channel stays clean.
LOG_DIR="\${TOKEN_OPTIMIZER_LOG_DIR:-$HOME/.token-optimizer-mcp}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/start.log"
exec 2> >(tee -a "$LOG" >&2)

echo "==== token-optimizer start: $(date '+%Y-%m-%dT%H:%M:%S%z') (pid $$) ====" >&2
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
  echo "token-optimizer: 'node' not found on PATH. Install Node.js (or add it to PATH) so the MCP server can start." 1>&2
  exit 127
fi

echo "node=$(command -v node) ($(node -v 2>&1))" >&2
echo "npm=$(command -v npm 2>/dev/null || echo 'NOT FOUND') ($(npm -v 2>&1 || true))" >&2

echo "exec node $ROOT/server/start.js" >&2
export PLUGIN_DATA="$DATA"
exec node "$ROOT/server/start.js"
`;
  const startShPath = path.join(serverDir, "start.sh");
  fs.writeFileSync(startShPath, startSh);
  fs.chmodSync(startShPath, 0o755);

  /* Cross-platform launcher referenced by .mcp.json (start.sh stays for
     POSIX scripting compatibility). */
  const startJsPath = path.join(serverDir, "start.js");
  fs.writeFileSync(startJsPath, buildStartJs());
  fs.chmodSync(startJsPath, 0o755);

  const sourceSkill = path.join(rootDir, "skill", "skill-example.md");
  const destSkill = path.join(skillsDir, "SKILL.md");
  if (!fs.existsSync(sourceSkill)) {
    console.error(`Error: Source skill file not found at ${sourceSkill}`);
    process.exit(1);
  }
  fs.copyFileSync(sourceSkill, destSkill);

  const readme = `# Token Optimizer plugin (Codex)

Bundles the \`token_optimizer\` MCP server and the \`${SKILL_NAME}\` skill so Codex
can validate code changes, triage failures, review changed files, check
regressions, digest noisy commands, and scout code without flooding chat context
with raw logs.

> Generated by \`npm run build:plugin:codex\`. Do not edit files under \`plugin/\` by hand.

## Contents

- \`.codex-plugin/plugin.json\` - plugin manifest (\`token-optimizer\` v${VERSION}).
- \`.mcp.json\` - registers the \`token_optimizer\` stdio server via the \`mcpServers\` wrapper, launched with \`node server/start.js\` anchored at the plugin root via \`cwd: "."\`.
- \`server/\` - the compiled MCP server plus launchers (\`start.js\` cross-platform, \`start.sh\` POSIX) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` - usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs

\`.mcp.json\` uses the top-level \`mcpServers\` object (the camelCase key the
Codex app recognizes) and launches the bundled \`server/start.js\` with \`node\`,
anchored at the plugin root via \`cwd: "."\`. This works on Windows, macOS, and
Linux — no bash required. On first run the launcher installs
\`@modelcontextprotocol/sdk\` into the plugin data directory when Codex provides
one, or into a local \`.data/\` fallback beside the plugin. No absolute repo paths
are baked in, so the plugin remains portable after Codex installs it into its
cache.

Requirements on the target machine: \`node\` and \`npm\` on \`PATH\`, plus network
access the first time so npm can install the runtime dependency. After that it
runs offline.

## LLM configuration

**Centralized gateway (primary):** The plugin is preconfigured with the gateway URL (\`https://llm-proxy.lnf.gr/v1\`). Provide your per-person proxy token: from a repo clone run \`npm run gateway:config -- setup\` and paste the token (it is written to every client on your machine), or set \`LLM_GATEWAY_TOKEN\` manually in this client's config. Shared and issued gateway-token callers use the gateway-controlled task model.

**Bring your own OpenRouter key (BYOK):** Set \`OPENROUTER_BYOK_KEY\` instead of a gateway token. You may also set \`OPENROUTER_BYOK_MODEL\` to one OpenRouter \`provider/model\` for every request; leave it blank or unset to use the gateway's task-specific/default model selection.

> **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The gateway (or local fallback model, if configured) is responsible for returning JSON-mode-compatible responses. Only BYOK callers may optionally select a model.

**Token Optimizer fallback:** The server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

The plugin ships with the gateway URL baked in (\`https://llm-proxy.lnf.gr/v1\`).
Your per-person gateway token is passed through via \`env_vars\`, allowing a session
to override \`LLM_GATEWAY_TOKEN\` or \`LLM_GATEWAY_URL\` at runtime.
Use \`npm run gateway:config\` to manage your gateway token across all clients on your machine.

## Install

The marketplace catalog lives at the repository root:
\`.agents/plugins/marketplace.json\`. Add the repository as a marketplace, then
install or enable the \`token-optimizer\` plugin from Codex.

\`\`\`bash
codex plugin marketplace add /path/to/token-optimizer-mcp
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
