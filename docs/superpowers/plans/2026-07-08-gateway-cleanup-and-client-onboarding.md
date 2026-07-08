# Gateway Cleanup & Client Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the pre-gateway OpenRouter-direct legacy from the client and tooling, repurpose the config CLI to provision a per-person gateway proxy token across clients, bake the gateway URL into generated plugins, and rewrite the README as an end-user install guide.

**Architecture:** The client (`src/llm.ts`) keeps only `gateway` (primary) → `local` (fallback). The renamed config CLI (`manage-gateway-config.js`) fans one `LLM_GATEWAY_TOKEN` out to every client surface; the gateway URL is a non-secret baked default. Models are entirely server-side.

**Tech Stack:** TypeScript (`src/`), CommonJS Node script (`scripts/`), Node 18+ built-ins only, `node:test`/`node:assert`. Plugin generators are plain Node scripts.

## Global Constraints

- **No new runtime npm dependencies.** Node 18+ built-ins only.
- **Command exit codes remain authoritative.** This work touches transport/config only; no verdict/adjudication logic changes.
- **MCP tool contracts stay stable.** No tool name, input schema, or output field changes.
- **Comment style:** `/* ... */` block comments atop non-obvious added/modified blocks; no `//` stacks.
- **Docs + plugin sync (AGENTS.md):** on env-var/setup change, update `README.md` and `skill/skill-example.md`, bump `VERSION` in all three generators (`generate-plugin-antigravity.js`, `generate-plugin-claude.js`, `generate-plugin-codex.js`) from `1.3.0` to `1.4.0`, then run `npm run build:plugin`. Never hand-edit `plugin/`.
- **Gateway URL default (verbatim):** `https://llm-proxy.lnf.gr/v1`.
- **Managed env keys after this change (verbatim):** `LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN` (plus optional `LOCAL_LLM_*` for local fallback). No `OPENROUTER_*` in any generated config or in `src/llm.ts`.
- **`npm test`** runs `tsc -p tsconfig.test.json && cd .test-build && node --test` (already configured — don't change it).

---

## File Structure

**Modified:**
- `src/llm.ts` — remove OpenRouter-direct provider, constants, per-task model map, and the OpenRouter health branch.
- `test/client/provider.test.ts` — drop OpenRouter references; add a test locking in that `OPENROUTER_API_KEY` alone no longer selects a remote provider.
- `package.json` — rename script `openrouter:config` → `gateway:config`.
- `scripts/generate-plugin-claude.js`, `generate-plugin-codex.js`, `generate-plugin-antigravity.js` — swap injected env, bake URL, rewrite docs, bump `VERSION`.
- `README.md` — rewrite as end-user install guide.
- `skill/skill-example.md`, `AGENTS.md`, `CLAUDE.md` — scrub OpenRouter-direct / `openrouter:config` references.
- `gateway/README.md` — add operator "issue a token" step.

**Renamed:**
- `scripts/manage-openrouter-config.js` → `scripts/manage-gateway-config.js` (rewritten to manage the two gateway keys; `main()` guarded; testable helpers exported).

**Created:**
- `test/scripts/gateway-config.test.ts` — unit tests for the config CLI's key-management + fan-out helpers.

---

## Task 1: Remove the OpenRouter-direct path from the client

**Files:**
- Modify: `src/llm.ts`
- Modify: `test/client/provider.test.ts`

**Interfaces:**
- Consumes: `GATEWAY_PROVIDER_NAME`, `resolveProvider`, `queryLocalLLM` (existing exports, unchanged signatures).
- Produces: `resolveProvider` now returns only a `gateway` or `local-openai-compatible` provider.

- [ ] **Step 1: Add the failing test — `OPENROUTER_API_KEY` alone must resolve to local**

In `test/client/provider.test.ts`, rename the existing test on line 24 from `'resolveProvider falls back to local when no gateway/openrouter env is set'` to `'resolveProvider falls back to local when no gateway env is set'`, and add this test immediately after it:

```ts
test('OPENROUTER_API_KEY alone no longer selects a remote provider (legacy path removed)', () => {
  clearEnv();
  process.env.OPENROUTER_API_KEY = 'sk-legacy';
  const p = resolveProvider('verdict');
  assert.equal(p.providerName, 'local-openai-compatible');
  clearEnv();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the new test gets `providerName === 'openrouter'` because the OpenRouter branch still exists.

- [ ] **Step 3: Remove the OpenRouter constants**

In `src/llm.ts`, delete these three lines (around 39-42):

```ts
const OPENROUTER_PROVIDER_NAME = 'openrouter';
```
```ts
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
```

Keep `LOCAL_PROVIDER_NAME`, `export const GATEWAY_PROVIDER_NAME = 'gateway';`, `DEFAULT_API_URL`, and `DEFAULT_MODEL`.

- [ ] **Step 4: Remove the `TASK_OPENROUTER_MODEL_ENV` map**

In `src/llm.ts`, delete the entire block:

```ts
const TASK_OPENROUTER_MODEL_ENV: Record<LLMTaskType, string | undefined> = {
  verdict: 'OPENROUTER_VERDICT_MODEL',
  triage: 'OPENROUTER_TRIAGE_MODEL',
  review: 'OPENROUTER_REVIEW_MODEL',
  digest: 'OPENROUTER_DIGEST_MODEL',
  scout: 'OPENROUTER_SCOUT_MODEL',
  query: 'OPENROUTER_QUERY_MODEL',
  health: undefined
};
```

- [ ] **Step 5: Remove the OpenRouter branch from `resolveProvider`**

Replace the current `resolveProvider` (the version with the `OPENROUTER_API_KEY` branch) with:

```ts
export function resolveProvider(taskType: LLMTaskType): LLMProvider {
  const gateway = resolveGatewayProvider(taskType);
  if (gateway) {
    return gateway;
  }
  return resolveLocalProvider(taskType);
}
```

- [ ] **Step 6: Simplify `callWithFallback`'s remote check**

In `callWithFallback`, replace the stale comment and the `isRemote` line. Change the comment on the function (currently mentions "If the primary provider is OpenRouter") and the check:

```ts
/* Resolve provider, attempt the call. If the primary provider is the gateway and the call
   fails, retry once with the local provider and surface the fallback reason in metadata. */
async function callWithFallback(taskType: LLMTaskType, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
  const provider = resolveProvider(taskType);
  const isRemote = provider.providerName === GATEWAY_PROVIDER_NAME;
```

(Leave the rest of the function body unchanged.)

- [ ] **Step 7: Remove the OpenRouter branch from `checkLocalLLMHealth`**

In `checkLocalLLMHealth`, delete this entire block (the OpenRouter-primary branch, around lines 354-368):

```ts
  /* When OpenRouter is the configured primary, skip the local ping. The API key
     is assumed valid; any live failure surfaces via fallbackReason on real calls. */
  if (process.env.OPENROUTER_API_KEY) {
    const model = process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL;
    return {
      llmAvailable: true,
      llmProvider: OPENROUTER_PROVIDER_NAME,
      llmModel: model,
      llmLatencyMs: 0,
      llmTaskType: 'health',
      apiBase: OPENROUTER_API_URL,
      available: true,
      skipped: true
    };
  }
```

The gateway branch above it and the local ping below it remain.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests green, including the new "OPENROUTER_API_KEY alone → local" test. Also confirms no dangling references to the removed symbols (a leftover reference would fail `tsc`).

- [ ] **Step 9: Confirm the full build compiles**

Run: `npm run build`
Expected: clean, no errors.

- [ ] **Step 10: Commit**

```bash
git add src/llm.ts test/client/provider.test.ts
git commit -m "refactor(client): remove OpenRouter-direct path; gateway + local only"
```

---

## Task 2: Rename and repurpose the config CLI as the gateway token tool

**Files:**
- Rename: `scripts/manage-openrouter-config.js` → `scripts/manage-gateway-config.js`
- Modify: the renamed script (rewrite key set, prompts, help; guard `main()`; export helpers; make paths home-injectable)
- Modify: `package.json`
- Create: `test/scripts/gateway-config.test.ts`

**Interfaces:**
- Produces (new exports on the renamed module):
  - `GATEWAY_ENV_KEYS: string[]` = `['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN']`
  - `sanitizeEnvObject(envObject): Record<string,string>`
  - `mergeManagedEnvValues(existingEnv, incomingValues): Record<string,string>`
  - `getManagedTargets(home): Target[]`
  - `applyToTargets(values, home)`, `collectCurrentValues(home): Record<string,string>`
  - `applyLaunchctlValues(values)`, `readLaunchctlValues(): Record<string,string>`, `clearLaunchctlValues()`
- Env seams for tests: `HOME` (config file root), `LOCAL_TESTER_LAUNCHCTL_STATE_PATH` (launchctl state file).

- [ ] **Step 1: Rename the file (preserve history)**

```bash
git mv scripts/manage-openrouter-config.js scripts/manage-gateway-config.js
```

- [ ] **Step 2: Rename the npm script**

In `package.json`, change:

```json
"openrouter:config": "node scripts/manage-openrouter-config.js",
```
to:
```json
"gateway:config": "node scripts/manage-gateway-config.js",
```

- [ ] **Step 3: Write the failing test file**

Create `test/scripts/gateway-config.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/* The config CLI is a CommonJS script under scripts/. From the compiled test at
   .test-build/test/scripts/, it resolves at ../../../scripts/manage-gateway-config.js. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../scripts/manage-gateway-config.js');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cfg-'));
}

test('GATEWAY_ENV_KEYS is exactly the two gateway vars', () => {
  assert.deepEqual(cli.GATEWAY_ENV_KEYS, ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN']);
});

test('sanitizeEnvObject keeps only managed keys with non-empty values', () => {
  const out = cli.sanitizeEnvObject({
    LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: '', OPENROUTER_API_KEY: 'legacy', OTHER: 'x'
  });
  assert.deepEqual(out, { LLM_GATEWAY_TOKEN: 'tok' });
});

test('mergeManagedEnvValues sets provided keys and deletes empty ones', () => {
  const merged = cli.mergeManagedEnvValues(
    { LLM_GATEWAY_URL: 'old', KEEP: 'yes' },
    { LLM_GATEWAY_URL: 'https://g/v1', LLM_GATEWAY_TOKEN: '' }
  );
  assert.equal(merged.LLM_GATEWAY_URL, 'https://g/v1');
  assert.equal(merged.KEEP, 'yes');            // unmanaged keys untouched
  assert.ok(!('LLM_GATEWAY_TOKEN' in merged)); // empty managed value removed
});

test('applyToTargets writes gateway values to Claude + Gemini configs, collect reads them back, empty clears', () => {
  const home = tmpHome();
  const values = { LLM_GATEWAY_URL: 'https://llm-proxy.lnf.gr/v1', LLM_GATEWAY_TOKEN: 'person-token' };
  cli.applyToTargets(values, home);

  const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claude.env.LLM_GATEWAY_TOKEN, 'person-token');
  assert.equal(claude.env.LLM_GATEWAY_URL, 'https://llm-proxy.lnf.gr/v1');

  const gemini = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(gemini.mcpServers.local_tester.env.LLM_GATEWAY_TOKEN, 'person-token');

  assert.equal(cli.collectCurrentValues(home).LLM_GATEWAY_TOKEN, 'person-token');

  cli.applyToTargets({}, home);
  const cleared = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.ok(!('LLM_GATEWAY_TOKEN' in cleared.env));
});

test('launchctl values round-trip through the state-file seam', () => {
  const home = tmpHome();
  const statePath = path.join(home, 'launchctl-state.json');
  process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH = statePath;
  try {
    cli.applyLaunchctlValues({ LLM_GATEWAY_TOKEN: 'tok', LLM_GATEWAY_URL: 'https://g/v1' });
    assert.equal(cli.readLaunchctlValues().LLM_GATEWAY_TOKEN, 'tok');
    cli.clearLaunchctlValues();
    assert.ok(!('LLM_GATEWAY_TOKEN' in cli.readLaunchctlValues()));
  } finally {
    delete process.env.LOCAL_TESTER_LAUNCHCTL_STATE_PATH;
  }
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — the module still exports nothing (no `GATEWAY_ENV_KEYS`), still keys on `OPENROUTER_*`, still runs `main()` on require (which would hang or error). These drive the rewrite.

- [ ] **Step 5: Replace the managed key set**

In `scripts/manage-gateway-config.js`, replace the `OPENROUTER_ENV_KEYS` array and the `TASK_MODEL_PROMPTS` array (lines ~9-27) with:

```js
const GATEWAY_ENV_KEYS = ["LLM_GATEWAY_URL", "LLM_GATEWAY_TOKEN"];
const DEFAULT_GATEWAY_URL = "https://llm-proxy.lnf.gr/v1";
```

Then replace every remaining reference to `OPENROUTER_ENV_KEYS` in the file with `GATEWAY_ENV_KEYS` (in `mergeManagedEnvValues`, `sanitizeEnvObject`, `applyLaunchctlValues`, `clearLaunchctlValues`, `readLaunchctlValues`).

- [ ] **Step 6: Make config-file paths home-injectable**

Replace the module-level `homeDir` + path constants + `const managedTargets = [...]` with a function that computes them from a passed-in home dir. Replace the block from `const homeDir = ...` through the end of the `managedTargets` array with:

```js
function getManagedTargets(home) {
  const homeDir = path.resolve(home || process.env.HOME || os.homedir());
  const claudeSettingsPath = path.join(homeDir, ".claude", "settings.json");
  const geminiConfigPath = path.join(homeDir, ".gemini", "config", "mcp_config.json");
  const antigravityPluginConfigPath = path.join(
    homeDir, ".gemini", "config", "plugins", "local-tester", "mcp_config.json"
  );
  const localTesterServerArgs = [
    path.join(homeDir, ".gemini", "config", "plugins", "local-tester", "server", "start.sh"),
  ];

  /* Same stable user-owned surfaces as before, now derived from the given home
     so tests can point at a temp dir. Each target reads/writes only the managed
     LLM_GATEWAY_* keys within its own config shape. */
  return [
    {
      label: "Claude Code settings",
      filePath: claudeSettingsPath,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.env = mergeManagedEnvValues(next.env || {}, values);
        return next;
      },
    },
    {
      label: "Gemini CLI MCP config",
      filePath: geminiConfigPath,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.local_tester?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.local_tester = next.mcpServers.local_tester || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.local_tester.command = next.mcpServers.local_tester.command || "bash";
        next.mcpServers.local_tester.args =
          Array.isArray(next.mcpServers.local_tester.args) && next.mcpServers.local_tester.args.length > 0
            ? next.mcpServers.local_tester.args : localTesterServerArgs;
        next.mcpServers.local_tester.env = mergeManagedEnvValues(
          next.mcpServers.local_tester.env || {}, values
        );
        return next;
      },
    },
    {
      label: "Antigravity staged plugin config",
      filePath: antigravityPluginConfigPath,
      optional: true,
      readConfig: readJsonFile,
      writeConfig: writeJsonFile,
      getValues(config) { return sanitizeEnvObject(config?.mcpServers?.local_tester?.env || {}); },
      applyValues(config, values) {
        const next = config;
        next.mcpServers = next.mcpServers || {};
        next.mcpServers.local_tester = next.mcpServers.local_tester || {
          command: "bash", args: localTesterServerArgs,
        };
        next.mcpServers.local_tester.env = mergeManagedEnvValues(
          next.mcpServers.local_tester.env || {}, values
        );
        return next;
      },
    },
  ];
}

const backupRoot = path.join(path.resolve(process.env.HOME || os.homedir()), ".local-tester-mcp", "backups");
```

- [ ] **Step 7: Thread the home arg through the target-driven functions**

Update `applyToTargets`, `collectCurrentValues`, and `printStatus` to obtain targets via `getManagedTargets(home)` and accept an optional `home` param:

```js
function applyToTargets(values, home) {
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const nextConfig = target.applyValues(config, values);
    writeTargetConfig(target, nextConfig);
  }
}

function collectCurrentValues(home) {
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const values = target.getValues(config);
    if (values.LLM_GATEWAY_TOKEN || values.LLM_GATEWAY_URL) {
      return values;
    }
  }
  return readLaunchctlValues();
}

function printStatus(home) {
  console.log("");
  console.log("Current managed status:");
  for (const target of getManagedTargets(home)) {
    const config = safeReadTargetConfig(target);
    const values = target.getValues(config);
    console.log(`- ${target.label}: ${summarizeValues(values)}`);
  }
  console.log(`- macOS GUI session (launchctl): ${summarizeValues(readLaunchctlValues())}`);
}
```

- [ ] **Step 8: Rewrite the prompt flow and `summarizeValues` for the two gateway keys**

Replace `upsertConfiguration` with:

```js
/* Collect the one per-person proxy token (required) and an optional gateway URL
   (defaults to the shared gateway), then fan them out to every managed client
   surface plus the macOS GUI session. */
async function upsertConfiguration(rl, mode) {
  const existing = collectCurrentValues();
  const values = {};

  values.LLM_GATEWAY_TOKEN = await askRequired(
    rl,
    `Gateway proxy token${existing.LLM_GATEWAY_TOKEN ? " [press Enter to keep current]" : ""}: `,
    existing.LLM_GATEWAY_TOKEN,
  );
  const currentUrl = existing.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL;
  const urlAnswer = (await ask(rl, `Gateway URL [${currentUrl}]: `)).trim();
  values.LLM_GATEWAY_URL = urlAnswer || currentUrl;

  applyToTargets(values);
  applyLaunchctlValues(values);

  console.log("");
  console.log(
    mode === "setup"
      ? "Gateway configuration saved for all managed clients."
      : "Gateway configuration updated for all managed clients.",
  );
  printStatus();
}
```

Replace `summarizeValues` with:

```js
function summarizeValues(values) {
  if (!values.LLM_GATEWAY_TOKEN && !values.LLM_GATEWAY_URL) {
    return "not configured";
  }
  const parts = [];
  if (values.LLM_GATEWAY_URL) {
    parts.push(`url=${values.LLM_GATEWAY_URL}`);
  }
  if (values.LLM_GATEWAY_TOKEN) {
    parts.push(`token=${redactSecret(values.LLM_GATEWAY_TOKEN)}`);
  }
  return parts.join(" ");
}
```

- [ ] **Step 9: Update help text and delete-confirmation copy**

Replace `printHelp` body text and the `deleteConfiguration` confirmation prompt so they refer to the gateway, not OpenRouter:

```js
function printHelp() {
  console.log(`Usage: node scripts/manage-gateway-config.js [setup|update|delete|status]

Commands:
  setup   Prompt for your gateway proxy token and write it to all managed clients
  update  Prompt again and replace the managed gateway values
  delete  Remove managed gateway values from all managed clients
  status  Show current managed gateway values and GUI-session state

When no command is provided, the script prompts for one interactively.`);
}
```

In `deleteConfiguration`, change the confirmation question and the success line from "OpenRouter" to "gateway":

```js
  const confirmation = (
    await ask(rl, "Remove managed gateway values from all clients and unset the GUI-session environment? [y/N]: ")
  ).trim().toLowerCase();
```
```js
  console.log("Managed gateway values removed.");
```

- [ ] **Step 10: Guard `main()` and export the testable helpers**

At the very bottom of the file, replace the unconditional `main().catch(...)` invocation with a `require.main` guard plus exports:

```js
if (require.main === module) {
  main().catch((error) => {
    console.error(`Gateway config manager failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  GATEWAY_ENV_KEYS,
  DEFAULT_GATEWAY_URL,
  sanitizeEnvObject,
  mergeManagedEnvValues,
  getManagedTargets,
  applyToTargets,
  collectCurrentValues,
  applyLaunchctlValues,
  readLaunchctlValues,
  clearLaunchctlValues,
};
```

Also update the file's top comment block that describes launchctl persistence to say "gateway variables" instead of "OpenRouter variables", and the `applyLaunchctlValues` comment likewise.

- [ ] **Step 11: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all five config-CLI tests green, plus the existing client/gateway suites.

- [ ] **Step 12: Smoke-run the CLI help path (no interactive prompt)**

Run: `node scripts/manage-gateway-config.js help`
Expected: prints the gateway-oriented usage text; exits 0; does not hang.

- [ ] **Step 13: Commit**

```bash
git add scripts/manage-gateway-config.js package.json test/scripts/gateway-config.test.ts
git commit -m "refactor(config): repurpose config CLI to provision the gateway proxy token"
```

---

## Task 3: Generators — swap injected env, bake URL, rewrite docs, bump version

**Files:**
- Modify: `scripts/generate-plugin-claude.js`, `scripts/generate-plugin-codex.js`, `scripts/generate-plugin-antigravity.js`

No automated tests (build scripts); verified by regeneration + grep.

- [ ] **Step 1: Claude generator — swap the `.mcp.json` env block**

In `scripts/generate-plugin-claude.js`, replace the `env` object (the `OPENROUTER_*` lines through `LOCAL_LLM_MODEL`) with:

```js
        env: {
          LLM_GATEWAY_URL: "${LLM_GATEWAY_URL:-https://llm-proxy.lnf.gr/v1}",
          LLM_GATEWAY_TOKEN: "${LLM_GATEWAY_TOKEN:-}",
          LOCAL_LLM_API_URL: "http://localhost:8080/v1",
          LOCAL_LLM_MODEL: "local-model",
        },
```

Update the comment above `const mcpJson` (currently "Resolve OpenRouter variables…") to describe resolving the gateway token from host-managed settings with the URL defaulted.

- [ ] **Step 2: Codex generator — swap the env passthrough + bake URL**

In `scripts/generate-plugin-codex.js`, replace the `env_vars` array and `env` block with (token passed through from the session; URL baked as a default):

```js
        env_vars: [
          "LLM_GATEWAY_TOKEN",
          "LLM_GATEWAY_URL",
        ],
        env: {
          LLM_GATEWAY_URL: "https://llm-proxy.lnf.gr/v1",
          LOCAL_LLM_API_URL: "http://localhost:8080/v1",
          LOCAL_LLM_MODEL: "local-model",
        },
```

Update the comment above it (currently mentions forwarding `OPENROUTER_*`) to say it forwards `LLM_GATEWAY_TOKEN` from the session while baking the gateway URL default. (Codex merges `env` defaults with `env_vars` passthrough; a session-provided `LLM_GATEWAY_URL` still overrides the baked default.)

- [ ] **Step 3: Antigravity generator — bake URL into the env block**

In `scripts/generate-plugin-antigravity.js`, replace the `env` block:

```js
        env: {
          LLM_GATEWAY_URL: "https://llm-proxy.lnf.gr/v1",
          LOCAL_LLM_API_URL: "http://localhost:8080/v1",
          LOCAL_LLM_MODEL: "local-model",
        },
```

Update the comment above it (currently "Leave OpenRouter variables out…") to: the gateway URL is baked; the per-person `LLM_GATEWAY_TOKEN` is written into the staged/global `mcp_config.json` by `npm run gateway:config`.

- [ ] **Step 4: Rewrite the "OpenRouter (primary)" doc block in all three generators**

In each generator's embedded README/docs template, replace the `**OpenRouter (primary):** …` paragraph with:

```
**Centralized gateway (primary):** The plugin is preconfigured with the gateway URL (`https://llm-proxy.lnf.gr/v1`). Provide your per-person proxy token: from a repo clone run `npm run gateway:config -- setup` and paste the token (it is written to every client on your machine), or set `LLM_GATEWAY_TOKEN` manually in this client's config. Models are chosen centrally on the gateway; no client-side model configuration is needed.
```

Leave the `**Local LLM (fallback):**` paragraph in each as-is (it still describes the fallback), but remove its per-task `OPENROUTER_*` sentence if present (the local block already references `LOCAL_LLM_*` only — no change needed there).

- [ ] **Step 5: Bump VERSION to 1.4.0 in all three generators**

In each of the three generator scripts, change `const VERSION = "1.3.0";` to `const VERSION = "1.4.0";`.

- [ ] **Step 6: Rebuild and regenerate plugin output**

Run: `npm run build && npm run build:plugin`
Expected: succeeds, no errors.

- [ ] **Step 7: Verify generated output**

Run:
```bash
grep -rl "OPENROUTER" plugin/claude plugin/codex && echo "FAIL: OPENROUTER still present" || echo "OK: no OPENROUTER in generated configs"
grep -rn "LLM_GATEWAY_URL\|LLM_GATEWAY_TOKEN" plugin/claude/.mcp.json plugin/codex/.mcp.json
grep -rn "1.4.0" plugin/claude/.claude-plugin/plugin.json plugin/codex/.codex-plugin/plugin.json
```
Expected: no `OPENROUTER` in generated configs; both gateway vars present; version `1.4.0`.

- [ ] **Step 8: Commit**

```bash
git add scripts/generate-plugin-*.js plugin .claude-plugin .agents
git commit -m "feat(plugins): inject gateway env, bake URL, bump to 1.4.0"
```

---

## Task 4: Documentation — end-user README + scrub legacy references

**Files:**
- Modify: `README.md` (rewrite as end-user install guide)
- Modify: `skill/skill-example.md`, `AGENTS.md`, `CLAUDE.md`, `gateway/README.md`

No automated tests; verified by grep + read.

- [ ] **Step 1: Rewrite `README.md` as an end-user install guide**

Replace the OpenRouter-configuration content and any "OpenRouter (primary)" setup with an end-user-focused structure. The README's LLM-configuration / setup section must become:

````markdown
## Setup (end users)

This plugin runs your workspace's build/lint/test commands locally and returns
compact LLM verdicts, triage, and reviews via a shared gateway — so raw logs
stay out of your agent's context.

**Prerequisite:** a gateway access token (ask your gateway operator). The gateway
URL is already preconfigured in the plugin.

### 1. Install the plugin

- **Claude Code:** install from the marketplace (`local-tester`).
- **Codex:** install from the marketplace (`local-tester`).
- **Antigravity:** copy or symlink the generated `plugin/antigravity/` folder into
  Antigravity's plugin directory.

### 2. Provide your token

The gateway URL is baked in; the only value you supply is your token.

- **Shortcut (repo clone):** `npm run gateway:config -- setup`, paste your token
  once — it is written to every client on your machine.
- **Manual (no repo):** set `LLM_GATEWAY_TOKEN` in your client's config:
  - Claude Code → `~/.claude/settings.json` under `env`
  - Codex → your shell/launch environment (it is passed through)
  - Antigravity → its `mcp_config.json` under the `local_tester` `env`

### 3. Verify

Restart the client. The tools (`run_test_verdict`, `run_failure_triage`,
`run_changed_files_review`, `run_regression_check`, `run_command_digest`,
`query_log`, `grep_log`, `scout_codebase`) are available, and
`check_local_llm_health` reports the gateway reachable.

> Hosting the gateway, issuing/rotating tokens, and choosing models are operator
> tasks — see [`gateway/README.md`](gateway/README.md).
````

Remove any remaining `OPENROUTER_*` / `openrouter:config` references elsewhere in `README.md`. Keep the tool descriptions and other non-LLM-config sections. If a "local fallback" note exists, keep it but phrase it as optional.

- [ ] **Step 2: Scrub `skill/skill-example.md`**

Search `skill/skill-example.md` for `OPENROUTER` / `openrouter:config`. Replace any LLM-config guidance with the gateway equivalent: the plugin talks to the gateway using `LLM_GATEWAY_URL` (preconfigured) + `LLM_GATEWAY_TOKEN` (per person); `check_local_llm_health` verifies gateway reachability. Remove OpenRouter-direct references.

- [ ] **Step 3: Update `AGENTS.md`**

- In the "Local LLM Behavior" section, replace the description with: the server prefers the centralized gateway (`LLM_GATEWAY_URL` + `LLM_GATEWAY_TOKEN`) and falls back to a local OpenAI-compatible model (`LOCAL_LLM_*`); models are pinned server-side on the gateway.
- Reword the "Do not add remote hosted LLM dependencies or external network calls unless the user explicitly requests that architecture change" line to reflect that the gateway (a remote hop the maintainer controls) is now the approved primary path, while ad-hoc third-party LLM calls remain out of scope.
- Update the repo-shape / scripts references from `manage-openrouter-config.js` / `openrouter:config` to `manage-gateway-config.js` / `gateway:config`.

- [ ] **Step 4: Update `CLAUDE.md`**

Search `CLAUDE.md` for `openrouter` references and update the script/command name to `manage-gateway-config.js` / `gateway:config`. If `CLAUDE.md` has no such reference, make no change.

- [ ] **Step 5: Add the operator "issue a token" step to `gateway/README.md`**

Under the token-rotation section of `gateway/README.md`, add an "Issuing a token to a person" subsection:

````markdown
### Issuing a token to a person

1. Generate a token: `openssl rand -hex 32`.
2. Add it to the comma-separated `PROXY_TOKENS` in `gateway/deploy/gateway.env`.
3. Redeploy: `./deploy-pm2.sh` (or restart the service) so the gateway reloads the list.
4. Hand that token to the person; they run `npm run gateway:config -- setup` (or set
   `LLM_GATEWAY_TOKEN` manually) on their machine. Revoke by removing their token
   from `PROXY_TOKENS` and redeploying.
````

- [ ] **Step 6: Regenerate plugin docs (skill text changed) and verify no legacy references remain**

Run:
```bash
npm run build:plugin
grep -rn "openrouter:config\|OPENROUTER_API_KEY" README.md skill/skill-example.md AGENTS.md CLAUDE.md && echo "FAIL: legacy refs remain" || echo "OK: no legacy refs in docs"
```
Expected: `OK: no legacy refs in docs`; `build:plugin` succeeds.

- [ ] **Step 7: Commit**

```bash
git add README.md skill/skill-example.md AGENTS.md CLAUDE.md gateway/README.md plugin .claude-plugin .agents
git commit -m "docs: end-user install README; scrub OpenRouter-direct legacy; operator token step"
```

---

## Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Full build + gateway build + tests**

Run: `npm run build && npm run build:gateway && npm test`
Expected: both builds clean; all tests pass (client + gateway + config-CLI).

- [ ] **Step 2: Plugin regeneration + legacy sweep**

Run:
```bash
npm run build:plugin
grep -rl "OPENROUTER" plugin/claude plugin/codex src scripts && echo "FAIL: OPENROUTER remains" || echo "OK: OPENROUTER fully removed from source + generated configs"
grep -rn "1.4.0" plugin/claude/.claude-plugin/plugin.json plugin/codex/.codex-plugin/plugin.json
```
Expected: `OK: OPENROUTER fully removed…`; version `1.4.0` in both plugin manifests. (Note: `gateway/deploy/gateway.env` references `OPENROUTER_API_KEY` — that's the gateway server's own upstream key and is correct; the sweep above is scoped to `plugin/`, `src/`, `scripts/` so it won't flag that.)

- [ ] **Step 3: Commit any incidental fixes**

```bash
git add -A && git commit -m "chore: final verification for gateway cleanup" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Remove OpenRouter-direct path (spec §1) → Task 1. ✓
- Repurpose config CLI, two managed keys, launchctl seam, setup/update/delete/status (spec §2) → Task 2. ✓
- Generators swap env, bake URL, rewrite docs, VERSION 1.3.0→1.4.0 (spec §3) → Task 3. ✓
- Docs: end-user README, skill-example, AGENTS.md, CLAUDE.md, gateway/README operator step (spec §4, §5) → Task 4. ✓
- Testing: client tests updated + new "OPENROUTER alone → local" test; config-CLI tests via home + launchctl seams; build/plugin sweep (spec §Testing) → Tasks 1, 2, 5. ✓
- Token scope one-per-person, URL baked, repo-script-only (spec Decisions) → reflected in CLI prompts (Task 2), generator defaults (Task 3), README (Task 4). ✓

**Placeholder scan:** No TBD/TODO. Doc-edit steps (Task 4) give exact insert content plus search anchors because full `README.md`/`AGENTS.md` are large; the content to add/replace is fully specified.

**Type/name consistency:** `GATEWAY_ENV_KEYS`, `DEFAULT_GATEWAY_URL`, `getManagedTargets`, `applyToTargets`, `collectCurrentValues`, `sanitizeEnvObject`, `mergeManagedEnvValues`, and the launchctl helpers are used with identical names across the rewrite steps and the test file. Managed keys are consistently `LLM_GATEWAY_URL` / `LLM_GATEWAY_TOKEN` across CLI, generators, docs, and tests. VERSION consistently `1.3.0`→`1.4.0`. The gateway URL literal `https://llm-proxy.lnf.gr/v1` is identical everywhere it appears.
