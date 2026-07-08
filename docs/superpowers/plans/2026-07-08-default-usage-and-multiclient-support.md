# Default-On Usage Directive + opencode/Cursor Client Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on usage directive fanned out to Claude/Codex/Antigravity's global instruction files, and bring opencode and Cursor to full generator parity with the existing three clients.

**Architecture:** Extend the existing `scripts/manage-gateway-config.js` CLI with two new subcommands that write/remove an idempotent marker block into three existing global instruction files. Add two new generator scripts (`generate-plugin-opencode.js`, `generate-plugin-cursor.js`) that follow the exact structural pattern of `generate-plugin-antigravity.js` — bundled compiled server + self-locating launcher + a client-specific guidance artifact (SKILL.md for opencode, a `.mdc` rule for Cursor) + a documented manual-merge snippet, since neither client has a marketplace/import mechanism.

**Tech Stack:** Node.js CommonJS scripts (no new dependencies), `node:test` for the test suite, plain JSON/Markdown output.

## Global Constraints

- No new npm dependencies — Node 18+ built-ins only, matching the rest of the repo.
- Do not hand-edit anything under `plugin/` — always regenerate via the npm scripts.
- `plugin/opencode/` and `plugin/cursor/` are **gitignored**, matching `plugin/antigravity/`'s existing precedent (no marketplace fetches them, so nothing needs to be committed).
- Bump `VERSION` to `1.5.0` in **all five** generator scripts (the three existing ones plus the two new ones), per the project's existing "bump every plugin package for every change" rule.
- The default-on directive block uses the exact marker pair `<!-- LOCAL_TESTER_START -->` / `<!-- LOCAL_TESTER_END -->`, mirroring the same idempotent-block convention CodeGraph's installer already uses in the same three files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`).
- Directive targets that do not exist on disk are skipped — never create a client's global instructions file from scratch.
- Every task must end with `npm test` passing before commit.
- If you change server behavior, tool names, schemas, env vars, or generator output, update `README.md` per repo instructions (folded into Task 4 here since that's the task touching shared/version-level concerns).

---

### Task 1: `gateway:config` gains `enable-defaults` / `disable-defaults`

**Files:**
- Modify: `scripts/manage-gateway-config.js`
- Test: `test/scripts/gateway-config.test.ts`

**Interfaces:**
- Produces (used by later verification, not by other tasks): `module.exports.DIRECTIVE_MARKER_START`, `DIRECTIVE_MARKER_END`, `DIRECTIVE_BLOCK` (string constants), `getDirectiveTargets(home)` (returns `[{label, filePath}]`), `applyDirectiveBlock(content)` / `removeDirectiveBlock(content)` / `hasDirectiveBlock(content)` (pure string functions), `applyDirectiveToTargets(home)` / `removeDirectiveFromTargets(home)` (filesystem side effects, skip missing files, reuse the existing `backupFileIfPresent`).

- [ ] **Step 1: Write the failing tests**

Add to the end of `test/scripts/gateway-config.test.ts`:

```ts
test('applyDirectiveToTargets inserts the block into existing global instruction files, idempotent on re-run', () => {
  const home = tmpHome();
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(claudeMd), { recursive: true });
  fs.writeFileSync(claudeMd, '# My existing instructions\n');

  cli.applyDirectiveToTargets(home);
  const first = fs.readFileSync(claudeMd, 'utf8');
  assert.ok(first.includes('# My existing instructions'));
  assert.ok(cli.hasDirectiveBlock(first));

  cli.applyDirectiveToTargets(home); // re-run must not duplicate
  const second = fs.readFileSync(claudeMd, 'utf8');
  const occurrences = second.split(cli.DIRECTIVE_MARKER_START).length - 1;
  assert.equal(occurrences, 1);
});

test('applyDirectiveToTargets skips files that do not exist', () => {
  const home = tmpHome(); // no .codex/AGENTS.md created
  cli.applyDirectiveToTargets(home); // must not throw or create the file
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
});

test('removeDirectiveFromTargets removes a previously-inserted block and is a no-op when absent', () => {
  const home = tmpHome();
  const agentsMd = path.join(home, '.codex', 'AGENTS.md');
  fs.mkdirSync(path.dirname(agentsMd), { recursive: true });
  fs.writeFileSync(agentsMd, '# Codex rules\n');

  cli.applyDirectiveToTargets(home);
  assert.ok(cli.hasDirectiveBlock(fs.readFileSync(agentsMd, 'utf8')));

  cli.removeDirectiveFromTargets(home);
  const cleaned = fs.readFileSync(agentsMd, 'utf8');
  assert.ok(!cli.hasDirectiveBlock(cleaned));
  assert.ok(cleaned.includes('# Codex rules'));

  cli.removeDirectiveFromTargets(home); // no-op, must not throw
  assert.ok(!cli.hasDirectiveBlock(fs.readFileSync(agentsMd, 'utf8')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `cli.applyDirectiveToTargets is not a function` (and similarly for `hasDirectiveBlock`, `removeDirectiveFromTargets`).

- [ ] **Step 3: Implement the directive feature**

In `scripts/manage-gateway-config.js`, add after the existing `DEFAULT_GATEWAY_URL` constant:

```js
const DIRECTIVE_MARKER_START = "<!-- LOCAL_TESTER_START -->";
const DIRECTIVE_MARKER_END = "<!-- LOCAL_TESTER_END -->";
/* Mirrors the shipped skill's existing triggers (scout / verdict / triage /
   regression / changed-files-review) as a standing default-on rule instead of
   a heuristic description, so the model reaches for these tools without
   needing to be asked each time. */
const DIRECTIVE_BLOCK = `${DIRECTIVE_MARKER_START}
## Local Tester (default-on)

Always use the \`local_tester\` MCP tools by default:

- \`scout_codebase\` before broad exploration of an unfamiliar area.
- \`run_test_verdict\` before claiming a change works.
- \`run_failure_triage\` on test/build/lint failures instead of reading raw logs.
- \`run_regression_check\` before merging.
- \`run_changed_files_review\` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
${DIRECTIVE_MARKER_END}
`;

/* Global instruction files each client reads on its own (not MCP config), so
   this is a separate target list from getManagedTargets — different files,
   different mutation shape (raw text, not JSON). */
function getDirectiveTargets(home) {
  const homeDir = path.resolve(home || process.env.HOME || os.homedir());
  return [
    { label: "Claude Code global instructions", filePath: path.join(homeDir, ".claude", "CLAUDE.md") },
    { label: "Codex global instructions", filePath: path.join(homeDir, ".codex", "AGENTS.md") },
    { label: "Antigravity/Gemini global instructions", filePath: path.join(homeDir, ".gemini", "GEMINI.md") },
  ];
}

function hasDirectiveBlock(content) {
  return content.includes(DIRECTIVE_MARKER_START) && content.includes(DIRECTIVE_MARKER_END);
}

function applyDirectiveBlock(content) {
  const startIdx = content.indexOf(DIRECTIVE_MARKER_START);
  const endIdx = content.indexOf(DIRECTIVE_MARKER_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const before = content.slice(0, startIdx);
    const after = content.slice(endIdx + DIRECTIVE_MARKER_END.length);
    return `${before}${DIRECTIVE_BLOCK}${after}`;
  }
  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${DIRECTIVE_BLOCK}`;
}

function removeDirectiveBlock(content) {
  const startIdx = content.indexOf(DIRECTIVE_MARKER_START);
  const endIdx = content.indexOf(DIRECTIVE_MARKER_END);
  if (startIdx === -1 || endIdx === -1) {
    return content;
  }
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + DIRECTIVE_MARKER_END.length);
  return `${before}${after}`.replace(/\n{3,}/g, "\n\n");
}

function directiveBackupRoot(home) {
  return path.join(path.resolve(home || process.env.HOME || os.homedir()), ".local-tester-mcp", "backups");
}

function applyDirectiveToTargets(home) {
  const backupRoot = directiveBackupRoot(home);
  for (const target of getDirectiveTargets(home)) {
    if (!fs.existsSync(target.filePath)) {
      continue;
    }
    backupFileIfPresent(target.filePath, backupRoot);
    const content = fs.readFileSync(target.filePath, "utf8");
    fs.writeFileSync(target.filePath, applyDirectiveBlock(content));
  }
}

function removeDirectiveFromTargets(home) {
  const backupRoot = directiveBackupRoot(home);
  for (const target of getDirectiveTargets(home)) {
    if (!fs.existsSync(target.filePath)) {
      continue;
    }
    const content = fs.readFileSync(target.filePath, "utf8");
    if (!hasDirectiveBlock(content)) {
      continue;
    }
    backupFileIfPresent(target.filePath, backupRoot);
    fs.writeFileSync(target.filePath, removeDirectiveBlock(content));
  }
}

function printDirectiveStatus(home) {
  for (const target of getDirectiveTargets(home)) {
    if (!fs.existsSync(target.filePath)) {
      console.log(`- ${target.label} (default-on directive): file not found`);
      continue;
    }
    const content = fs.readFileSync(target.filePath, "utf8");
    console.log(`- ${target.label} (default-on directive): ${hasDirectiveBlock(content) ? "configured" : "not configured"}`);
  }
}
```

Update `normalizeCommand` to accept the two new commands:

```js
if (["setup", "update", "delete", "status", "help", "enable-defaults", "disable-defaults"].includes(lowered)) {
```

Update `printHelp`:

```js
function printHelp() {
  console.log(`Usage: node scripts/manage-gateway-config.js [setup|update|delete|status|enable-defaults|disable-defaults]

Commands:
  setup            Prompt for your gateway proxy token and write it to all managed clients
  update           Prompt again and replace the managed gateway values
  delete           Remove managed gateway values from all managed clients
  status           Show current managed gateway values, GUI-session state, and directive status
  enable-defaults  Write a default-on usage directive into Claude/Codex/Antigravity global instructions
  disable-defaults Remove the default-on usage directive from those files

When no command is provided, the script prompts for one interactively.`);
}
```

Update `promptForCommand` to list and accept 6 options (add `5. enable-defaults`, `6. disable-defaults`, matching them to the respective return strings, following the existing numbered-menu pattern).

Add handlers in `main()`, alongside the existing `if (resolvedCommand === "status")` block:

```js
if (resolvedCommand === "enable-defaults") {
  applyDirectiveToTargets();
  console.log("");
  console.log("Default-on usage directive written to all managed global instructions files.");
  printDirectiveStatus();
  return;
}

if (resolvedCommand === "disable-defaults") {
  removeDirectiveFromTargets();
  console.log("");
  console.log("Default-on usage directive removed from all managed global instructions files.");
  printDirectiveStatus();
  return;
}
```

Update `printStatus` to also report directive state:

```js
function printStatus(home) {
  console.log("");
  console.log("Current managed status:");
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const values = target.getValues(config);
    console.log(`- ${target.label}: ${summarizeValues(values)}`);
  }
  console.log(`- macOS GUI session (launchctl): ${summarizeValues(readLaunchctlValues())}`);
  printDirectiveStatus(home);
}
```

Update `module.exports` to add the new functions/constants:

```js
module.exports = {
  GATEWAY_ENV_KEYS,
  DEFAULT_GATEWAY_URL,
  DIRECTIVE_MARKER_START,
  DIRECTIVE_MARKER_END,
  DIRECTIVE_BLOCK,
  sanitizeEnvObject,
  mergeManagedEnvValues,
  getManagedTargets,
  applyToTargets,
  collectCurrentValues,
  applyLaunchctlValues,
  readLaunchctlValues,
  clearLaunchctlValues,
  getDirectiveTargets,
  hasDirectiveBlock,
  applyDirectiveBlock,
  removeDirectiveBlock,
  applyDirectiveToTargets,
  removeDirectiveFromTargets,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all prior tests plus the 3 new ones (30 total, up from 27).

- [ ] **Step 5: Commit**

```bash
git add scripts/manage-gateway-config.js test/scripts/gateway-config.test.ts
git commit -m "feat(config): add enable-defaults/disable-defaults for a standing usage directive"
```

---

### Task 2: opencode generator (`scripts/generate-plugin-opencode.js`)

**Files:**
- Create: `scripts/generate-plugin-opencode.js`
- Modify: `package.json` (add `build:plugin:opencode` script, include it in `build:plugin`)
- Modify: `.gitignore` (add `plugin/opencode/`)

**Interfaces:**
- Consumes: `dist/*.js` (must exist — run `npm run build` first), `skill/skill-example.md` (source skill content, same file the other three generators copy).
- Produces: `plugin/opencode/server/`, `plugin/opencode/skills/local-llm-subagent/SKILL.md`, `plugin/opencode/mcp-snippet.jsonc`, `plugin/opencode/README.md` — consumed only by the end user's manual copy/merge steps, not by other tasks in this plan.

- [ ] **Step 1: Create the generator script**

Create `scripts/generate-plugin-opencode.js`:

```js
const fs = require("fs");
const path = require("path");
const os = require("os");

/* opencode plugin flow.
   Generates a portable local_tester bundle under plugin/opencode/ for opencode
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
     plugin/opencode/skills/local-llm-subagent/SKILL.md
     plugin/opencode/mcp-snippet.jsonc           (block to merge into opencode.jsonc's "mcp")
     plugin/opencode/README.md
   This output is gitignored (see plugin/opencode/ in .gitignore) — like
   Antigravity, there is no marketplace to fetch it from, so nothing needs to
   be committed for install.
   Do not edit generated files by hand; run `npm run build:plugin:opencode`. */

const rootDir = path.resolve(__dirname, "..");
const pluginDir = path.join(rootDir, "plugin", "opencode");
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

/* Conventional install location the README tells the user to copy the server
   to, so the path baked into mcp-snippet.jsonc matches what actually exists
   on disk once they follow the instructions. */
const installedServerDir = path.join(os.homedir(), ".config", "opencode", "local-tester-server");

console.log("Generating opencode plugin structure...");

try {
  fs.rmSync(pluginDir, { recursive: true, force: true });
  fs.mkdirSync(skillsDir, { recursive: true });
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

  /* Same self-locating idiom as the Antigravity launcher: no plugin-root env
     var is applicable here (opencode has none for statically-registered MCP
     commands), so the launcher finds its own directory directly. */
  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.data"
mkdir -p "$DATA"

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

  /* opencode's config docs (opencode.ai/docs/config) show "{env:VAR}" style
     interpolation for pulling values from the process environment at
     runtime, so the token never has to be hardcoded here. */
  const mcpSnippet = {
    local_tester: {
      type: "local",
      command: ["bash", path.join(installedServerDir, "start.sh")],
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

  const readme = `# local-tester bundle (opencode)

Bundles the \`local_tester\` MCP server and the \`${SKILL_NAME}\` skill for
[opencode](https://opencode.ai). opencode has no plugin/marketplace mechanism
for MCP servers or skills, so this bundle is installed by copying files and
merging one JSON snippet by hand.

> Generated by \`npm run build:plugin:opencode\`. Do not edit files under
> \`plugin/\` by hand. This output is gitignored — there is no marketplace to
> fetch it from, so nothing needs to be committed.

## Contents

- \`server/\` — the compiled MCP server plus a self-locating launcher
  (\`start.sh\`) and a minimal \`package.json\`.
- \`skills/${SKILL_NAME}/SKILL.md\` — usage guidance, copied from
  \`skill/skill-example.md\`. opencode discovers skills from \`SKILL.md\` files
  under fixed paths — see Install below.
- \`mcp-snippet.jsonc\` — the exact block to merge into your \`opencode.jsonc\`'s
  \`"mcp"\` object.

## Install

1. Copy the server bundle to a stable location:

   \`\`\`bash
   mkdir -p ~/.config/opencode/local-tester-server
   cp -R plugin/opencode/server/* ~/.config/opencode/local-tester-server/
   \`\`\`

2. Copy the skill so opencode discovers it globally:

   \`\`\`bash
   mkdir -p ~/.config/opencode/skills/${SKILL_NAME}
   cp -R plugin/opencode/skills/${SKILL_NAME}/* ~/.config/opencode/skills/${SKILL_NAME}/
   \`\`\`

3. Merge the contents of \`mcp-snippet.jsonc\` into your
   \`~/.config/opencode/opencode.jsonc\`'s top-level \`"mcp"\` object (create the
   \`"mcp"\` key if it does not exist yet).

4. Provide your gateway token: from a repo clone run
   \`npm run gateway:config -- setup\` and paste your token (it is written to
   the macOS GUI session via \`launchctl\`, which opencode inherits), or set
   \`LLM_GATEWAY_TOKEN\` / \`LLM_GATEWAY_URL\` in your own shell/session
   environment before launching opencode.

5. Restart opencode so it picks up the new MCP server and skill.

**Requirements:** \`node\`, \`npm\`, and \`bash\` on \`PATH\`; network access on
first run only (to install the bundled server's single runtime dependency into
a \`.data/\` directory next to itself).

To pick up changes, re-run \`npm run build:plugin:opencode\`, re-copy the
\`server/\` and \`skills/\` contents, and re-merge \`mcp-snippet.jsonc\` if it
changed.
`;
  fs.writeFileSync(path.join(pluginDir, "README.md"), readme);

  console.log("opencode plugin generated successfully under plugin/opencode/");
} catch (error) {
  console.error("Failed to generate opencode plugin:", error);
  process.exit(1);
}
```

- [ ] **Step 2: Wire the npm script**

In `package.json`, add to `"scripts"` (keep alphabetically near the other `build:plugin:*` entries):

```json
    "build:plugin:opencode": "node scripts/generate-plugin-opencode.js",
```

Update the `build:plugin` script to include it:

```json
    "build:plugin": "npm run build:plugin:antigravity && npm run build:plugin:claude && npm run build:plugin:codex && npm run build:plugin:opencode",
```

(Task 3 will extend this line again to add `:cursor` — do not worry about that yet.)

- [ ] **Step 3: Add the gitignore entry**

In `.gitignore`, add after the existing `plugin/antigravity/` entry:

```
# opencode plugin output is generated; not tracked (no marketplace to fetch it from).
plugin/opencode/
```

- [ ] **Step 4: Generate and verify**

Run:
```bash
npm run build
npm run build:plugin:opencode
```
Expected: `opencode plugin generated successfully under plugin/opencode/`. Confirm the layout:
```bash
find plugin/opencode -type f
git status --short plugin/opencode   # must print nothing (ignored)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-plugin-opencode.js package.json .gitignore
git commit -m "feat(plugins): add opencode generator (bundle + SKILL.md + mcp snippet)"
```

---

### Task 3: Cursor generator (`scripts/generate-plugin-cursor.js`)

**Files:**
- Create: `scripts/generate-plugin-cursor.js`
- Modify: `package.json` (add `build:plugin:cursor`, extend `build:plugin`)
- Modify: `.gitignore` (add `plugin/cursor/`)

**Interfaces:**
- Consumes: same as Task 2 (`dist/*.js`, `skill/skill-example.md` is NOT used here — Cursor uses a rules file, not a skill, so the directive text is authored directly in this script instead).
- Produces: `plugin/cursor/server/`, `plugin/cursor/rules/local-tester.mdc`, `plugin/cursor/mcp-snippet.json`, `plugin/cursor/README.md`.

- [ ] **Step 1: Create the generator script**

Create `scripts/generate-plugin-cursor.js`:

```js
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

  const startSh = `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.data"
mkdir -p "$DATA"

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
```

- [ ] **Step 2: Wire the npm script**

In `package.json`, add:

```json
    "build:plugin:cursor": "node scripts/generate-plugin-cursor.js",
```

Update `build:plugin` to run all five:

```json
    "build:plugin": "npm run build:plugin:antigravity && npm run build:plugin:claude && npm run build:plugin:codex && npm run build:plugin:opencode && npm run build:plugin:cursor",
```

- [ ] **Step 3: Add the gitignore entry**

In `.gitignore`, add after the `plugin/opencode/` entry from Task 2:

```
# Cursor plugin output is generated; not tracked (no marketplace to fetch it from).
plugin/cursor/
```

- [ ] **Step 4: Generate and verify**

```bash
npm run build:plugin:cursor
find plugin/cursor -type f
git status --short plugin/cursor   # must print nothing (ignored)
```

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-plugin-cursor.js package.json .gitignore
git commit -m "feat(plugins): add Cursor generator (bundle + .mdc rule + mcp snippet)"
```

---

### Task 4: Version sweep, docs, and full verification

**Files:**
- Modify: `scripts/generate-plugin-antigravity.js`, `scripts/generate-plugin-claude.js`, `scripts/generate-plugin-codex.js` (VERSION bump only)
- Modify: `README.md`
- Modify: `AGENTS.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the finished Task 1–3 output (all five generators, `enable-defaults`/`disable-defaults`).
- Produces: nothing consumed by later tasks — this is the plan's terminal task.

- [ ] **Step 1: Bump VERSION to 1.5.0 in the three existing generators**

In `scripts/generate-plugin-antigravity.js`, `scripts/generate-plugin-claude.js`, and `scripts/generate-plugin-codex.js`, change:

```js
  const VERSION = "1.4.0";
```
to:
```js
  const VERSION = "1.5.0";
```

(Task 2 and Task 3's generators already hardcode `"1.5.0"` — no change needed there.)

- [ ] **Step 2: Update `README.md`**

In the `### 2. Provide your token` section (around line 23), add a paragraph after the existing shortcut/manual instructions:

```markdown
To make the tools default-on (used automatically unless you say otherwise) in Claude Code, Codex, and Antigravity, also run:

```bash
npm run gateway:config -- enable-defaults
```

This writes a standing directive into each client's global instructions file (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`). Run `npm run gateway:config -- disable-defaults` to remove it, or `npm run gateway:config -- status` to check whether it's set.
```

In the `## Plugins` section, after the existing `### Codex` subsection and before `## Typical Agent Workflow`, add two new subsections:

```markdown
### opencode

opencode has no plugin/marketplace mechanism for MCP servers or skills, so install is a manual copy + merge:

1. `npm run build && npm run build:plugin:opencode`
2. Copy `plugin/opencode/server/` to `~/.config/opencode/local-tester-server/` and `plugin/opencode/skills/local-llm-subagent/` to `~/.config/opencode/skills/local-llm-subagent/`.
3. Merge `plugin/opencode/mcp-snippet.jsonc` into your `~/.config/opencode/opencode.jsonc`'s `"mcp"` object.
4. Provide your token (`npm run gateway:config -- setup`) and restart opencode.

Full instructions: [`plugin/opencode/README.md`](plugin/opencode/README.md) (generated).

### Cursor

Cursor also has no plugin/marketplace mechanism:

1. `npm run build && npm run build:plugin:cursor`
2. Copy `plugin/cursor/server/` to `~/.cursor/local-tester-server/`.
3. Merge `plugin/cursor/mcp-snippet.json` into `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per project).
4. Copy `plugin/cursor/rules/local-tester.mdc` into each project's `.cursor/rules/` — Cursor has no filesystem-writable global rule, so this only applies per-project unless you also add an equivalent rule via Cursor Settings.
5. Provide your token (`npm run gateway:config -- setup`) and restart Cursor.

Full instructions: [`plugin/cursor/README.md`](plugin/cursor/README.md) (generated).
```

- [ ] **Step 3: Update `AGENTS.md` and `CLAUDE.md`**

In both files, in the `## Plugin Generators` section, after the existing three generator bullets, add:

```markdown
- `scripts/generate-plugin-opencode.js` (`npm run build:plugin:opencode`) → `plugin/opencode/`. Gitignored — opencode has no plugin/marketplace mechanism; copy the server + skill and merge the MCP snippet by hand (see the generated README).
- `scripts/generate-plugin-cursor.js` (`npm run build:plugin:cursor`) → `plugin/cursor/`. Gitignored — Cursor has no plugin/marketplace mechanism; copy the server, merge the MCP snippet, and copy the `.mdc` rule per project by hand (see the generated README).
```

In both files, find this exact line (in the `## Plugin Generators` section):

```markdown
- **Bump `VERSION` in the generator script for every change that touches that plugin's output — including wording-only edits to `skill/skill-example.md`.** Run `npm run build:plugin` and commit the regenerated output (Claude and Codex only; Antigravity is gitignored).
```

Replace it with:

```markdown
- **Bump `VERSION` in the generator script for every change that touches that plugin's output — including wording-only edits to `skill/skill-example.md`.** Run `npm run build:plugin` and commit the regenerated output (Claude and Codex only; Antigravity, opencode, and Cursor are gitignored).
```

Also, in the `## Repository Shape` section of both files, find the line documenting `scripts/manage-gateway-config.js` (search for `manage-gateway-config.js`) and add one sentence noting the new subcommands, e.g. append: ` \`enable-defaults\`/\`disable-defaults\` write or remove a standing default-on usage directive in Claude/Codex/Antigravity's global instructions files.`

- [ ] **Step 4: Full verification**

```bash
npm run build && npm run build:gateway && npm test
```
Expected: both builds clean, all tests passing (30/30, per Task 1).

```bash
npm run build:plugin
```
Expected: all five generators succeed in sequence.

```bash
grep -rn "1.5.0" plugin/claude/.claude-plugin/plugin.json plugin/codex/.codex-plugin/plugin.json plugin/antigravity/plugin.json plugin/opencode/server/package.json plugin/cursor/server/package.json
```
Expected: five matches, one per file.

```bash
grep -rli "openrouter" plugin/claude plugin/codex plugin/antigravity plugin/opencode plugin/cursor scripts src 2>/dev/null && echo "FAIL: OpenRouter reference remains" || echo "OK: no OpenRouter references"
```
Expected: `OK: no OpenRouter references` (case-insensitive, per the earlier gateway-cleanup review's lesson about a case-sensitive grep missing mixed-case hits).

```bash
git status --ignored --short | grep -E "plugin/(opencode|cursor)"
```
Expected: both directories listed under ignored output (confirms they exist on disk and are correctly gitignored, not silently untracked-and-uncommitted by mistake).

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-plugin-antigravity.js scripts/generate-plugin-claude.js scripts/generate-plugin-codex.js README.md AGENTS.md CLAUDE.md
git commit -m "docs: bump plugins to 1.5.0, document enable-defaults and opencode/Cursor generators"
```

---

## Final Whole-Branch Review

After Task 4, dispatch the final whole-branch code reviewer (most capable available model) per `superpowers:subagent-driven-development`, covering the full diff since this plan's first commit. Pay particular attention to:

- Whether the `enable-defaults` marker-block logic actually produces valid Markdown when inserted into a file that has no trailing newline, or when the file is empty.
- Whether the opencode/Cursor generators' baked absolute paths (`os.homedir()`-derived) match exactly what each generator's own README tells the user to copy the server to.
- Whether `.gitignore` and `package.json` changes from Task 2 and Task 3 don't conflict (both touch the same `build:plugin` line and the same region of `.gitignore` — confirm the final state has all five scripts and both new ignore entries, not one overwriting the other).
