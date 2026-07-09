# Launcher Dependency Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make generated Token Optimizer launchers detect and automatically repair incomplete runtime dependency caches, while ensuring Codex marketplace launches receive the OpenRouter BYOK key.

**Architecture:** Keep dependency readiness and repair in the shared `scripts/launcher-template.js` so every generated JavaScript launcher has identical behavior. The launcher will validate resolvable MCP SDK and Zod entry points, remove only its owned `node_modules` tree when invalid, reinstall, and validate again. Generated POSIX launchers will delegate dependency setup to the JavaScript launcher, and the Codex generator will forward the BYOK environment key.

**Tech Stack:** Node.js CommonJS launchers, TypeScript `node:test`, npm plugin generators, Markdown documentation.

## Global Constraints

- Preserve all existing MCP tool names, inputs, outputs, and provider-selection behavior.
- Keep stdout exclusively for MCP JSON-RPC; diagnostics and npm output go to stderr.
- Delete only `node_modules` inside the launcher-owned data directory.
- Add concise block comments above substantial modified logic.
- Bump all five plugin generator versions from `1.10.2` to `1.10.3` and the installer from `1.9.3` to `1.9.4`.
- Do not modify unrelated changes in `gateway/README.md`, `gateway/src/email.ts`, or `test/gateway/email.test.ts`.

---

### Task 1: Reproduce and repair incomplete launcher caches

**Files:**
- Create: `test/scripts/launcher-template.test.ts`
- Modify: `scripts/launcher-template.js`

**Interfaces:**
- Consumes: `buildStartJs(): string` from `scripts/launcher-template.js`.
- Produces: generated `start.js` source that validates `@modelcontextprotocol/sdk/server/index.js` and `zod/v3`, repairs invalid caches, and exits clearly if repair remains invalid.

- [ ] **Step 1: Write the failing behavioral test**

Create a temporary generated server containing the output of `buildStartJs()`, a matching cached manifest, an existing but incomplete `node_modules`, and an `index.js` that requires `zod/v3`. Put a fake `npm` executable first on `PATH`; it records that installation ran and creates resolvable SDK and Zod fixture files. Execute `node start.js` and assert exit code `0`, the install marker exists, and the server marker exists:

```ts
test('launcher repairs a matching but incomplete dependency cache before starting', () => {
  const fixture = createLauncherFixture({ incompleteCache: true });
  const result = spawnSync(process.execPath, [fixture.startPath], {
    cwd: fixture.serverDir,
    env: { ...process.env, PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH || ''}` },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(fixture.installMarker));
  assert.ok(fs.existsSync(fixture.serverMarker));
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --test-name-pattern="launcher repairs"`

Expected: FAIL because the current launcher sees the matching manifest plus `node_modules`, skips npm, and the fixture server cannot resolve `zod/v3`.

- [ ] **Step 3: Implement minimal cache validation and repair**

Replace the directory-only readiness check in the generated launcher with resolution-based validation, scoped cleanup, install, and post-install validation:

```js
/* A matching manifest and node_modules directory do not prove npm completed.
   Resolve the entries used at runtime so partial package extraction is repaired. */
function dependenciesResolve() {
  try {
    require.resolve("@modelcontextprotocol/sdk/server/index.js", { paths: [data] });
    require.resolve("zod/v3", { paths: [data] });
    return true;
  } catch {
    return false;
  }
}

const upToDate =
  fs.existsSync(manifestDest) &&
  fs.readFileSync(manifestDest, "utf8") === manifest &&
  dependenciesResolve();

if (!upToDate) {
  fs.rmSync(path.join(data, "node_modules"), { recursive: true, force: true });
  fs.writeFileSync(manifestDest, manifest);
  // existing scoped npm install
  if (!dependenciesResolve()) {
    console.error("token-optimizer launcher: runtime dependencies remain invalid after npm install in " + data);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Add failure and healthy-cache coverage**

Add tests proving a healthy cache does not invoke fake npm and a fake successful npm command that leaves dependencies unresolved exits non-zero with `runtime dependencies remain invalid` on stderr.

- [ ] **Step 5: Run focused launcher tests and verify GREEN**

Run: `npm test -- --test-name-pattern="launcher"`

Expected: all launcher-template tests PASS.

### Task 2: Align generated clients and BYOK propagation

**Files:**
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Create: `test/scripts/plugin-generators.test.ts`
- Modify: `packages/installer/package.json`

**Interfaces:**
- Consumes: shared `buildStartJs()` output.
- Produces: plugin version `1.10.3`, installer version `1.9.4`, POSIX wrappers that start the shared JavaScript launcher, and Codex `.mcp.json` with BYOK passthrough.

- [ ] **Step 1: Write failing generator assertions**

Extend the script tests to generate the Codex plugin and assert:

```ts
const config = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'codex', '.mcp.json'), 'utf8'));
assert.ok(config.mcpServers.token_optimizer.env_vars.includes('OPENROUTER_BYOK_KEY'));
```

Also assert each generator emits version `1.10.3` and each `start.sh` invokes its neighboring `start.js` instead of independently deciding whether dependencies are ready.

- [ ] **Step 2: Run the focused assertions and verify RED**

Run: `npm test -- --test-name-pattern="generated plugin|BYOK"`

Expected: FAIL because Codex omits `OPENROUTER_BYOK_KEY`, versions remain `1.10.2`, and POSIX wrappers contain the old directory-only cache check.

- [ ] **Step 3: Update generators and versions**

In Codex configuration use:

```js
env_vars: [
  "LLM_GATEWAY_TOKEN",
  "LLM_GATEWAY_URL",
  "OPENROUTER_BYOK_KEY",
],
```

Change every generator `VERSION` to `1.10.3`, change the installer package version to `1.9.4`, and update generated `start.sh` content to locate the server then execute `node .../start.js`. Preserve each client's existing data-directory environment by exporting the appropriate `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, or `ANTIGRAVITY_PLUGIN_DATA` value before delegation; add `ANTIGRAVITY_PLUGIN_DATA` to the shared launcher data-directory precedence.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --test-name-pattern="generated plugin|BYOK|launcher"`

Expected: all matching tests PASS.

### Task 3: Document, regenerate, and verify distributable behavior

**Files:**
- Modify: `README.md`
- Modify: `skill/skill-example.md`
- Regenerate: `plugin/claude/**`
- Regenerate: `plugin/codex/**`
- Regenerate: `.claude-plugin/marketplace.json`
- Regenerate: `.agents/plugins/marketplace.json`
- Regenerate: `packages/installer/assets/**`

**Interfaces:**
- Consumes: updated generator and launcher sources.
- Produces: synchronized documentation, committed plugin outputs, and installer assets.

- [ ] **Step 1: Document recovery and Codex BYOK forwarding**

Add a concise setup/troubleshooting note to both required documents: launchers verify actual SDK/Zod resolution, automatically discard only an invalid launcher-owned dependency tree, reinstall it, and forward `OPENROUTER_BYOK_KEY` for BYOK configurations.

- [ ] **Step 2: Run changed-files review before expensive validation**

Call `run_changed_files_review` with `useDiff: true` for the launcher, generators, tests, and documentation. If the tool remains unavailable, inspect `git diff --check` and the focused diff locally and report that fallback.

- [ ] **Step 3: Build and run the full test suite**

Run through `run_test_verdict`: `npm run build && npm test`

Expected: PASS. If Token Optimizer is unavailable, run the command locally and use the smallest relevant failure slice if needed.

- [ ] **Step 4: Regenerate all plugin outputs and installer assets**

Run: `npm run build:plugin && node scripts/build-installer-package.js`

Expected: all five client outputs regenerate; committed Claude/Codex marketplaces and `packages/installer/assets` carry the new launcher, documentation, and versions.

- [ ] **Step 5: Exercise the installed-style launcher fixture and package checks**

Run: `npm test -- --test-name-pattern="launcher|installer|BYOK"`

Run: `npm pack ./packages/installer --dry-run`

Expected: PASS; the packed installer includes regenerated `1.10.3` plugin assets under installer version `1.9.4`.

- [ ] **Step 6: Run final regression verification**

Call `run_test_verdict` for `npm run build && npm test` and `run_regression_check` only if updating the existing baseline is acceptable. Because baseline mutation is not needed here, prefer the read-only verdict plus `git diff --check`. Confirm unrelated gateway/email files remain untouched.

- [ ] **Step 7: Report completion**

Summarize the startup root cause, automatic repair behavior, Codex BYOK propagation fix, version changes, exact verification commands, the live HTTP 200 BYOK probe, and the residual requirement that the exposed OpenRouter key be revoked.
