# BYOK OpenRouter Model Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let BYOK users optionally select one OpenRouter model for every Token Optimizer LLM task while preserving gateway-controlled models for all other callers.

**Architecture:** Store the optional client choice in `OPENROUTER_BYOK_MODEL` and send it as `X-OpenRouter-Model` only beside a configured `X-OpenRouter-Key`. The gateway parses that header through a small typed validator and honors it only on an accepted BYOK request; missing overrides retain `resolveModel(...)`, and non-BYOK callers cannot influence model selection.

**Tech Stack:** TypeScript, Node.js HTTP and test runners, CommonJS installer/configuration scripts, OpenAI-compatible HTTP requests, generated multi-client plugin assets.

## Global Constraints

- Use one optional BYOK model for all task types; do not add per-task BYOK configuration.
- Use the exact environment variable `OPENROUTER_BYOK_MODEL`, CLI flag `--byok-model`, and request header `X-OpenRouter-Model`.
- A blank model preserves the gateway's existing task-specific/default selection.
- Never honor a caller-selected model without a valid BYOK key.
- Reject an invalid BYOK model with HTTP `400`; never retry that request with the operator-funded OpenRouter key.
- Keep shared gateway-token and local-LLM behavior unchanged.
- Do not persist or include the BYOK key or requested model in gateway error details.
- Add short `/* ... */` block comments above large or non-obvious modified sections.
- Keep `README.md`, `gateway/README.md`, `packages/installer/README.md`, and `skill/skill-example.md` aligned with behavior.
- Bump every aligned release source from `1.10.7` to `1.11.0`, then regenerate plugin and installer assets.
- Do not edit generated files under `plugin/` or `packages/installer/assets/` manually.

## File Map

- Create `gateway/src/byok-model.ts`: pure parsing and validation for the optional model header.
- Create `test/gateway/byok-model.test.ts`: exhaustive unit tests for the header contract.
- Modify `gateway/src/server.ts`: apply a valid override only on the authenticated BYOK branch.
- Modify `test/gateway/byok.test.ts`: gateway integration coverage for override, fallback, isolation, and errors.
- Modify `src/llm.ts`: emit the optional header from managed client configuration.
- Modify `test/client/provider.test.ts`: client header gating and metadata coverage.
- Modify `packages/installer/lib/install-core.js`: manage and write `OPENROUTER_BYOK_MODEL` across client targets.
- Modify `packages/installer/bin/token-optimizer.js`: add the interactive prompt and `--byok-model` automation flag.
- Create `test/installer/cli.test.ts`: focused tests for interactive and flag-driven installer option resolution.
- Modify `scripts/manage-gateway-config.js`: manage, prompt, clear, and report the BYOK model.
- Modify `test/installer/install-core.test.ts` and `test/scripts/gateway-config.test.ts`: persistence and provider-switch cleanup coverage.
- Modify user-facing documentation and every aligned version source listed in Task 4.
- Regenerate committed Claude/Codex plugin output and installer assets; regenerate the gitignored Antigravity/OpenCode/Cursor outputs through the same command.

---

### Task 1: Enforce the BYOK-only model override in the gateway

**Files:**
- Create: `gateway/src/byok-model.ts`
- Create: `test/gateway/byok-model.test.ts`
- Modify: `gateway/src/server.ts:1-10,149-209`
- Modify: `test/gateway/byok.test.ts:18-160`

**Interfaces:**
- Produces: `parseByokModelHeader(raw: string | string[] | undefined): ByokModelOverride`.
- Produces: `ByokModelOverride = { kind: 'absent' } | { kind: 'valid'; model: string } | { kind: 'invalid' }`.
- Consumes: the existing valid result from `extractByokKey(...)` and existing `resolveModel(...)` fallback.

- [ ] **Step 1: Write the failing pure validation tests**

Create `test/gateway/byok-model.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByokModelHeader } from '../../gateway/src/byok-model';

test('parseByokModelHeader distinguishes absent, valid, and invalid values', () => {
  assert.deepEqual(parseByokModelHeader(undefined), { kind: 'absent' });
  assert.deepEqual(parseByokModelHeader('openai/gpt-4o-mini'), {
    kind: 'valid', model: 'openai/gpt-4o-mini'
  });
  assert.deepEqual(parseByokModelHeader('meta-llama/llama-3.3-70b-instruct:free'), {
    kind: 'valid', model: 'meta-llama/llama-3.3-70b-instruct:free'
  });

  for (const value of [
    '',
    'openai',
    ' openai/gpt-4o-mini',
    'openai/gpt 4o',
    'openai/gpt-4o\nmini',
    `${'a'.repeat(100)}/${'b'.repeat(100)}`,
  ]) {
    assert.deepEqual(parseByokModelHeader(value), { kind: 'invalid' });
  }
  assert.deepEqual(parseByokModelHeader(['openai/gpt-4o-mini']), { kind: 'invalid' });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/gateway/byok-model.test.js
```

Expected: TypeScript compilation fails because `gateway/src/byok-model.ts` does not exist.

- [ ] **Step 3: Implement the pure parser**

Create `gateway/src/byok-model.ts`:

```typescript
export type ByokModelOverride =
  | { kind: 'absent' }
  | { kind: 'valid'; model: string }
  | { kind: 'invalid' };

const MAX_BYOK_MODEL_LENGTH = 199;
const OPENROUTER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/* Keep caller-controlled model selection narrow and deterministic. OpenRouter
   IDs use provider/model form; arrays, whitespace, controls, and oversized
   values are rejected before any upstream request is made. */
export function parseByokModelHeader(raw: string | string[] | undefined): ByokModelOverride {
  if (raw === undefined) {
    return { kind: 'absent' };
  }
  if (Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BYOK_MODEL_LENGTH) {
    return { kind: 'invalid' };
  }
  if (raw !== raw.trim() || !OPENROUTER_MODEL_RE.test(raw)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', model: raw };
}
```

- [ ] **Step 4: Run the parser test to verify it passes**

Run the two commands from Step 2.

Expected: compilation succeeds and the new test reports `pass 1`, `fail 0`.

- [ ] **Step 5: Write failing gateway integration tests**

Extend the `chat` helper in `test/gateway/byok.test.ts` to accept `byokModel?: string` and emit `X-OpenRouter-Model` when present. Add tests equivalent to:

```typescript
test('a valid BYOK model overrides the gateway model for every task', async () => {
  const seenModels: string[] = [];
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenModels.push(JSON.parse(String(init?.body)).model);
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    assert.equal((await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini')).status, 200);
    assert.equal((await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini', 'triage')).status, 200);
  }, { MODEL_TRIAGE: 'gateway/triage' });
  assert.deepEqual(seenModels, ['openai/gpt-4o-mini', 'openai/gpt-4o-mini']);
});

test('missing override keeps gateway selection and non-BYOK callers cannot override it', async () => {
  const seenModels: string[] = [];
  const spyUpstream: typeof fetch = async (_url, init) => {
    seenModels.push(JSON.parse(String(init?.body)).model);
    return okUpstream(_url as any, init as any);
  };
  await withServer(spyUpstream, async (base) => {
    assert.equal((await chat(base, undefined, VALID_BYOK, undefined, 'triage')).status, 200);
    assert.equal((await chat(base, 'shared-token', undefined, 'openai/gpt-4o-mini', 'triage')).status, 200);
  }, { MODEL_TRIAGE: 'gateway/triage' });
  assert.deepEqual(seenModels, ['gateway/triage', 'gateway/triage']);
});

test('an invalid BYOK model returns 400 without calling OpenRouter', async () => {
  let calls = 0;
  const spyUpstream: typeof fetch = async () => {
    calls += 1;
    return okUpstream('', {});
  };
  await withServer(spyUpstream, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK, 'openai/not valid');
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid BYOK model' });
  });
  assert.equal(calls, 0);
});

test('an upstream error for a valid BYOK model is forwarded unchanged', async () => {
  const unavailable: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${VALID_BYOK}`);
    assert.equal(JSON.parse(String(init?.body)).model, 'openai/gpt-4o-mini');
    return new Response(JSON.stringify({ error: 'model unavailable' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  };
  await withServer(unavailable, async (base) => {
    const res = await chat(base, undefined, VALID_BYOK, 'openai/gpt-4o-mini');
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'model unavailable' });
  });
});
```

Update the helper signature consistently:

```typescript
function chat(
  base: string,
  token?: string,
  byokKey?: string,
  byokModel?: string,
  taskType?: string
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(byokKey ? { 'X-OpenRouter-Key': byokKey } : {}),
      ...(byokModel ? { 'X-OpenRouter-Model': byokModel } : {}),
      ...(taskType ? { 'X-Task-Type': taskType } : {}),
    },
    body: JSON.stringify({ messages: [] })
  });
}
```

- [ ] **Step 6: Run the BYOK integration test to verify it fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/gateway/byok.test.js
```

Expected: override assertions fail because the gateway still assigns `resolveModel(...)`, and malformed models are forwarded instead of returning `400`.

- [ ] **Step 7: Apply the parsed override in `handleChat`**

Import `parseByokModelHeader` in `gateway/src/server.ts`. Immediately after extracting `byokKey`, parse the model only for BYOK calls and reject an invalid value:

```typescript
const byokKey = extractByokKey(req, config);
const byokModel = byokKey
  ? parseByokModelHeader(req.headers['x-openrouter-model'])
  : { kind: 'absent' as const };

/* A caller-selected model is valid only on the user-funded BYOK path. Invalid
   BYOK model input stops here so it can never fall through to operator-funded
   inference; model headers from non-BYOK callers remain inert. */
if (byokKey && byokModel.kind === 'invalid') {
  return sendJson(res, 400, { error: 'invalid BYOK model' });
}
```

Replace the unconditional model assignment with:

```typescript
body.model = byokModel.kind === 'valid'
  ? byokModel.model
  : resolveModel(req.headers['x-task-type'] as string | undefined, config);
```

Do not change upstream authorization: it must remain `Bearer ${byokKey || config.openRouterKey}`.

- [ ] **Step 8: Run gateway verification**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/gateway/byok-model.test.js .test-build/test/gateway/byok.test.js .test-build/test/gateway/server.test.js
npm run build:gateway
```

Expected: all selected tests pass and the gateway build exits `0`.

- [ ] **Step 9: Commit the gateway slice**

```bash
git add gateway/src/byok-model.ts gateway/src/server.ts test/gateway/byok-model.test.ts test/gateway/byok.test.ts
git commit -m "feat: allow BYOK model overrides"
```

---

### Task 2: Send the optional model from the MCP client

**Files:**
- Modify: `src/llm.ts:130-156`
- Modify: `test/client/provider.test.ts:5-47`

**Interfaces:**
- Consumes: `OPENROUTER_BYOK_MODEL` from client-managed environment configuration.
- Produces: `X-OpenRouter-Model` in `LLMProvider.authHeaders` only when `OPENROUTER_BYOK_KEY` and a trimmed model are both present.

- [ ] **Step 1: Write failing client-provider tests**

Add `delete process.env.OPENROUTER_BYOK_MODEL` to `clearEnv()`. Add:

```typescript
test('resolveProvider sends a trimmed BYOK model only beside a BYOK key', () => {
  clearEnv();
  process.env.LLM_GATEWAY_URL = 'https://llm-proxy.lnf.gr/v1';
  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  process.env.OPENROUTER_BYOK_MODEL = '  openai/gpt-4o-mini  ';
  const withByok = resolveProvider('verdict');
  assert.equal(withByok.authHeaders['X-OpenRouter-Model'], 'openai/gpt-4o-mini');

  delete process.env.OPENROUTER_BYOK_KEY;
  process.env.LLM_GATEWAY_TOKEN = 'shared-token';
  const withoutByok = resolveProvider('verdict');
  assert.ok(!('X-OpenRouter-Model' in withoutByok.authHeaders));

  process.env.OPENROUTER_BYOK_KEY = 'sk-or-v1-mykey';
  process.env.OPENROUTER_BYOK_MODEL = '   ';
  const blank = resolveProvider('verdict');
  assert.ok(!('X-OpenRouter-Model' in blank.authHeaders));
  clearEnv();
});
```

- [ ] **Step 2: Run the provider test to verify it fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/client/provider.test.js
```

Expected: the new assertion fails because `X-OpenRouter-Model` is absent.

- [ ] **Step 3: Emit the gated header**

Update the gateway-provider section in `src/llm.ts`:

```typescript
const byokKey = process.env.OPENROUTER_BYOK_KEY;
const byokModel = process.env.OPENROUTER_BYOK_MODEL?.trim();
```

Add this property after `X-OpenRouter-Key`:

```typescript
...(byokKey && byokModel ? { 'X-OpenRouter-Model': byokModel } : {})
```

Update the existing block comment to state that the optional model header is sent only on the user-funded BYOK path.

- [ ] **Step 4: Run client and build verification**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/client/provider.test.js .test-build/test/client/health.test.js .test-build/test/client/llm-usage.test.js
npm run build
```

Expected: all selected tests pass and TypeScript build exits `0`.

- [ ] **Step 5: Commit the client slice**

```bash
git add src/llm.ts test/client/provider.test.ts
git commit -m "feat: send the configured BYOK model"
```

---

### Task 3: Configure the optional model through both setup flows

**Files:**
- Modify: `packages/installer/lib/install-core.js:9-56`
- Modify: `packages/installer/bin/token-optimizer.js:14-226`
- Create: `test/installer/cli.test.ts`
- Modify: `test/installer/install-core.test.ts:106-166,357-388`
- Modify: `scripts/manage-gateway-config.js:9-26,381-478,522-542,879-904`
- Modify: `test/scripts/gateway-config.test.ts:16-143`

**Interfaces:**
- Consumes: installer `byokModel` option and CLI `--byok-model <model-id>`.
- Produces: managed environment value `OPENROUTER_BYOK_MODEL` on every target.
- Produces: exported test seams `resolveProviderOptions`, `promptForProviderInteractive`, `parseArgs`, and `collectByokValues` without changing CLI behavior.

- [ ] **Step 1: Write failing managed-value tests**

Update the expected key arrays and BYOK assertions in the existing installer/config-manager tests:

```typescript
assert.deepEqual(cli.MANAGED_ENV_KEYS, [
  'LLM_GATEWAY_URL',
  'LLM_GATEWAY_TOKEN',
  'OPENROUTER_BYOK_KEY',
  'OPENROUTER_BYOK_MODEL',
  'LOCAL_LLM_API_URL',
  'LOCAL_LLM_MODEL'
]);
```

Use a BYOK value object containing:

```typescript
OPENROUTER_BYOK_KEY: 'sk-or-v1-mykey',
OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini',
```

Assert it is written to Claude and OpenCode/Cursor configuration, and extend the provider-switch test so moving to local mode removes both `OPENROUTER_BYOK_KEY` and `OPENROUTER_BYOK_MODEL`.

In `test/installer/install-core.test.ts`, call:

```typescript
const byok = installer.buildProviderValues({
  provider: 'byok',
  byokKey: 'sk-or-key',
  byokModel: ' openai/gpt-4o-mini '
});
assert.equal(byok.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');
```

Also add `OPENROUTER_BYOK_MODEL: ''` to explicit managed-value fixtures such as the `upsertCodexTomlServer` test.

- [ ] **Step 2: Run installer/config tests to verify they fail**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/installer/install-core.test.js .test-build/test/scripts/gateway-config.test.js
```

Expected: key-list and persisted-model assertions fail.

- [ ] **Step 3: Add the managed key and value mapping**

In both `packages/installer/lib/install-core.js` and `scripts/manage-gateway-config.js`, insert `OPENROUTER_BYOK_MODEL` immediately after `OPENROUTER_BYOK_KEY` in `MANAGED_ENV_KEYS`.

In `buildProviderValues(options)`, extend the BYOK branch:

```javascript
values.LLM_GATEWAY_URL = options.gatewayUrl || DEFAULT_GATEWAY_URL;
values.OPENROUTER_BYOK_KEY = options.byokKey;
values.OPENROUTER_BYOK_MODEL = String(options.byokModel || "").trim();
```

Because every target already uses `MANAGED_ENV_KEYS`, this automatically adds write, clear, Codex TOML, and launchctl coverage without target-specific branches.

- [ ] **Step 4: Run the managed-value tests to verify they pass**

Run the two commands from Step 2.

Expected: both selected test files pass.

- [ ] **Step 5: Write failing installer CLI tests**

Create `test/installer/cli.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../packages/installer/bin/token-optimizer.js');

function readlineWith(...answers: string[]) {
  return {
    question(_prompt: string, done: (answer: string) => void) {
      done(answers.shift() || '');
    }
  };
}

test('interactive BYOK setup asks for one optional model', async () => {
  const options = await cli.resolveProviderOptions(
    { provider: 'byok' },
    readlineWith('sk-or-v1-mykey', 'openai/gpt-4o-mini')
  );
  assert.equal(options.byokKey, 'sk-or-v1-mykey');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('--byok-key and --byok-model configure BYOK without prompting', async () => {
  const args = cli.parseArgs([
    '--byok-key', 'sk-or-v1-mykey',
    '--byok-model', 'openai/gpt-4o-mini'
  ]);
  const options = await cli.resolveProviderOptions(args, readlineWith());
  assert.equal(options.provider, 'byok');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('a BYOK key flag without a model remains non-interactive and uses gateway defaults', async () => {
  const options = await cli.resolveProviderOptions(
    { byokKey: 'sk-or-v1-mykey' },
    readlineWith('must-not-be-consumed')
  );
  assert.equal(options.byokModel, '');
});
```

- [ ] **Step 6: Run the new CLI test to verify it fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/installer/cli.test.js
```

Expected: requiring the CLI executes `main()` or the expected helper exports are missing.

- [ ] **Step 7: Add the installer prompt, flag, help, and test seam**

Add an optional prompt helper:

```javascript
async function askOptional(rl, prompt) {
  return (await ask(rl, prompt)).trim();
}
```

In the explicit BYOK branch, distinguish flag-driven installs from prompt-driven installs:

```javascript
const byokKeyFlag = args["byok-key"] || args.byokKey;
if (explicit === "byok" || byokKeyFlag) {
  const byokKey = byokKeyFlag || await askRequired(rl, "Your OpenRouter API key (sk-or-...): ");
  const modelFlag = args["byok-model"] ?? args.byokModel;
  const byokModel = modelFlag !== undefined
    ? String(modelFlag).trim()
    : byokKeyFlag
      ? ""
      : await askOptional(rl, "OpenRouter model ID (optional; Enter for gateway default): ");
  return {
    provider: "byok",
    gatewayUrl: args.url || process.env.LLM_GATEWAY_URL || DEFAULT_GATEWAY_URL,
    byokKey,
    byokModel,
  };
}
```

In interactive menu choice 2, ask for the model after the key and include `byokModel` in the returned object. Document `--byok-model <model-id>` in help and state that it applies to every task.

Replace the unconditional bottom-level `main().catch(...)` with:

```javascript
if (require.main === module) {
  main().catch((error) => {
    console.error(`Token Optimizer installer failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  resolveProviderOptions,
  promptForProviderInteractive,
  parseArgs,
};
```

- [ ] **Step 8: Run the installer CLI tests to verify they pass**

Run the two commands from Step 6.

Expected: all three tests pass and requiring the CLI has no installation side effects.

- [ ] **Step 9: Write the failing config-manager prompt test**

Export `collectByokValues` from `scripts/manage-gateway-config.js`, then add this test to `test/scripts/gateway-config.test.ts`:

```typescript
test('collectByokValues keeps or clears the optional model explicitly', async () => {
  const keep = await cli.collectByokValues(
    readlineWith('', '', ''),
    {
      LLM_GATEWAY_URL: cli.DEFAULT_GATEWAY_URL,
      OPENROUTER_BYOK_KEY: 'sk-or-v1-existing',
      OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini'
    }
  );
  assert.equal(keep.OPENROUTER_BYOK_MODEL, 'openai/gpt-4o-mini');

  const clear = await cli.collectByokValues(
    readlineWith('', '', '-'),
    {
      LLM_GATEWAY_URL: cli.DEFAULT_GATEWAY_URL,
      OPENROUTER_BYOK_KEY: 'sk-or-v1-existing',
      OPENROUTER_BYOK_MODEL: 'openai/gpt-4o-mini'
    }
  );
  assert.equal(clear.OPENROUTER_BYOK_MODEL, '');
});
```

Add the same local `readlineWith(...)` helper used by the installer CLI test.

- [ ] **Step 10: Run the config-manager test to verify it fails**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/scripts/gateway-config.test.js
```

Expected: `collectByokValues` is missing or does not return `OPENROUTER_BYOK_MODEL`.

- [ ] **Step 11: Add the config-manager prompt and status output**

In `collectByokValues`, after the key prompt, add:

```javascript
values.OPENROUTER_BYOK_MODEL = await askOptional(
  rl,
  `OpenRouter model ID (optional; Enter to ${existing.OPENROUTER_BYOK_MODEL ? "keep current, - to clear" : "use gateway default"}): `,
  existing.OPENROUTER_BYOK_MODEL,
);
```

In `summarizeValues`, add:

```javascript
if (values.OPENROUTER_BYOK_MODEL) {
  parts.push(`byok_model=${values.OPENROUTER_BYOK_MODEL}`);
}
```

Export `collectByokValues`. Keep the model unredacted because it is an identifier, not a secret.

- [ ] **Step 12: Run installer/configuration verification**

Run:

```bash
npx tsc -p tsconfig.test.json
node --test .test-build/test/installer/cli.test.js .test-build/test/installer/install-core.test.js .test-build/test/scripts/gateway-config.test.js
```

Expected: all selected tests pass.

- [ ] **Step 13: Commit the setup-flow slice**

```bash
git add packages/installer/lib/install-core.js packages/installer/bin/token-optimizer.js scripts/manage-gateway-config.js test/installer/cli.test.ts test/installer/install-core.test.ts test/scripts/gateway-config.test.ts
git commit -m "feat: configure one BYOK OpenRouter model"
```

---

### Task 4: Document, version, regenerate, and verify the release

**Files:**
- Modify: `README.md`
- Modify: `gateway/README.md`
- Modify: `packages/installer/README.md`
- Modify: `skill/skill-example.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/installer/package.json`
- Modify: `src/index.ts:19`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Regenerate: `.claude-plugin/marketplace.json`
- Regenerate: `.agents/plugins/marketplace.json`
- Regenerate: `plugin/claude/**`
- Regenerate: `plugin/codex/**`
- Regenerate: `packages/installer/assets/**`

**Interfaces:**
- Documents: `OPENROUTER_BYOK_MODEL`, `--byok-model`, `X-OpenRouter-Model`, blank-value fallback, and BYOK-only enforcement.
- Produces: aligned release version `1.11.0` in every required source and generated package.

- [ ] **Step 1: Update source documentation**

Add the following facts consistently:

```text
OPENROUTER_BYOK_MODEL is optional and is used only with OPENROUTER_BYOK_KEY.
When set, one OpenRouter model is used for verdict, triage, review, digest, scout, and query requests.
When omitted or blank, the gateway keeps its task-specific/default model selection.
Shared gateway-token callers cannot override the gateway's model.
The installer accepts --byok-model <model-id> and prompts for it after the BYOK key.
```

In gateway documentation, describe `X-OpenRouter-Model`, its `provider/model` validation, the `400 { "error": "invalid BYOK model" }` response, and the rule that the header is ignored outside the valid BYOK path.

- [ ] **Step 2: Bump every version source to `1.11.0`**

Change:

```text
package.json version
package-lock.json root and packages[""] versions
packages/installer/package.json version
src/index.ts MCP server metadata version
VERSION in all five scripts/generate-plugin-*.js files
```

Do not change the installed `@softawarest/token-optimizer-installer` dependency or its resolved lockfile entry as part of this local package release; only the installer package's own version is aligned.

- [ ] **Step 3: Run lightweight changed-file review before generation**

Use `run_changed_files_review` with `useDiff: true` across all hand-edited files. Expected: `reviewAvailable: true`; investigate every reported issue before continuing.

- [ ] **Step 4: Run the full test and build suite**

Use `run_test_verdict` three times with the following shared fields and one `testCommand` per call:

```json
{
  "workspacePath": "/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp",
  "taskSummary": "Added a BYOK-only optional OpenRouter model override across gateway, client, installer, and config manager.",
  "testCommand": "npm test",
  "autoTriage": true,
  "timeoutMs": 300000
}
```

Repeat with `"testCommand": "npm run build"` and then with `"testCommand": "npm run build:gateway"`.

Expected: authoritative exit code `0` for every command and verdict `pass`. If the verdict is `fail` or `uncertain`, use its inline triage or `run_failure_triage`/`query_log`; do not paste the full raw log.

- [ ] **Step 5: Regenerate plugin and installer assets**

Run:

```bash
npm run build:plugin
npm run build:installer
```

Expected: both commands exit `0`; committed Claude/Codex outputs and `packages/installer/assets/` reflect `1.11.0`, `OPENROUTER_BYOK_MODEL`, and the updated skill documentation. Antigravity, OpenCode, and Cursor outputs are regenerated locally even though their plugin directories are gitignored.

- [ ] **Step 6: Verify the installer package contents**

Use `run_test_verdict` with:

```json
{
  "workspacePath": "/Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp",
  "taskSummary": "Verify the regenerated 1.11.0 installer package is complete and packable.",
  "testCommand": "npm pack ./packages/installer --dry-run",
  "autoTriage": true,
  "timeoutMs": 300000
}
```

Expected: exit code `0`, verdict `pass`, and package contents include the regenerated assets, CLI, library, README, and package metadata.

- [ ] **Step 7: Run final regression and generated-output checks**

Run exact searches:

```bash
rg -n "OPENROUTER_BYOK_MODEL|X-OpenRouter-Model|--byok-model" README.md gateway/README.md packages/installer/README.md skill/skill-example.md src gateway packages/installer/bin packages/installer/lib plugin/claude plugin/codex packages/installer/assets
rg -n "1\.10\.7" package.json package-lock.json packages/installer/package.json src/index.ts scripts/generate-plugin-*.js .claude-plugin .agents/plugins plugin/claude plugin/codex packages/installer/assets
```

Expected: the feature search finds every source/document/generated surface; the old-version search returns no matches in release-owned version metadata. Then run `run_regression_check` only if updating `.codex-local-test-runs/baseline.json` is acceptable; otherwise rely on the explicit full-suite verdict from Step 4.

- [ ] **Step 8: Review and commit the release slice**

Run `run_changed_files_review` again with `useDiff: true`, then inspect `git status --short` to ensure no generated logs or baselines are staged. Stage only source docs, version files, and expected generated assets:

```bash
git add README.md gateway/README.md packages/installer/README.md skill/skill-example.md package.json package-lock.json packages/installer/package.json src/index.ts scripts/generate-plugin-antigravity.js scripts/generate-plugin-claude.js scripts/generate-plugin-codex.js scripts/generate-plugin-opencode.js scripts/generate-plugin-cursor.js .claude-plugin .agents/plugins plugin/claude plugin/codex packages/installer/assets
git commit -m "chore: release BYOK model override"
```

- [ ] **Step 9: Final completion check**

Run `git status --short --branch` and confirm the worktree is clean. Report:

- The optional model and its BYOK-only enforcement.
- Interactive and `--byok-model` configuration support.
- Documentation/version/generated-asset updates.
- Exact tests, builds, generation, and pack verification performed.
- Residual risk: OpenRouter may reject a syntactically valid model identifier based on account access or current availability; that upstream status is intentionally forwarded and triggers the existing local fallback.
