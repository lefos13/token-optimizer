# Token Optimizer Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the MCP server, plugins, marketplace entries, skills, and user-facing documentation from Local Tester / Local LLM Subagent to Token Optimizer.

**Architecture:** Treat generator scripts and source docs as the source of truth, then regenerate plugin outputs. Rename user-facing plugin and skill identities to Token Optimizer while making compatibility-sensitive runtime names explicit, because MCP server keys, skill folder names, config paths, and env vars affect installed clients.

**Tech Stack:** Node.js generator scripts, TypeScript MCP server, Markdown skill/docs, JSON plugin manifests, shell launchers.

## Global Constraints

- Follow `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/AGENTS.md`.
- Add block comments (`/* ... */`) at the top of large added or modified code sections when the logic is not immediately obvious.
- Do not run `npm install` in the sandbox.
- Do not manually edit generated plugin files except to inspect them; update generator scripts and run `npm run build:plugin`.
- Run `npm run build` after TypeScript changes.
- Run `npm run build:plugin` after generator or skill documentation changes.
- Bump every generated plugin package version when plugin output changes.
- Preserve MCP tool contracts unless the rebrand explicitly changes the server key or skill invocation name.

---

## File Structure

- Modify `package.json` and `package-lock.json`: npm package name and description.
- Modify `src/index.ts`: MCP server metadata name.
- Modify `src/analytics-ui.ts`: analytics UI title/copy and config directory if the product storage name changes.
- Modify `src/llm.ts`: keep `LOCAL_LLM_*` env vars as compatibility aliases, and optionally add `TOKEN_OPTIMIZER_*` aliases if the product should stop exposing Local LLM naming.
- Modify `scripts/generate-plugin-antigravity.js`: Antigravity plugin name, display copy, skill folder name, launcher log names, server package name, generated README, and version.
- Modify `scripts/generate-plugin-claude.js`: Claude plugin manifest, marketplace name, plugin install command copy, skill folder name, server package name, generated README, and version.
- Modify `scripts/generate-plugin-codex.js`: Codex plugin manifest, marketplace entry, interface display copy, default prompts, skill folder name, server package name, generated README, and version.
- Modify `scripts/generate-plugin-opencode.js`: manual bundle server path, MCP snippet key, skill folder name, generated README, and server package name.
- Modify `scripts/generate-plugin-cursor.js`: manual bundle server path, Cursor rule file name/copy, MCP snippet key, generated README, and server package name.
- Modify `scripts/manage-gateway-config.js`: default-on instruction block, backup directory, Antigravity plugin path, and MCP server key handling.
- Modify `README.md`: all install docs, marketplace names, skill names, config paths, analytics names, and migration guidance.
- Modify `skill/skill-example.md`: skill frontmatter name/description, heading, tool usage text, policy examples, and provider wording.
- Modify `AGENTS.md` and `CLAUDE.md`: repository description and project instructions after the rebrand.
- Regenerate `plugin/claude/**`, `plugin/codex/**`, `.claude-plugin/marketplace.json`, and `.agents/plugins/marketplace.json` via `npm run build:plugin`.
- Inspect gitignored generated outputs under `plugin/antigravity/`, `plugin/opencode/`, and `plugin/cursor/` after generation, but do not rely on committing them.

## Naming Decisions

Use these exact names unless the user chooses a different casing before implementation:

- Product display name: `Token Optimizer`
- Plugin slug: `token-optimizer`
- Marketplace slug: `token-optimizer-marketplace`
- Skill name/folder: `token-optimizer`
- MCP server key: `token_optimizer`
- MCP tool namespace after reinstall: `mcp__token_optimizer__*`
- Server npm package name: `token-optimizer-mcp`
- Bundled server package name: `token-optimizer-server`
- Analytics config directory: `~/.token-optimizer-analytics`
- Diagnostic config/backup directory: `~/.token-optimizer-mcp`
- Local fallback env vars: keep existing `LOCAL_LLM_*` as aliases for compatibility; add preferred `TOKEN_OPTIMIZER_LLM_*` aliases only if implementation includes a migration layer in `src/llm.ts`.

## Task 1: Rename Core Package And Runtime Metadata

**Files:**
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/package.json`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/package-lock.json`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/src/index.ts`

**Interfaces:**
- Consumes: existing MCP tool registrations from `src/index.ts`.
- Produces: package metadata and MCP server metadata using `token-optimizer-mcp`.

- [ ] **Step 1: Update package metadata**

Change `package.json`:

```json
{
  "name": "token-optimizer-mcp",
  "description": "An MCP server for running workspace validation and turning noisy logs into compact token-saving verdicts."
}
```

Apply the same root package name change in `package-lock.json` at the top-level `name` and `packages[""].name` fields.

- [ ] **Step 2: Update MCP server metadata**

In `src/index.ts`, change the server constructor metadata from:

```ts
name: 'local-tester-mcp'
```

to:

```ts
name: 'token-optimizer-mcp'
```

- [ ] **Step 3: Verify core metadata**

Run:

```bash
npm run build
```

Expected: TypeScript build exits `0`.

## Task 2: Rename Skill Identity And Default Usage Guidance

**Files:**
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/skill/skill-example.md`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/manage-gateway-config.js`

**Interfaces:**
- Consumes: MCP server key decision `token_optimizer`.
- Produces: skill frontmatter `name: token-optimizer` and default-on instruction text referring to `token_optimizer`.

- [ ] **Step 1: Update skill frontmatter**

Replace the first block in `skill/skill-example.md` with:

```markdown
---
name: token-optimizer
description: Use this MCP server to scout codebases, validate code changes, review changed files, triage failures, check regressions, classify command output, and keep raw logs out of context. Trigger when starting codebase scouting, implementing code changes, fixing bugs, touching tests/build/lint behavior, preparing final verification, triaging failures, reviewing changed files, checking regressions, or when the user asks to use Token Optimizer, token optimization, compact verdicts, or avoid reading raw logs.
---
```

- [ ] **Step 2: Replace skill heading and tool namespace examples**

Change:

```markdown
# Local LLM Subagent
Use the `mcp__local_tester` tools
```

to:

```markdown
# Token Optimizer
Use the `mcp__token_optimizer` tools
```

Also update config-policy examples from:

```toml
[plugins."local-tester@local-tester-marketplace".mcp_servers.local_tester]
```

to:

```toml
[plugins."token-optimizer@token-optimizer-marketplace".mcp_servers.token_optimizer]
```

- [ ] **Step 3: Update default-on instruction manager**

In `scripts/manage-gateway-config.js`, change the managed block title and tool namespace:

```markdown
## Token Optimizer (default-on)

Always use the `token_optimizer` MCP tools by default:
```

Update any hardcoded Antigravity plugin path segment from `local-tester` to `token-optimizer`, and update backup roots from `.local-tester-mcp` to `.token-optimizer-mcp`.

- [ ] **Step 4: Run focused tests for config manager**

Run:

```bash
npm test
```

Expected: tests exit `0`, including `test/scripts/gateway-config.test.ts`.

## Task 3: Rename Plugin Generators And Marketplace Metadata

**Files:**
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/generate-plugin-antigravity.js`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/generate-plugin-claude.js`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/generate-plugin-codex.js`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/generate-plugin-opencode.js`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/scripts/generate-plugin-cursor.js`

**Interfaces:**
- Consumes: naming decisions from this plan.
- Produces: generator outputs with Token Optimizer plugin names, marketplace names, skill folders, server package names, and README copy.

- [ ] **Step 1: Update shared generator constants**

In every generator, set:

```js
const SKILL_NAME = "token-optimizer";
```

Where plugin constants exist, set:

```js
const PLUGIN_NAME = "token-optimizer";
```

Update `VERSION` from `1.5.0` to:

```js
const VERSION = "1.6.0";
```

- [ ] **Step 2: Update plugin descriptions and keywords**

Use this description everywhere plugin manifests need one:

```js
const description =
  "Token-saving validation, verification, and triage. Runs workspace commands, keeps raw logs out of context, and returns compact verdicts via the token_optimizer MCP server.";
```

Use keywords:

```js
keywords: ["token-optimizer", "mcp", "verdict", "triage", "validation"]
```

- [ ] **Step 3: Update manifest and marketplace slugs**

Claude and Codex plugin manifests:

```js
name: "token-optimizer"
```

Claude marketplace:

```js
name: "token-optimizer-marketplace",
metadata: { description: "Marketplace for the Token Optimizer plugin" }
```

Codex marketplace plugin entry:

```js
name: "token-optimizer"
```

- [ ] **Step 4: Update MCP server keys in generated config**

Change generated MCP config keys from:

```js
local_tester: {
```

to:

```js
token_optimizer: {
```

Update nearby comments from `mcp__local_tester__*` to `mcp__token_optimizer__*`.

- [ ] **Step 5: Update generated server package names**

Change:

```js
name: "local-tester-server",
description: "Bundled local_tester MCP server (compiled)."
```

to:

```js
name: "token-optimizer-server",
description: "Bundled token_optimizer MCP server (compiled)."
```

- [ ] **Step 6: Update generated README install copy**

Replace install examples consistently:

```bash
claude plugin install token-optimizer@token-optimizer-marketplace
codex plugin marketplace add /path/to/token-optimizer-mcp
mkdir -p ~/.config/opencode/token-optimizer-server
mkdir -p ~/.cursor/token-optimizer-server
cp plugin/cursor/rules/token-optimizer.mdc .cursor/rules/token-optimizer.mdc
```

Keep repository-path examples as `/path/to/token-optimizer-mcp` even if the local checkout directory is still named `local-tester-mcp`.

## Task 4: Update Documentation And Project Instructions

**Files:**
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/README.md`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/AGENTS.md`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/CLAUDE.md`

**Interfaces:**
- Consumes: final plugin names and compatibility choices.
- Produces: user-facing docs that match generated plugin behavior.

- [ ] **Step 1: Update README title and opening**

Replace:

```markdown
# Local LLM subagent
```

with:

```markdown
# Token Optimizer
```

Use this opening sentence:

```markdown
Token Optimizer is an MCP server for running workspace validation commands and turning long build, lint, test, and smoke-check logs into compact verdicts that save chat context.
```

- [ ] **Step 2: Update marketplace and plugin install references**

Replace user-facing plugin names:

```markdown
`local-tester`
`local-tester-marketplace`
`local-llm-subagent`
`local_tester`
```

with:

```markdown
`token-optimizer`
`token-optimizer-marketplace`
`token-optimizer`
`token_optimizer`
```

- [ ] **Step 3: Add migration notes**

Add a README section named `## Migration From Local Tester` with:

```markdown
Existing installs under `local-tester`, `local_tester`, or `local-llm-subagent` should be removed and reinstalled as Token Optimizer so the plugin manifest, MCP server key, skill name, and default usage instructions agree. Existing `.codex-local-test-runs/` workspace logs remain readable; the rebrand does not change per-workspace validation log storage unless a later migration explicitly renames that directory.
```

- [ ] **Step 4: Update project instruction files**

In `AGENTS.md` and `CLAUDE.md`, update the repository description to:

```markdown
This repository contains the `token-optimizer-mcp` server used by the `token-optimizer` skill.
```

Update generator descriptions from `local-test-verdict` / `local-tester` to `token-optimizer`.

## Task 5: Decide And Implement Local LLM Env Var Compatibility

**Files:**
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/src/llm.ts`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/README.md`
- Modify: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/skill/skill-example.md`

**Interfaces:**
- Consumes: existing `LOCAL_LLM_*` env vars.
- Produces: preferred Token Optimizer env vars with backwards compatibility.

- [ ] **Step 1: Add preferred env var aliases**

In `src/llm.ts`, add preferred env names before falling back to existing names:

```ts
const TASK_MODEL_ENV: Record<LlmTaskType, { preferred: string; legacy: string }> = {
  verdict: { preferred: 'TOKEN_OPTIMIZER_LLM_VERDICT_MODEL', legacy: 'LOCAL_LLM_VERDICT_MODEL' },
  triage: { preferred: 'TOKEN_OPTIMIZER_LLM_TRIAGE_MODEL', legacy: 'LOCAL_LLM_TRIAGE_MODEL' },
  review: { preferred: 'TOKEN_OPTIMIZER_LLM_REVIEW_MODEL', legacy: 'LOCAL_LLM_REVIEW_MODEL' },
  digest: { preferred: 'TOKEN_OPTIMIZER_LLM_DIGEST_MODEL', legacy: 'LOCAL_LLM_DIGEST_MODEL' },
  scout: { preferred: 'TOKEN_OPTIMIZER_LLM_SCOUT_MODEL', legacy: 'LOCAL_LLM_SCOUT_MODEL' },
  query: { preferred: 'TOKEN_OPTIMIZER_LLM_QUERY_MODEL', legacy: 'LOCAL_LLM_QUERY_MODEL' },
};
```

Resolve base URL and model with preferred-first fallback:

```ts
apiUrl: process.env.TOKEN_OPTIMIZER_LLM_API_URL || process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL,
model: process.env[modelEnv.preferred] || process.env[modelEnv.legacy] || process.env.TOKEN_OPTIMIZER_LLM_MODEL || process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL,
```

- [ ] **Step 2: Document both preferred and legacy env vars**

In README and skill docs, describe `TOKEN_OPTIMIZER_LLM_*` as preferred and `LOCAL_LLM_*` as supported legacy aliases.

- [ ] **Step 3: Build after TypeScript change**

Run:

```bash
npm run build
```

Expected: TypeScript build exits `0`.

## Task 6: Regenerate Plugin Outputs

**Files:**
- Generated: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/.claude-plugin/marketplace.json`
- Generated: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/.agents/plugins/marketplace.json`
- Generated: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/plugin/claude/**`
- Generated: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/plugin/codex/**`
- Generated but gitignored: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/plugin/antigravity/**`
- Generated but gitignored: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/plugin/opencode/**`
- Generated but gitignored: `/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp/plugin/cursor/**`

**Interfaces:**
- Consumes: updated generators, compiled `dist/`, and `skill/skill-example.md`.
- Produces: Token Optimizer plugin artifacts.

- [ ] **Step 1: Regenerate all plugin outputs**

Run:

```bash
npm run build:plugin
```

Expected: all five generator scripts exit `0`.

- [ ] **Step 2: Inspect generated committed artifacts**

Run:

```bash
rg -n --hidden --glob '!node_modules/**' --glob '!.git/**' --glob '!dist/**' --glob '!plugin/*/server/**' 'local[-_ ]tester|Local Tester|local-test-verdict|local-llm-subagent|Local LLM Subagent|local llm subagent' .claude-plugin .agents plugin/claude plugin/codex README.md skill AGENTS.md CLAUDE.md scripts src package.json package-lock.json
```

Expected: no stale user-facing Local Tester or Local LLM Subagent brand references remain. Matches for `LOCAL_LLM_*` are acceptable only where documented as legacy aliases.

## Task 7: Final Verification And Review

**Files:**
- Inspect: `git diff --stat`
- Inspect: all changed files from `git diff --name-only`

**Interfaces:**
- Consumes: completed rebrand diff.
- Produces: verified implementation ready for review.

- [ ] **Step 1: Run full validation**

Run:

```bash
npm run build
npm test
npm run build:plugin
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run local tester verdict before completion**

Use the MCP validation tool on the repository:

```json
{
  "workspacePath": "/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp",
  "taskSummary": "Rebrand Local Tester / Local LLM Subagent to Token Optimizer across package metadata, generators, skills, docs, and generated plugin outputs.",
  "testCommand": "npm run build && npm test && npm run build:plugin",
  "autoTriage": true
}
```

Expected: verdict status is passing. If the LLM provider is unavailable, rely on command exit codes and report the provider limitation.

- [ ] **Step 3: Review changed files**

Use the changed-files review tool with the full changed file list. Expected: no high-severity issues around stale names, broken marketplace paths, or mismatched MCP server keys.

- [ ] **Step 4: Report back**

Include:

```markdown
Changed Local Tester / Local LLM Subagent branding to Token Optimizer across package metadata, plugin generators, marketplace manifests, skill docs, README, and generated plugin outputs.

This was necessary because marketplace names, skill names, MCP server keys, generated README copy, and default-on instructions all need to agree; partial rebranding would leave installs with mismatched invocation names or stale tool namespaces.

Verification: npm run build; npm test; npm run build:plugin; local tester verdict or command-exit fallback if the local LLM/gateway was unavailable.

Remaining risk: existing users must remove or reinstall old `local-tester` plugin installs; legacy `LOCAL_LLM_*` env vars remain supported as aliases unless a later breaking migration removes them.
```

## Self-Review

- Spec coverage: the plan covers marketplace, plugin, skill references, generated names, docs, runtime metadata, default-on instructions, and Local LLM wording.
- Placeholder scan: no task depends on an unspecified implementation detail; all names and commands are concrete.
- Type consistency: `token-optimizer`, `token_optimizer`, `token-optimizer-mcp`, and `token-optimizer-marketplace` are used consistently according to the naming decisions.
