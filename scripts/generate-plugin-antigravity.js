const fs = require("fs");
const path = require("path");
const { buildStartJs } = require("./launcher-template");

/* Antigravity plugin flow.
   Generates a complete, installable, portable Antigravity plugin under
   plugin/antigravity/, following the layout documented at
   https://antigravity.google/docs/plugins and https://antigravity.google/docs/mcp:

     plugin.json        - required marker file that identifies the directory as
                          a plugin ("name" is optional and defaults to the
                          directory name; we set it explicitly for clarity).
     mcp_config.json    - registers MCP servers via a top-level "mcpServers"
                          object (same shape as the user's global
                          ~/.gemini/config/mcp_config.json: command/args/env).
     skills/<name>/SKILL.md - each skill is a directory containing a SKILL.md.
     server/            - the bundled compiled token_optimizer MCP server.

   PRIOR GENERATOR GAP: the old version of this script shipped only plugin.json
   and a skill — it never registered the token_optimizer MCP server at all, so
   importing it gave you the skill with none of the MCP tools it instructs you
   to use. This version bundles and registers the server like the Claude Code
   and Codex flows do.

   PORTABILITY NOTE: unlike Claude Code (${CLAUDE_PLUGIN_ROOT}/${CLAUDE_PLUGIN_DATA})
   or Codex (${PLUGIN_ROOT}/${PLUGIN_DATA}), Antigravity's mcp_config.json schema
   does not document an equivalent "plugin root" path variable. So instead of
   relying on an undocumented env var, the launcher (server/start.sh) self-locates
   via $(dirname "${BASH_SOURCE[0]}") — which works no matter where Antigravity
   stages the plugin (e.g. ~/.gemini/config/plugins/<name>/ or
   ~/.gemini/antigravity-cli/plugins/<name>/) — and persists its installed
   runtime dependency in a .data/ directory next to itself.

   Output layout:
     plugin/antigravity/plugin.json
     plugin/antigravity/mcp_config.json
     plugin/antigravity/server/*.js                 (compiled server, copied from dist/)
     plugin/antigravity/server/package.json         (single runtime dep to install)
     plugin/antigravity/server/start.sh             (self-locating launcher)
     plugin/antigravity/skills/token-optimizer/SKILL.md
     plugin/antigravity/README.md
   This output is gitignored (see plugin/antigravity/ in .gitignore) — unlike the
   Claude Code flow, Antigravity plugins are imported from a local path rather
   than a git-based marketplace, so nothing needs to be committed for install.
   Do not edit generated files by hand; run `npm run build:plugin:antigravity`. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "antigravity");
const PLUGIN_NAME = "token-optimizer";
const SKILL_NAME = "token-optimizer";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
const serverDir = path.join(pluginDir, "server");
const distDir = path.join(rootDir, "dist");

/* Compiled files the server needs at runtime. analytics-ui.js is a separate
   dev tool and is intentionally excluded (mirrors the Claude/Codex flows). */
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

console.log("Generating Antigravity plugin structure...");

try {
  /* Wipe and rebuild: the layout changed (server bundle + mcp_config.json are
     new, and the skill directory was renamed), so stale files from the old
     minimal layout must not linger alongside the new ones. */
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  /* Bump this whenever plugin.json, mcp_config.json, the bundled server, or the
     skill changes, so a re-import/re-copy is easy to tell apart from a stale
     install (Antigravity does not document version-gated update pulls the way
     Claude Code's marketplace install does, but keeping this accurate still
     matters for users diffing or re-staging the plugin folder). */
  const VERSION = "2.0.0";

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

  /* plugin.json: the required marker file. Antigravity only documents "name" as
     a recognized field (optional, defaults to the directory name); the rest are
     descriptive metadata that travels with the bundle for humans inspecting it. */
  const pluginJson = {
    name: PLUGIN_NAME,
    version: VERSION,
    description,
    author: { name: "Lefos13" },
    license: "Apache-2.0",
    keywords: ["local-test", "mcp", "verdict", "triage", "validation"],
  };
  fs.writeFileSync(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n",
  );

  /* mcp_config.json: registers the token_optimizer stdio server using the same
     "mcpServers" shape documented for the user's global mcp_config.json. The
     tool names referenced by the skill are mcp__token_optimizer__*, so the server
     key must stay "token_optimizer". The launcher path is relative to the plugin
     directory; self-contained plugin bundles only make sense if the host
     resolves bundled paths relative to the staged plugin root.

     The gateway URL is baked as the default. The per-person LLM_GATEWAY_TOKEN
     is written into the staged/global mcp_config.json by `npm run gateway:config`. */
  const mcpConfigJson = {
    mcpServers: {
      token_optimizer: {
        command: "./server/start.sh",
        args: [],
        env: {
          LLM_GATEWAY_URL: "https://llm-proxy.lnf.gr/v1",
          LOCAL_LLM_API_URL: "http://localhost:8080/v1",
          LOCAL_LLM_MODEL: "local-model",
        },
      },
    },
  };
  fs.writeFileSync(
    path.join(pluginDir, "mcp_config.json"),
    JSON.stringify(mcpConfigJson, null, 2) + "\n",
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
     into a persistent .data/ directory next to the server. The compiled server
     uses CommonJS require. */
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

  /* The POSIX wrapper preserves Antigravity's self-locating data path, then
     delegates cache validation and server startup to the shared launcher. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${ANTIGRAVITY_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
export ANTIGRAVITY_PLUGIN_DATA="\${ANTIGRAVITY_PLUGIN_DATA:-$ROOT/.data}"
exec node "$ROOT/server/start.js"
`;
  const startShPath = path.join(serverDir, "start.sh");
  fs.writeFileSync(startShPath, startSh);
  fs.chmodSync(startShPath, 0o755);

  /* Cross-platform launcher referenced by the MCP config (start.sh stays for
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

  const readme = `# Token Optimizer plugin (Antigravity)

Bundles the \`token_optimizer\` MCP server and the \`${SKILL_NAME}\` skill so an
Antigravity agent can validate code changes, triage failures, review changed
files, check regressions, digest noisy commands, and scout code without
flooding chat context with raw logs.

> Generated by \`npm run build:plugin:antigravity\`. Do not edit files under
> \`plugin/\` by hand. This output is gitignored — see "Install" below for how
> Antigravity loads a local plugin folder directly.

## Contents

- \`plugin.json\` — required plugin marker/manifest (\`${PLUGIN_NAME}\` v${VERSION}).
- \`mcp_config.json\` — registers the \`token_optimizer\` stdio server (tools exposed as \`mcp__token_optimizer__*\`), using the same \`mcpServers\` shape as Antigravity's global \`~/.gemini/config/mcp_config.json\`.
- \`server/\` — the compiled MCP server plus a self-locating launcher (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` — usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs (portable)

\`mcp_config.json\` launches \`./server/start.sh\` (resolved relative to the plugin
directory). Antigravity's plugin spec does not document a "plugin root" path
variable the way Claude Code (\`\${CLAUDE_PLUGIN_ROOT}\`) or Codex
(\`\${PLUGIN_ROOT}\`) do, so the launcher finds its own location with
\`$(dirname "\${BASH_SOURCE[0]}")\` instead. On first run it installs the single
runtime dependency (\`@modelcontextprotocol/sdk\`) into a persistent \`.data/\`
directory next to itself, then starts the server. No absolute machine-specific
paths are baked in, so the plugin folder can be copied or staged anywhere.

**Requirements on the target machine:** \`node\`, \`npm\`, and \`bash\` on \`PATH\`,
plus network access the first time (to install the dependency). After that it
runs offline.

The skill is invoked as \`token-optimizer\` (folder name under \`skills/\`) and
is also model-invoked automatically based on its description.

## LLM configuration

**Centralized gateway (primary):** The plugin is preconfigured with the gateway URL (\`https://llm-proxy.lnf.gr/v1\`). Provide your per-person proxy token: from a repo clone run \`npm run gateway:config -- setup\` and paste the token (it is written to every client on your machine), or set \`LLM_GATEWAY_TOKEN\` manually in this client's config. Models are chosen centrally on the gateway; no client-side model configuration is needed.

> **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The gateway (or local fallback model, if configured) is responsible for returning JSON-mode-compatible responses; end users do not choose or configure a model.

**Token Optimizer fallback:** The server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

Use \`npm run gateway:config\` to manage your gateway token across all clients on your machine.

## Install

Antigravity does not document a git-based marketplace for local plugin
development the way Claude Code does — plugins are loaded from a folder on
disk. Per https://antigravity.google/docs/plugins, place (copy or symlink) this
generated \`plugin/antigravity/\` directory where Antigravity looks for plugins:

- **Global** (available in every workspace): \`~/.gemini/config/plugins/${PLUGIN_NAME}/\`
  (the Antigravity CLI may instead stage imported plugins under
  \`~/.gemini/antigravity-cli/plugins/${PLUGIN_NAME}/\` — check which path your
  installed version reads).
- **Workspace-only**: \`<workspace-root>/.agents/plugins/${PLUGIN_NAME}/\` (or
  \`_agents/plugins/\`).

\`\`\`bash
mkdir -p ~/.gemini/config/plugins
cp -R ./plugin/antigravity ~/.gemini/config/plugins/${PLUGIN_NAME}
\`\`\`

Then restart Antigravity (or reload plugins, if your version exposes that
action) so it discovers \`plugin.json\`, stages \`mcp_config.json\`, and loads the
skill. Re-running \`npm run build:plugin:antigravity\` regenerates this folder in
place; re-copy (or re-symlink once, so copies aren't needed) it to pick up
changes.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Antigravity plugin generated successfully under plugin/antigravity/");
} catch (error) {
  console.error("Failed to generate Antigravity plugin:", error);
  process.exit(1);
}
