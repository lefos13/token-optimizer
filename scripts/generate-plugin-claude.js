const fs = require("fs");
const path = require("path");
const { buildStartJs } = require("./launcher-template");

/* Claude Code plugin flow.
   Generates a complete, installable, portable Claude Code plugin under
   plugin/claude/. Unlike the Antigravity flow (generate-plugin-antigravity.js),
   this registers the token_optimizer MCP server, ships the compiled server inside
   the plugin (referenced via ${CLAUDE_PLUGIN_ROOT}, not an absolute repo path),
   and ships a local marketplace so it can be installed with
   `claude plugin marketplace add` + install.

   Runtime deps are NOT committed (node_modules is ~49M). Instead the launcher
   (server/start.sh) installs the single runtime dep into the persistent
   ${CLAUDE_PLUGIN_DATA} on first run, then execs the server. This follows the
   documented plugin pattern and keeps the committed plugin small and portable.

   Output layout:
     .claude-plugin/marketplace.json               (REPO-ROOT marketplace catalog)
     plugin/claude/.claude-plugin/plugin.json      (plugin manifest)
   plugin/claude/.mcp.json                       (registers the token_optimizer server)
     plugin/claude/server/*.js                     (compiled server, copied from dist/)
     plugin/claude/server/package.json             (single runtime dep to install)
     plugin/claude/server/start.sh                 (installs deps + execs server)
     plugin/claude/skills/token-optimizer/SKILL.md
     plugin/claude/README.md
   The marketplace catalog lives at the repo root so the repository is itself a
   valid marketplace (`claude plugin marketplace add <repo>`). Do not edit
   generated files by hand; run `npm run build:plugin:claude`. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "claude");
const metaDir = path.join(pluginDir, ".claude-plugin");
/* The marketplace catalog lives at the REPO ROOT (.claude-plugin/marketplace.json)
   so `claude plugin marketplace add <repo>` can find it. The plugin entry uses a
   relative source path resolved from the repo root. */
const repoMetaDir = path.join(rootDir, ".claude-plugin");
const PLUGIN_SOURCE_PATH = "./plugin/claude";
const SKILL_NAME = "token-optimizer";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
const serverDir = path.join(pluginDir, "server");
const distDir = path.join(rootDir, "dist");

/* Compiled files the server needs at runtime. analytics-ui.js is a separate
   dev tool and is intentionally excluded. */
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

console.log("Generating Claude Code plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(repoMetaDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  /* Bump this on every meaningful change. Claude only pulls plugin updates
     when the version changes; keeping it static pins installs to the commit
     they were first installed from and updates become silent no-ops. */
  const VERSION = "2.0.0-beta.11";

  /* Pin the runtime dep to the version this repo was built and tested against. */
  const sdkVersion = require(
    path.join(
      rootDir,
      "node_modules",
      "@modelcontextprotocol",
      "sdk",
      "package.json",
    ),
  ).version;

  const pluginJson = {
    name: "token-optimizer",
    version: VERSION,
    description:
      "Token Optimizer runs validation commands in a workspace, keeps raw logs out of context, and returns compact verdicts via the token_optimizer MCP server.",
    author: { name: "Lefos13" },
    license: "Apache-2.0",
    keywords: ["local-test", "mcp", "verdict", "triage", "validation"],
    /* Components are auto-discovered from their default locations: skills/ and
       .mcp.json at the plugin root. The manifest deliberately does NOT pin
       custom skills/mcpServers paths, since some clients interpret an explicit
       "skills" path as a single-skill directory rather than a container. */
  };
  fs.writeFileSync(
    path.join(metaDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );

  /* Repo-root marketplace catalog. Written to <repo>/.claude-plugin/marketplace.json
     so the repository itself is a valid marketplace: users run
     `claude plugin marketplace add <repo>` then `claude plugin install`.
     The plugin source is a relative path (must start with "./") resolved from
     the repo root; relative paths resolve when the marketplace is added via git. */
  const marketplaceJson = {
    name: "token-optimizer-marketplace",
    metadata: { description: "Marketplace for the Token Optimizer plugin" },
    owner: { name: "Lefos13" },
    plugins: [
      {
        name: "token-optimizer",
        source: PLUGIN_SOURCE_PATH,
        description: pluginJson.description,
      },
    ],
  };
  fs.writeFileSync(
    path.join(repoMetaDir, "marketplace.json"),
    JSON.stringify(marketplaceJson, null, 2) + "\n",
  );

  /* Registers the token_optimizer stdio server. The tool names referenced by the
     skill are mcp__token_optimizer__*, so the server key must be token_optimizer.
     The launcher is referenced via ${CLAUDE_PLUGIN_ROOT} so the plugin is
     portable: it carries its own compiled server and resolves deps relative to
     the install dir rather than an absolute repo path.

     Resolve the gateway token from the host-managed environment (Claude Code
     expands ${VAR} placeholders from settings or launch environment), while the
     gateway URL is defaulted to the primary endpoint. */
  const mcpJson = {
    mcpServers: {
      token_optimizer: {
        /* node, not bash: Windows has no usable bash on PATH (System32
           bash.exe is WSL), and node is required by the server anyway. */
        command: "node",
        args: ["${CLAUDE_PLUGIN_ROOT}/server/start.js"],
        env: {
          LLM_GATEWAY_URL: "${LLM_GATEWAY_URL:-https://llm-proxy.lnf.gr/v1}",
          LLM_GATEWAY_TOKEN: "${LLM_GATEWAY_TOKEN:-}",
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

  /* Copy the compiled server into the plugin. */
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

  /* Minimal package.json describing only the runtime dependency to install
     into ${CLAUDE_PLUGIN_DATA}. The compiled server uses CommonJS require. */
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

  /* The POSIX wrapper preserves Claude's persistent data path, then delegates
     cache validation and server startup to the shared launcher. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
export CLAUDE_PLUGIN_DATA="\${CLAUDE_PLUGIN_DATA:-$ROOT/.data}"
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

  const readme = `# Token Optimizer plugin (Claude Code)

Bundles the \`token_optimizer\` MCP server and the \`${SKILL_NAME}\` skill so an
agent can validate code changes, triage failures, review changed files, check
regressions, and scout code without flooding chat context with raw logs.

> Generated by \`npm run build:plugin:claude\`. Do not edit files under \`plugin/\` by hand.

## Contents

- \`.claude-plugin/plugin.json\` — plugin manifest (\`token-optimizer\` v${VERSION}).
- \`.mcp.json\` — registers the \`token_optimizer\` stdio server (tools exposed as \`mcp__token_optimizer__*\`).
- \`server/\` — the compiled MCP server plus launchers (\`start.js\` cross-platform, \`start.sh\` POSIX) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` — usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs (portable)

\`.mcp.json\` launches \`node \${CLAUDE_PLUGIN_ROOT}/server/start.js\` (cross-platform,
works on Windows where bash is unavailable). On first run the
launcher installs the single runtime dependency
(\`@modelcontextprotocol/sdk\`) into the persistent \`\${CLAUDE_PLUGIN_DATA}\`
directory, then starts the server. No absolute repo paths are baked in, so the
plugin is portable across machines.

**Requirements on the target machine:** \`node\` and \`npm\` on \`PATH\`, plus network
access the first time (to install the dependency). After that it runs offline.

The skill is invoked as \`/token-optimizer:${SKILL_NAME}\` and is also model-invoked
automatically based on its description.

## LLM configuration

**Centralized gateway (primary):** The plugin is preconfigured with the gateway URL (\`https://llm-proxy.lnf.gr/v1\`). Provide your per-person proxy token: from a repo clone run \`npm run gateway:config -- setup\` and paste the token (it is written to every client on your machine), or set \`LLM_GATEWAY_TOKEN\` manually in this client's config. Shared and issued gateway-token callers use the gateway-controlled task model.

**Bring your own OpenRouter key (BYOK):** Set \`OPENROUTER_BYOK_KEY\` instead of a gateway token. You may also set \`OPENROUTER_BYOK_MODEL\` to one OpenRouter \`provider/model\` for every request; leave it blank or unset to use the gateway's task-specific/default model selection.

> **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The gateway (or local fallback model, if configured) is responsible for returning JSON-mode-compatible responses. Only BYOK callers may optionally select a model.

**Token Optimizer fallback:** The server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

Use \`npm run gateway:config\` to manage your gateway token across all clients on your machine.

## Install

The marketplace catalog lives at the **repository root** (\`.claude-plugin/marketplace.json\`),
so add the repo as a marketplace, then install the plugin:

\`\`\`bash
# From a local clone:
claude plugin marketplace add /path/to/token-optimizer-mcp
# Or from a git host (push first):
# claude plugin marketplace add <github-owner>/<repo>

claude plugin install token-optimizer@token-optimizer-marketplace
\`\`\`

Relative plugin sources resolve only when the marketplace is added via git, so
the local path must be a git repository (this one is).

For local development without a marketplace:

\`\`\`bash
claude --plugin-dir ./plugin/claude
\`\`\`

Then restart Claude Code (or run \`/reload-plugins\`) so the server and skill load.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Claude Code plugin generated successfully under plugin/claude/");
} catch (error) {
  console.error("Failed to generate Claude Code plugin:", error);
  process.exit(1);
}
