const fs = require("fs");
const path = require("path");

/* Claude Code plugin flow.
   Generates a complete, installable, portable Claude Code plugin under
   plugin/claude/. Unlike the Antigravity flow (generate-plugin-antigravity.js),
   this registers the local_tester MCP server, ships the compiled server inside
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
     plugin/claude/.mcp.json                       (registers the local_tester server)
     plugin/claude/server/*.js                     (compiled server, copied from dist/)
     plugin/claude/server/package.json             (single runtime dep to install)
     plugin/claude/server/start.sh                 (installs deps + execs server)
     plugin/claude/skills/local-llm-subagent/SKILL.md
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
const SKILL_NAME = "local-llm-subagent";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
const serverDir = path.join(pluginDir, "server");
const distDir = path.join(rootDir, "dist");

/* Compiled files the server needs at runtime. analytics-ui.js is a separate
   dev tool and is intentionally excluded. */
const SERVER_FILES = [
  "index.js",
  "analytics.js",
  "detector.js",
  "llm.js",
  "registry.js",
  "runner.js",
  "types.js",
];

console.log("Generating Claude Code plugin structure...");

try {
  fs.mkdirSync(metaDir, { recursive: true });
  fs.mkdirSync(repoMetaDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  /* Bump this on every meaningful change. Claude only pulls plugin updates
     when the version changes; keeping it static pins installs to the commit
     they were first installed from and updates become silent no-ops. */
  const VERSION = "1.2.2";

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
    name: "local-tester",
    version: VERSION,
    description:
      "Local test execution, verification, and local-LLM triage. Runs validation commands in a workspace, keeps raw logs out of context, and returns compact verdicts via the local_tester MCP server.",
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
    name: "local-tester-marketplace",
    metadata: { description: "Marketplace for the local-tester plugin" },
    owner: { name: "Lefos13" },
    plugins: [
      {
        name: "local-tester",
        source: PLUGIN_SOURCE_PATH,
        description: pluginJson.description,
      },
    ],
  };
  fs.writeFileSync(
    path.join(repoMetaDir, "marketplace.json"),
    JSON.stringify(marketplaceJson, null, 2) + "\n",
  );

  /* Registers the local_tester stdio server. The tool names referenced by the
     skill are mcp__local_tester__*, so the server key must be local_tester.
     The launcher is referenced via ${CLAUDE_PLUGIN_ROOT} so the plugin is
     portable: it carries its own compiled server and resolves deps relative to
     the install dir rather than an absolute repo path. */
  const mcpJson = {
    mcpServers: {
      local_tester: {
        command: "bash",
        args: ["${CLAUDE_PLUGIN_ROOT}/server/start.sh"],
        env: {
          OPENROUTER_API_KEY: "",
          OPENROUTER_MODEL: "",
          OPENROUTER_VERDICT_MODEL: "",
          OPENROUTER_TRIAGE_MODEL: "",
          OPENROUTER_REVIEW_MODEL: "",
          OPENROUTER_DIGEST_MODEL: "",
          OPENROUTER_SCOUT_MODEL: "",
          OPENROUTER_QUERY_MODEL: "",
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

  /* Launcher: installs the runtime dep into the persistent plugin data dir on
     first run (or when package.json changes), then execs the server. All
     install chatter is kept off stdout so it cannot corrupt the JSON-RPC
     stream the MCP client reads. NODE_PATH points node at the installed deps. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="\${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)}"
DATA="\${CLAUDE_PLUGIN_DATA:-$ROOT/.data}"
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

  const readme = `# local-tester plugin (Claude Code)

Bundles the \`local_tester\` MCP server and the \`${SKILL_NAME}\` skill so an
agent can validate code changes, triage failures, review changed files, check
regressions, and scout code without flooding chat context with raw logs.

> Generated by \`npm run build:plugin:claude\`. Do not edit files under \`plugin/\` by hand.

## Contents

- \`.claude-plugin/plugin.json\` — plugin manifest (\`local-tester\` v${VERSION}).
- \`.mcp.json\` — registers the \`local_tester\` stdio server (tools exposed as \`mcp__local_tester__*\`).
- \`server/\` — the compiled MCP server plus a launcher (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` — usage guidance, copied from \`skill/skill-example.md\`.

## How the server runs (portable)

\`.mcp.json\` launches \`\${CLAUDE_PLUGIN_ROOT}/server/start.sh\`. On first run the
launcher installs the single runtime dependency
(\`@modelcontextprotocol/sdk\`) into the persistent \`\${CLAUDE_PLUGIN_DATA}\`
directory, then starts the server. No absolute repo paths are baked in, so the
plugin is portable across machines.

**Requirements on the target machine:** \`node\` and \`npm\` on \`PATH\`, plus network
access the first time (to install the dependency). After that it runs offline.

The skill is invoked as \`/local-tester:${SKILL_NAME}\` and is also model-invoked
automatically based on its description.

## LLM configuration

**OpenRouter (primary):** Set \`OPENROUTER_API_KEY\` in the \`env\` block of \`.mcp.json\` to route all LLM calls through [OpenRouter](https://openrouter.ai). \`OPENROUTER_MODEL\` sets the default model (falls back to \`openai/gpt-4o-mini\`). Per-task overrides: \`OPENROUTER_VERDICT_MODEL\`, \`OPENROUTER_TRIAGE_MODEL\`, \`OPENROUTER_REVIEW_MODEL\`, \`OPENROUTER_DIGEST_MODEL\`, \`OPENROUTER_SCOUT_MODEL\`, \`OPENROUTER_QUERY_MODEL\`.

> **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The chosen model must support JSON mode. Compatible models include \`openai/gpt-4o\`, \`openai/gpt-4o-mini\`, \`anthropic/claude-3-5-sonnet\`, \`anthropic/claude-3-haiku\`, and \`google/gemini-flash-1.5\`. Check the [OpenRouter models page](https://openrouter.ai/models) and filter by JSON mode support.

**Local LLM (fallback):** When \`OPENROUTER_API_KEY\` is absent, the server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

Edit the \`env\` block in \`~/.claude/plugins/cache/<plugin-name>/.mcp.json\` to set your values.

## Install

The marketplace catalog lives at the **repository root** (\`.claude-plugin/marketplace.json\`),
so add the repo as a marketplace, then install the plugin:

\`\`\`bash
# From a local clone:
claude plugin marketplace add /path/to/local-tester-mcp
# Or from a git host (push first):
# claude plugin marketplace add <github-owner>/<repo>

claude plugin install local-tester@local-tester-marketplace
\`\`\`

Relative plugin sources resolve only when the marketplace is added via git, so
the local path must be a git repository (this one is).

For local development without a marketplace:

\`\`\`bash
claude --plugin-dir ${pluginDir}
\`\`\`

Then restart Claude Code (or run \`/reload-plugins\`) so the server and skill load.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("Claude Code plugin generated successfully under plugin/claude/");
} catch (error) {
  console.error("Failed to generate Claude Code plugin:", error);
  process.exit(1);
}
