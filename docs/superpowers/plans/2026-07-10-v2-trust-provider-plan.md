# Token Optimizer v2 Trust and Provider Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce explicit provider modes, mandatory outbound redaction, security-aware configuration resolution, and strict LLM response schemas.

**Architecture:** New focused modules own configuration, redaction, and response validation. `src/llm.ts` remains the inference orchestrator but consumes validated configuration and schemas instead of reading ambiguous environment combinations directly.

**Tech Stack:** TypeScript, Node.js fetch, Zod 4, Node test runner, existing MCP SDK.

## Global Constraints

- Milestone version is `2.0.0-alpha.1` across every release source and generated artifact.
- Provider mode values are `local`, `gateway-token`, `gateway-byok`, and `openrouter-direct`.
- Existing v1 BYOK variables map to `gateway-byok`; they never silently change request destination.
- Project configuration and tool arguments cannot elevate the user-owned execution privilege ceiling.
- Every remote prompt is redacted before `fetch` is called.
- LLM validation failure preserves deterministic facts and returns conservative output.
- Update `README.md` and `skill/skill-example.md` with every behavior or configuration change in this plan.

---

### Task 1: Add the v2 configuration contract

**Files:**
- Create: `src/config.ts`
- Modify: `src/types.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `test/client/config.test.ts`

**Interfaces:**
- Produces: `ProviderMode`, `ExecutionProfile`, `TokenOptimizerConfig`, `resolveEffectiveConfig(input): EffectiveConfig`.
- Consumes: process environment plus optional user, project, and tool-level partial configuration.

The user configuration path is `${TOKEN_OPTIMIZER_CONFIG_HOME:-~/.config/token-optimizer}/config.json`; the project path is `<workspace>/.token-optimizer.json`. Both are Zod-validated at load time. `TOKEN_OPTIMIZER_PROVIDER_MODE` selects the explicit provider. `OPENROUTER_API_KEY` is read only when that mode is `openrouter-direct`; `OPENROUTER_BYOK_KEY` remains the legacy `gateway-byok` credential and never selects the direct provider by itself.

- [ ] **Step 1: Write failing precedence and security-ceiling tests**

```typescript
test('project config cannot elevate a safe user ceiling', () => {
  const config = resolveEffectiveConfig({
    user: { execution: { profile: 'safe' } },
    project: { execution: { profile: 'unrestricted' } },
  });
  assert.equal(config.execution.profile, 'safe');
  assert.match(config.warnings.join('\n'), /cannot elevate/i);
});

test('legacy BYOK maps to gateway-byok without changing destination', () => {
  const config = resolveEffectiveConfig({
    env: { LLM_GATEWAY_URL: 'https://gateway.example/v1', OPENROUTER_BYOK_KEY: 'secret-ref' },
  });
  assert.equal(config.provider.mode, 'gateway-byok');
  assert.match(config.warnings.join('\n'), /legacy/i);
});
```

- [ ] **Step 2: Run the focused tests and confirm the missing-module failure**

Run: `npm test -- --test-name-pattern="project config|legacy BYOK"`

Expected: TypeScript compilation fails because `src/config.ts` does not exist.

- [ ] **Step 3: Add the explicit configuration types and resolver**

```typescript
export type ProviderMode = 'local' | 'gateway-token' | 'gateway-byok' | 'openrouter-direct';
export type ExecutionProfile = 'safe' | 'standard' | 'unrestricted';

export interface EffectiveConfig {
  provider: { mode: ProviderMode; apiUrl: string; model: string; credentialEnv?: string };
  execution: { profile: ExecutionProfile; allowedCommandPrefixes: string[] };
  logs: { retentionDays: number; maxDiskMb: number; storageMode: 'raw-local' | 'redacted-local' };
  warnings: string[];
}

export function resolveEffectiveConfig(input: ConfigLayers): EffectiveConfig {
  const ceiling = input.user?.execution?.profile ?? 'safe';
  const requested = input.tool?.execution?.profile ?? input.project?.execution?.profile ?? ceiling;
  return {
    provider: resolveProviderConfig(input),
    execution: {
      profile: narrowerProfile(ceiling, requested),
      allowedCommandPrefixes: resolveAllowlist(input),
    },
    logs: resolveLogConfig(input),
    warnings: collectCompatibilityWarnings(input),
  };
}
```

Add `zod` as an explicit root runtime dependency at the version already resolved by the lockfile (`^4.4.3`). Use the repository-approved network-authorized dependency update path rather than manually synthesizing lockfile entries.

- [ ] **Step 4: Run the focused and full contract tests**

Run: `npm test -- --test-name-pattern="config|provider"`

Expected: all matching tests pass and the TypeScript build reports no type mismatch.

- [ ] **Step 5: Commit the configuration contract**

```bash
git add src/config.ts src/types.ts package.json package-lock.json test/client/config.test.ts
git commit -m "feat: add security-aware v2 configuration"
```

### Task 2: Add deterministic secret redaction

**Files:**
- Create: `src/redaction.ts`
- Test: `test/client/redaction.test.ts`

**Interfaces:**
- Produces: `redactText(text, options?): RedactionResult`.
- Produces: `RedactionResult = { text: string; count: number; categories: string[] }`.

- [ ] **Step 1: Write failing redaction tests**

```typescript
test('redacts credentials while preserving actionable context', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    'OPENAI_API_KEY=sk-live-1234567890',
    'postgres://user:password@db.example/app',
  ].join('\n');
  const result = redactText(input);
  assert.doesNotMatch(result.text, /abc\.def|sk-live|password/);
  assert.match(result.text, /Authorization: Bearer \*\*\*/);
  assert.equal(result.count, 3);
});
```

- [ ] **Step 2: Confirm the focused test fails**

Run: `npm test -- --test-name-pattern="redacts credentials"`

Expected: compilation fails because `redactText` is not defined.

- [ ] **Step 3: Implement bounded, category-aware replacement**

```typescript
export interface RedactionResult {
  text: string;
  count: number;
  categories: string[];
}

export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  let output = text;
  const categories = new Set<string>();
  let count = 0;
  for (const rule of [...DEFAULT_REDACTION_RULES, ...(options.customRules ?? [])]) {
    output = output.replace(rule.pattern, (...args) => {
      count += 1;
      categories.add(rule.category);
      return rule.replace(...args);
    });
  }
  return { text: output, count, categories: [...categories].sort() };
}
```

Cap custom rule count and pattern length, and reject invalid regular expressions at the configuration boundary.

- [ ] **Step 4: Verify redaction behavior and regressions**

Run: `npm test -- --test-name-pattern="redact"`

Expected: bearer, API-key, connection-string, URL, multiline, and false-positive fixtures pass.

- [ ] **Step 5: Commit the redactor**

```bash
git add src/redaction.ts test/client/redaction.test.ts
git commit -m "feat: redact secrets before remote inference"
```

### Task 3: Implement explicit provider adapters

**Files:**
- Create: `src/providers.ts`
- Modify: `src/llm.ts`
- Modify: `src/types.ts`
- Test: `test/client/provider.test.ts`
- Test: `test/client/health.test.ts`

**Interfaces:**
- Consumes: `EffectiveConfig['provider']` from Task 1.
- Produces: `resolveProvider(config, taskType): LLMProvider` and `providerHealth(provider): Promise<LLMHealthResponse>`.

- [ ] **Step 1: Add failing destination and disclosure tests**

```typescript
test('openrouter-direct sends bearer auth directly to OpenRouter', () => {
  const provider = resolveProvider(directConfig('sk-or-user'), 'triage');
  assert.equal(provider.mode, 'openrouter-direct');
  assert.equal(provider.apiUrl, 'https://openrouter.ai/api/v1');
  assert.equal(provider.authHeaders.Authorization, 'Bearer sk-or-user');
  assert.ok(!('X-OpenRouter-Key' in provider.authHeaders));
});

test('gateway-byok carries an explicit trust disclosure', () => {
  const provider = resolveProvider(gatewayByokConfig('sk-or-user'), 'triage');
  assert.match(provider.warnings.join('\n'), /key.*gateway/i);
});
```

- [ ] **Step 2: Run the provider tests and observe legacy-shape failures**

Run: `npm test -- --test-name-pattern="openrouter-direct|gateway-byok"`

Expected: tests fail because the current provider only exposes gateway/local resolution.

- [ ] **Step 3: Add discriminated provider adapters**

```typescript
export interface LLMProvider {
  mode: ProviderMode;
  taskType: LLMTaskType;
  providerName: string;
  apiUrl: string;
  model: string;
  authHeaders: Record<string, string>;
  warnings: string[];
}

export function resolveProvider(config: ProviderConfig, taskType: LLMTaskType): LLMProvider {
  switch (config.mode) {
    case 'openrouter-direct': return openRouterDirectProvider(config, taskType);
    case 'gateway-token': return gatewayTokenProvider(config, taskType);
    case 'gateway-byok': return gatewayByokProvider(config, taskType);
    case 'local': return localProvider(config, taskType);
  }
}
```

Keep the existing environment-only `resolveProvider(taskType)` call as a compatibility wrapper until all internal callers accept `EffectiveConfig`.

- [ ] **Step 4: Verify provider routing, fallback, and health**

Run: `npm test -- --test-name-pattern="provider|health|gateway failure"`

Expected: direct, gateway-token, gateway-byok, local, health, and local-fallback tests pass.

- [ ] **Step 5: Commit provider adapters**

```bash
git add src/providers.ts src/llm.ts src/types.ts test/client/provider.test.ts test/client/health.test.ts
git commit -m "feat: add explicit inference provider modes"
```

### Task 4: Validate every LLM task response

**Files:**
- Create: `src/llm-schemas.ts`
- Modify: `src/llm.ts`
- Modify: `src/types.ts`
- Test: `test/client/llm-schemas.test.ts`

**Interfaces:**
- Produces: `parseLLMResponse(taskType, content): ParsedLLMResponse`.
- Consumes: raw assistant content after JSON extraction.

- [ ] **Step 1: Write failing malformed and contradictory response tests**

```typescript
test('rejects pass verdict with non-empty failures', () => {
  const parsed = parseLLMResponse('verdict', JSON.stringify({
    verdict: 'pass', confidence: 0.9, summary: 'ok', failures: [{ reason: 'broken' }],
  }));
  assert.equal(parsed.success, false);
});

test('rejects oversized scout arrays', () => {
  const content = JSON.stringify({ pointers: Array.from({ length: 101 }, pointerFixture) });
  assert.equal(parseLLMResponse('scout', content).success, false);
});
```

- [ ] **Step 2: Confirm tests fail without task schemas**

Run: `npm test -- --test-name-pattern="rejects pass|oversized scout"`

Expected: compilation fails because `parseLLMResponse` does not exist.

- [ ] **Step 3: Add strict schemas and semantic refinements**

```typescript
export const VerdictSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(4000),
  failures: z.array(FailureDetailSchema).max(50),
  needsRawLogs: z.boolean().optional(),
}).superRefine((value, ctx) => {
  if (value.verdict === 'pass' && value.failures.length > 0) {
    ctx.addIssue({ code: 'custom', message: 'pass verdict cannot contain failures' });
  }
});
```

Create equivalent bounded schemas for triage, review, digest, scout, and query responses. Return a discriminated `{ success: true, data } | { success: false, validationErrors }` result.

- [ ] **Step 4: Run schema and existing LLM tests**

Run: `npm test -- --test-name-pattern="LLM|verdict|triage|review|digest|scout|query"`

Expected: malformed fixtures are rejected and existing valid fixtures remain accepted.

- [ ] **Step 5: Commit response schemas**

```bash
git add src/llm-schemas.ts src/llm.ts src/types.ts test/client/llm-schemas.test.ts
git commit -m "feat: validate structured LLM responses"
```

### Task 5: Enforce redaction and conservative fallback in the inference path

**Files:**
- Modify: `src/llm.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts`
- Test: `test/client/inference-privacy.test.ts`
- Test: `test/client/provider.test.ts`

**Interfaces:**
- Consumes: `redactText`, `parseLLMResponse`, and explicit `LLMProvider`.
- Produces: additive `redactionSummary`, `validationErrors`, and provider warning fields in MCP results.

- [ ] **Step 1: Write a failing outbound-leak test**

```typescript
test('remote fetch never receives a recognized secret', async () => {
  let outbound = '';
  globalThis.fetch = (async (_url, init) => {
    outbound = String(init?.body);
    return validVerdictResponse();
  }) as typeof fetch;
  await queryLocalLLM('task', ['npm test'], { 'npm test': 1 }, [], 'OPENAI_API_KEY=sk-live-secret');
  assert.doesNotMatch(outbound, /sk-live-secret/);
  assert.match(outbound, /\*\*\*/);
});
```

- [ ] **Step 2: Confirm the current inference path leaks the fixture**

Run: `npm test -- --test-name-pattern="remote fetch never"`

Expected: the assertion finds `sk-live-secret` in the captured request.

- [ ] **Step 3: Redact at the final remote boundary and attach conservative failures**

```typescript
const outbound = provider.mode === 'local'
  ? { systemPrompt, userPrompt, redaction: undefined }
  : redactPrompts(systemPrompt, userPrompt);
const completion = await callChatCompletion(provider, outbound.systemPrompt, outbound.userPrompt);
const parsed = parseLLMResponse(taskType, completion.content);
if (!parsed.success) {
  return conservativeFallback(taskType, deterministicFacts, parsed.validationErrors, outbound.redaction);
}
return attachPrivacyMetadata(parsed.data, outbound.redaction, provider.warnings);
```

Ensure redaction occurs immediately before every remote `fetch`, including health-adjacent probes that contain user content in future changes.

- [ ] **Step 4: Run privacy, provider, and full tests**

Run: `npm test -- --test-name-pattern="privacy|provider|malformed|fallback"`

Expected: no captured remote body contains fixture secrets; invalid JSON yields `uncertain` or an advisory review result.

Run: `npm run build`

Expected: TypeScript compilation succeeds.

- [ ] **Step 5: Commit inference enforcement**

```bash
git add src/llm.ts src/index.ts src/types.ts test/client/inference-privacy.test.ts test/client/provider.test.ts
git commit -m "fix: enforce privacy at inference boundaries"
```

### Task 6: Publish the alpha.1 contract and documentation checkpoint

**Files:**
- Modify: `README.md`
- Modify: `skill/skill-example.md`
- Modify: `packages/installer/README.md`
- Modify: `package.json`
- Modify: `packages/installer/package.json`
- Modify: `src/index.ts`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Test: `test/scripts/release-versions.test.ts`
- Test: `test/scripts/plugin-generators.test.ts`

**Interfaces:**
- Documents: provider privacy matrix, compatibility warnings, redaction semantics, and new optional result fields.
- Produces: aligned `2.0.0-alpha.1` generated artifacts.

- [ ] **Step 1: Update release-contract tests to expect alpha.1 everywhere**

```typescript
assert.equal(RELEASE_VERSION, '2.0.0-alpha.1');
assert.match(serverSource, /version: '2\.0\.0-alpha\.1'/);
assert.match(generatedSkill, /openrouter-direct/);
assert.match(generatedSkill, /gateway-byok/);
```

- [ ] **Step 2: Run release tests and confirm the version/documentation mismatch**

Run: `npm test -- --test-name-pattern="release version|plugin generator"`

Expected: tests fail while source versions and generated instructions still describe v1 provider behavior.

- [ ] **Step 3: Update documentation and aligned version sources**

Add the exact four-row provider privacy matrix from the design, explain that legacy BYOK remains gateway-routed, and document `redactionSummary`, provider warnings, and conservative validation failure behavior. Set every release source listed above to `2.0.0-alpha.1`.

- [ ] **Step 4: Regenerate and verify installable artifacts**

Run: `npm run build`

Expected: succeeds.

Run: `npm test`

Expected: all tests pass.

Run: `npm run build:plugin`

Expected: all five plugin generators succeed and committed Claude/Codex outputs contain alpha.1 behavior.

Run: `npm run build:installer`

Expected: installer assets contain alpha.1 server and skill files.

Run: `npm pack ./packages/installer --dry-run`

Expected: tarball inventory contains no source secrets or local run logs.

- [ ] **Step 5: Review and commit the milestone**

Run Token Optimizer changed-files review over source, tests, docs, and generator inputs; then run the explicit build/test verdict. Commit only after both are clean.

```bash
git add README.md skill/skill-example.md packages/installer/README.md package.json packages/installer/package.json src/index.ts scripts test plugin .agents .claude-plugin packages/installer/assets
git commit -m "chore: prepare v2.0.0-alpha.1 trust milestone"
```
