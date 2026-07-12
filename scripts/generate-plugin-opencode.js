const fs = require("fs");
const path = require("path");
const { buildStartJs } = require("./launcher-template");

/* opencode plugin flow.
   Generates a portable token_optimizer bundle under plugin/opencode/ for opencode
   (https://opencode.ai). opencode has no plugin/marketplace mechanism for MCP
   servers or skills — plugins are JS lifecycle-hook packages only. MCP servers
   are registered via a static "mcp" block in opencode.jsonc, and skills are
   discovered from SKILL.md files under fixed paths (project .opencode/skills/,
   global ~/.config/opencode/skills/, among others; see opencode.ai/docs/skills
   and opencode.ai/docs/rules). So this generator produces a bundle plus the
   exact snippet to merge by hand, rather than something opencode can import
   directly the way Claude Code's marketplace install works.

   Output layout:
     plugin/opencode/server/*.js                 (compiled server, copied from dist/)
     plugin/opencode/server/package.json         (single runtime dep to install)
     plugin/opencode/server/start.sh             (self-locating launcher)
     plugin/opencode/skills/token-optimizer/SKILL.md
     plugin/opencode/mcp-snippet.jsonc           (block to merge into opencode.jsonc's "mcp")
     plugin/opencode/README.md
   This output is gitignored (see plugin/opencode/ in .gitignore) — like
   Antigravity, there is no marketplace to fetch it from, so nothing needs to
   be committed for install.
   Do not edit generated files by hand; run `npm run build:plugin:opencode`. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "opencode");
const SKILL_NAME = "token-optimizer";
const skillsDir = path.join(pluginDir, "skills", SKILL_NAME);
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

/* Conventional install location the README tells the user to copy the server
   to, so the path baked into mcp-snippet.jsonc matches what actually exists
   on disk once they follow the instructions. */
const installedServerDir = "${HOME}/.config/opencode/token-optimizer-server";

console.log("Generating opencode plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  const VERSION = "2.0.0-rc.5";

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

  /* Preserve opencode's self-locating data path, then delegate cache
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

  const sourceSkill = path.join(rootDir, "skill", "skill-example.md");
  const destSkill = path.join(skillsDir, "SKILL.md");
  if (!fs.existsSync(sourceSkill)) {
    console.error(`Error: Source skill file not found at ${sourceSkill}`);
    process.exit(1);
  }
  fs.copyFileSync(sourceSkill, destSkill);

  /* opencode's config docs (opencode.ai/docs/config) show "{env:VAR}" style
     interpolation for pulling values from the process environment at
     runtime, so the token never has to be hardcoded here. */
  const mcpSnippet = {
    token_optimizer: {
      type: "local",
      command: ["node", path.join(installedServerDir, "start.js")],
      environment: {
        LLM_GATEWAY_URL: "{env:LLM_GATEWAY_URL}",
        LLM_GATEWAY_TOKEN: "{env:LLM_GATEWAY_TOKEN}",
      },
      enabled: true,
    },
  };
  fs.writeFileSync(
    path.join(pluginDir, "mcp-snippet.jsonc"),
    JSON.stringify(mcpSnippet, null, 2) + "\n",
  );

  const readme = `# Token Optimizer bundle (opencode)

Bundles the \`token_optimizer\` MCP server and the \`${SKILL_NAME}\` skill for
[opencode](https://opencode.ai). opencode has no plugin/marketplace mechanism
for MCP servers or skills, so this bundle is installed by copying files and
running the repo config manager.

> Generated by \`npm run build:plugin:opencode\`. Do not edit files under
> \`plugin/\` by hand. This output is gitignored — there is no marketplace to
> fetch it from, so nothing needs to be committed.

## Contents

- \`server/\` — the compiled MCP server plus a self-locating launcher
  (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` — usage guidance, copied from
  \`skill/skill-example.md\`. opencode discovers skills from \`SKILL.md\` files
  under fixed paths — see Install below.
- \`mcp-snippet.jsonc\` — the block the config manager writes into your
  \`opencode.jsonc\`'s \`"mcp"\` object, also useful for manual installs.

## Install

1. Copy the server bundle to a stable location:

   \`\`\`bash
   mkdir -p ~/.config/opencode/token-optimizer-server
   cp -R plugin/opencode/server/* ~/.config/opencode/token-optimizer-server/
   \`\`\`

2. Copy the skill so opencode discovers it globally:

   \`\`\`bash
   mkdir -p ~/.config/opencode/skills/${SKILL_NAME}
   cp -R plugin/opencode/skills/${SKILL_NAME}/* ~/.config/opencode/skills/${SKILL_NAME}/
   \`\`\`

3. Provide your gateway token from a repo clone:

   \`\`\`bash
   npm run gateway:config -- setup
   \`\`\`

   This writes the \`token_optimizer\` MCP block and gateway environment into
   \`~/.config/opencode/opencode.jsonc\`. If you are not using the config
   manager, merge \`mcp-snippet.jsonc\` manually and set
   \`LLM_GATEWAY_TOKEN\` / \`LLM_GATEWAY_URL\` in your own shell/session
   environment before launching opencode.

4. Optional: make Token Optimizer default-on for opencode:

   \`\`\`bash
   npm run gateway:config -- enable-defaults
   \`\`\`

   This writes the standing directive to \`~/.config/opencode/AGENTS.md\`.

5. Restart opencode so it picks up the new MCP server and skill.

**Requirements:** \`node\` and \`npm\` on \`PATH\`; network access on
first run only (to install the bundled server's single runtime dependency into
a \`.data/\` directory next to itself).

To pick up changes, re-run \`npm run build:plugin:opencode\`, re-copy the
\`server/\` and \`skills/\` contents, and re-run \`npm run gateway:config -- setup\`
if the MCP config shape changed.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("opencode plugin generated successfully under plugin/opencode/");
} catch (error) {
  console.error("Failed to generate opencode plugin:", error);
  process.exit(1);
}
