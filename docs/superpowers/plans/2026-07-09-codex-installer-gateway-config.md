# Codex Installer Gateway Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Codex installer run register the credential-bearing Node MCP server in `~/.codex/config.toml`, including when the Codex plugin CLI succeeds.

**Architecture:** Keep marketplace/plugin installation for skill discovery, but make the direct `mcp_servers.token_optimizer` registration the runtime configuration written by `installCodex`. The existing TOML upsert helper remains the single boundary for replacing legacy launchers and managed provider fields.

**Tech Stack:** Node.js CommonJS installer, Node built-in test runner, TypeScript test compilation, npm package assembly.

## Global Constraints

- Preserve all non-Token-Optimizer TOML content.
- Write only provider-managed environment fields; never emit a gateway token for BYOK, local, or skipped modes.
- Use `node server/start.js` on Windows and POSIX platforms.
- Update installer documentation and bump the installer package version before packing.
- Regenerate installer assets through `npm run build:installer`; do not edit `packages/installer/assets/` manually.

---

### Task 1: Cover successful Codex plugin installation and make direct registration unconditional

**Files:**
- Modify: `test/installer/install-core.test.ts`
- Modify: `packages/installer/lib/install-core.js`

**Interfaces:**
- Consumes: `installCodex(options)` and `upsertCodexTomlServer(content, startJsPath, values)`.
- Produces: A Codex `config.toml` section with `command = 'node'`, the installed `server/start.js`, and the chosen provider environment.

- [ ] **Step 1: Write the failing regression test**

Add a test that supplies a temporary `codex` executable which accepts the two plugin commands, then invokes `installCodex` without `skipClientCommands`:

```ts
test('installCodex writes the credential-bearing direct server after plugin CLI registration succeeds', () => {
  const home = tmpDir('to-installer-home-');
  const assetsRoot = tmpDir('to-installer-assets-');
  const installRoot = path.join(home, '.token-optimizer');
  writeFixtureAssets(assetsRoot);
  // Create a PATH-preferred fake codex executable that exits successfully.
  installer.installCodex({ home, assetsRoot, installRoot, gatewayToken: 'person-token', skipLaunchctl: true });
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.includes("command = 'node'"));
  assert.ok(toml.includes("LLM_GATEWAY_TOKEN = 'person-token'"));
  assert.ok(toml.includes(path.join(installRoot, 'plugin', 'codex', 'server', 'start.js')));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --test-name-pattern="plugin CLI registration succeeds"`

Expected: the test fails because no direct `config.toml` server is written after the plugin CLI path succeeds.

- [ ] **Step 3: Implement the minimal Codex install change**

Replace the conditional fallback registration in `installCodex` with an unconditional call that writes the direct server after copying assets. Keep the marketplace commands best-effort and retain the skill copy:

```js
tryClientCommand("codex", ["plugin", "marketplace", "add", options.installRoot], options);
tryClientCommand("codex", ["plugin", "add", "token-optimizer", "--marketplace", CODEX_MARKETPLACE_NAME], options);
writeCodexDirectServer({ ...options, pluginDest });
```

The extracted helper must call `upsertCodexTomlServer` with `buildProviderValues(options)` and copy the Codex skill directory. Add a short block comment above the modified flow explaining that the direct registration is the credential-bearing runtime path.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --test-name-pattern="plugin CLI registration succeeds"`

Expected: PASS.

- [ ] **Step 5: Run the installer test suite**

Run: `npm test -- --test-name-pattern="install(Codex|Claude)|upsertCodexTomlServer|plugin CLI registration succeeds"`

Expected: PASS, including the existing legacy-launcher replacement and provider-field tests.

### Task 2: Document, version, package, and validate the release artifact

**Files:**
- Modify: `packages/installer/README.md`
- Modify: `README.md`
- Modify: `packages/installer/package.json`
- Generated: `packages/installer/assets/`

**Interfaces:**
- Consumes: The direct Codex registration behavior from Task 1.
- Produces: Accurate installer guidance and a new npm-publishable installer version containing the generated assets.

- [ ] **Step 1: Update installer documentation**

State that the Codex installer always writes the credential-bearing direct MCP server in `~/.codex/config.toml`, while marketplace assets remain installed for skill discovery. Remove language that limits direct registration to unavailable Codex CLI cases.

- [ ] **Step 2: Bump the installer patch version**

Update `packages/installer/package.json` from `1.9.1` to `1.9.2` so npm can accept the corrected release.

- [ ] **Step 3: Rebuild and pack generated assets**

Run: `npm run build:installer`

Expected: TypeScript build and every plugin generator complete, then installer assets are recopied from generated plugin outputs.

- [ ] **Step 4: Review generated artifact contents**

Run: `npm pack ./packages/installer --dry-run`

Expected: output lists `lib/install-core.js` and `assets/plugin/codex/server/start.js`; no credentials appear in the archive listing.

- [ ] **Step 5: Verify the complete repository test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit the focused release preparation**

```bash
git add packages/installer/lib/install-core.js test/installer/install-core.test.ts packages/installer/README.md README.md packages/installer/package.json packages/installer/assets
git commit -m "fix: configure Codex installer gateway runtime"
```

Do not publish to npm; leave publication as a release-owner action.
