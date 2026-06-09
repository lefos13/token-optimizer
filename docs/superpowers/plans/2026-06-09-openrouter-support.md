# OpenRouter API Key Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenRouter as the primary LLM provider, falling back to local LLM when no API key is set.

**Architecture:** Extend the `LLMProvider` interface in `src/llm.ts` with `providerName` and `authHeaders`, add `resolveLocalProvider` for explicit local-only resolution, update `callChatCompletion` to accept a pre-resolved provider, and add a `callWithFallback` wrapper that retries on OpenRouter failure. Generator scripts emit OpenRouter env placeholders alongside existing local vars.

**Tech Stack:** TypeScript, Node.js fetch API, OpenRouter OpenAI-compatible REST API (`https://openrouter.ai/api/v1`)

---

## File Map

| File | Change |
|---|---|
| `src/llm.ts` | All provider logic changes — interface, constants, resolution, transport, fallback, health check |
| `scripts/generate-plugin-claude.js` | Bump `VERSION` to `"1.2.2"`, add OpenRouter env placeholders, update inline README |
| `scripts/generate-plugin-codex.js` | Bump `VERSION` to `"1.0.12"`, add OpenRouter env placeholders, update inline README |
| `scripts/generate-plugin-antigravity.js` | Bump `VERSION` to `"1.1.3"`, add OpenRouter env placeholders, update inline README |
| `README.md` | Add OpenRouter Configuration section, update Local LLM section, update Requirements |
| `skill/skill-example.md` | Add OpenRouter env vars table and JSON-mode note to Guardrails |
| `plugin/` | Regenerated — do not edit by hand |

---

## Task 1: Update types and constants in `src/llm.ts`

**Files:**
- Modify: `src/llm.ts`

- [ ] **Step 1: Replace `PROVIDER_NAME` constant and add OpenRouter constants**

  In `src/llm.ts`, replace the single `PROVIDER_NAME` constant (line 36) with:

  ```ts
  const LOCAL_PROVIDER_NAME = 'local-openai-compatible';
  const OPENROUTER_PROVIDER_NAME = 'openrouter';
  const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
  const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';
  ```

- [ ] **Step 2: Rename `LocalLLMProvider` interface to `LLMProvider` and add new fields**

  Replace the `LocalLLMProvider` interface (lines 23–28):

  ```ts
  interface LLMProvider {
    taskType: LLMTaskType;
    providerName: string;
    apiUrl: string;
    model: string;
    authHeaders: Record<string, string>;
  }
  ```

- [ ] **Step 3: Add `TASK_OPENROUTER_MODEL_ENV` map after the existing `TASK_MODEL_ENV` map**

  After the closing brace of `TASK_MODEL_ENV` (around line 47), add:

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

- [ ] **Step 4: Add `skipped` field to `LLMHealthResponse`**

  The `LLMHealthResponse` interface (lines 30–34) becomes:

  ```ts
  export interface LLMHealthResponse extends LLMResponseMetadata {
    apiBase: string;
    available: boolean;
    error?: string;
    skipped?: boolean;
  }
  ```

- [ ] **Step 5: Build to verify types compile**

  ```bash
  cd /Users/eevangelinos/.gemini/antigravity/scratch/local-tester-mcp && npm run build 2>&1
  ```

  Expected: TypeScript errors because `metadataFromProvider`, `fallbackMetadata`, and `resolveProvider` still reference old type/field names. That's expected — fix them in Task 2.

---

## Task 2: Refactor provider resolution in `src/llm.ts`

**Files:**
- Modify: `src/llm.ts`

- [ ] **Step 1: Update `metadataFromProvider` to use `LLMProvider` and `providerName`**

  Replace the `metadataFromProvider` function (lines 92–101):

  ```ts
  function metadataFromProvider(provider: LLMProvider, latencyMs: number, fallbackReason?: string): LLMResponseMetadata {
    return {
      llmAvailable: !fallbackReason,
      llmProvider: provider.providerName,
      llmModel: provider.model,
      llmLatencyMs: latencyMs,
      llmTaskType: provider.taskType,
      ...(fallbackReason ? { fallbackReason } : {})
    };
  }
  ```

- [ ] **Step 2: Update `fallbackMetadata` signature to use `LLMProvider`**

  Replace the `fallbackMetadata` function signature (line 108):

  ```ts
  function fallbackMetadata(provider: LLMProvider, error: unknown, latencyMs: number): LLMResponseMetadata {
  ```

  The body is unchanged.

- [ ] **Step 3: Replace `resolveProvider` with `resolveLocalProvider` + updated `resolveProvider`**

  Replace the existing `resolveProvider` function (lines 113–121) with two functions:

  ```ts
  function resolveLocalProvider(taskType: LLMTaskType): LLMProvider {
    const modelEnvName = TASK_MODEL_ENV[taskType];
    return {
      taskType,
      providerName: LOCAL_PROVIDER_NAME,
      apiUrl: process.env.LOCAL_LLM_API_URL || DEFAULT_API_URL,
      model: (modelEnvName && process.env[modelEnvName]) || process.env.LOCAL_LLM_MODEL || DEFAULT_MODEL,
      authHeaders: {}
    };
  }

  function resolveProvider(taskType: LLMTaskType): LLMProvider {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey) {
      const modelEnvName = TASK_OPENROUTER_MODEL_ENV[taskType];
      return {
        taskType,
        providerName: OPENROUTER_PROVIDER_NAME,
        apiUrl: OPENROUTER_API_URL,
        model: (modelEnvName && process.env[modelEnvName]) || process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
        authHeaders: { Authorization: `Bearer ${apiKey}` }
      };
    }
    return resolveLocalProvider(taskType);
  }
  ```

- [ ] **Step 4: Build to check progress**

  ```bash
  npm run build 2>&1
  ```

  Expected: Fewer errors — `metadataFromProvider` and `fallbackMetadata` should be clean. `callChatCompletion` still errors because its signature and body still reference the old type. That's fixed in Task 3.

---

## Task 3: Refactor `callChatCompletion` and add `callWithFallback`

**Files:**
- Modify: `src/llm.ts`

- [ ] **Step 1: Refactor `callChatCompletion` to accept a pre-resolved `LLMProvider`**

  Replace the `callChatCompletion` function (lines 191–225). The signature changes from `(taskType: LLMTaskType, ...)` to `(provider: LLMProvider, ...)`, the internal `resolveProvider` call is removed, and `...provider.authHeaders` is spread into the fetch headers:

  ```ts
  /* Shared transport for every LLM call: accepts an already-resolved provider, builds the OpenAI-compatible request, and returns raw message content plus token/provider accounting. */
  async function callChatCompletion(provider: LLMProvider, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
    const start = Date.now();

    const response = await fetch(`${provider.apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...provider.authHeaders,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    const rawContent = data.choices?.[0]?.message?.content || '';
    if (!rawContent) {
      throw new Error('Empty response from LLM');
    }
    return {
      content: rawContent,
      usage: normalizeUsage(data, systemPrompt, userPrompt, rawContent),
      metadata: metadataFromProvider(provider, Date.now() - start)
    };
  }
  ```

- [ ] **Step 2: Add `callWithFallback` immediately after `callChatCompletion`**

  ```ts
  /* Resolve provider, attempt the call. If the primary provider is OpenRouter and the call fails, retry once with the local provider and surface the fallback reason in metadata. */
  async function callWithFallback(taskType: LLMTaskType, systemPrompt: string, userPrompt: string): Promise<ChatCompletionResult> {
    const provider = resolveProvider(taskType);
    try {
      return await callChatCompletion(provider, systemPrompt, userPrompt);
    } catch (error) {
      if (provider.providerName !== OPENROUTER_PROVIDER_NAME) {
        throw error;
      }
      const localProvider = resolveLocalProvider(taskType);
      const result = await callChatCompletion(localProvider, systemPrompt, userPrompt);
      result.metadata = {
        ...result.metadata,
        fallbackReason: `OpenRouter call failed: ${error instanceof Error ? error.message : String(error)}`
      };
      return result;
    }
  }
  ```

- [ ] **Step 3: Build to check progress**

  ```bash
  npm run build 2>&1
  ```

  Expected: Errors only in `checkLocalLLMHealth` (still calls old `callChatCompletion` with a `taskType` string) and in the public functions that call `callChatCompletion`. Fixed in Task 4.

---

## Task 4: Update all callers — health check + public LLM functions

**Files:**
- Modify: `src/llm.ts`

- [ ] **Step 1: Update `checkLocalLLMHealth` to skip when OpenRouter is configured**

  Replace the entire `checkLocalLLMHealth` function (lines 237–261):

  ```ts
  export async function checkLocalLLMHealth(): Promise<LLMHealthResponse> {
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

    const provider = resolveLocalProvider('health');
    const systemPrompt = 'Return JSON only.';
    const userPrompt = 'Return {"ok":true}.';
    const start = Date.now();

    try {
      const completion = await callChatCompletion(provider, systemPrompt, userPrompt);
      JSON.parse(extractJSON(completion.content));
      return {
        ...completion.metadata,
        apiBase: redactApiBase(provider.apiUrl),
        available: true
      };
    } catch (error: any) {
      const latencyMs = Date.now() - start;
      const metadata = fallbackMetadata(provider, error, latencyMs);
      return {
        ...metadata,
        apiBase: redactApiBase(provider.apiUrl),
        available: false,
        error: error.message || String(error)
      };
    }
  }
  ```

- [ ] **Step 2: Update `queryLocalLLM` — swap `callChatCompletion` to `callWithFallback`**

  In `queryLocalLLM`, find the line (around line 306):
  ```ts
  const completion = await callChatCompletion(taskType, systemPrompt, userPrompt);
  ```
  Replace with:
  ```ts
  const completion = await callWithFallback(taskType, systemPrompt, userPrompt);
  ```

- [ ] **Step 3: Update `queryCodeReview` — swap `callChatCompletion` to `callWithFallback`**

  In `queryCodeReview`, find (around line 401):
  ```ts
  const completion = await callChatCompletion('review', systemPrompt, userPrompt);
  ```
  Replace with:
  ```ts
  const completion = await callWithFallback('review', systemPrompt, userPrompt);
  ```

- [ ] **Step 4: Update `queryCommandDigest` — swap `callChatCompletion` to `callWithFallback`**

  In `queryCommandDigest`, find (around line 461):
  ```ts
  const completion = await callChatCompletion('digest', systemPrompt, userPrompt);
  ```
  Replace with:
  ```ts
  const completion = await callWithFallback('digest', systemPrompt, userPrompt);
  ```

- [ ] **Step 5: Update `queryScout` — swap `callChatCompletion` to `callWithFallback`**

  In `queryScout`, find (around line 521):
  ```ts
  const completion = await callChatCompletion('scout', systemPrompt, userPrompt);
  ```
  Replace with:
  ```ts
  const completion = await callWithFallback('scout', systemPrompt, userPrompt);
  ```

- [ ] **Step 6: Update `queryLogQuestion` — swap `callChatCompletion` to `callWithFallback`**

  In `queryLogQuestion`, find (around line 579):
  ```ts
  const completion = await callChatCompletion('query', systemPrompt, userPrompt);
  ```
  Replace with:
  ```ts
  const completion = await callWithFallback('query', systemPrompt, userPrompt);
  ```

- [ ] **Step 7: Build — must be zero errors**

  ```bash
  npm run build 2>&1
  ```

  Expected output ends with no errors. If TypeScript errors remain, they will name the exact line and field; fix before continuing.

- [ ] **Step 8: Commit `src/llm.ts` changes**

  ```bash
  git add src/llm.ts
  git commit -m "feat(llm): add OpenRouter provider with local-LLM fallback"
  ```

---

## Task 5: Update generator scripts — env placeholders and VERSION bumps

**Files:**
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-antigravity.js`

### Claude generator

- [ ] **Step 1: Bump VERSION in `generate-plugin-claude.js`**

  Find (line 66):
  ```js
  const VERSION = "1.2.1";
  ```
  Replace with:
  ```js
  const VERSION = "1.2.2";
  ```

- [ ] **Step 2: Add OpenRouter env placeholders to the `mcpJson` env block**

  Find the `env` object inside `mcpJson` (lines 129–132):
  ```js
  env: {
    LOCAL_LLM_API_URL: "http://localhost:8080/v1",
    LOCAL_LLM_MODEL: "local-model",
  },
  ```
  Replace with:
  ```js
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
  ```

- [ ] **Step 3: Update the inline README LLM configuration section in `generate-plugin-claude.js`**

  Find the `## LLM configuration` section inside the `readme` template string (around line 234):
  ```
  ## LLM configuration

  A local OpenAI-compatible LLM endpoint is expected. Defaults:
  \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`.
  Optional per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`,
  \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`,
  \`LOCAL_LLM_QUERY_MODEL\`.
  ```
  Replace with:
  ```
  ## LLM configuration

  **OpenRouter (primary):** Set \`OPENROUTER_API_KEY\` in the \`env\` block of \`.mcp.json\` to route all LLM calls through [OpenRouter](https://openrouter.ai). \`OPENROUTER_MODEL\` sets the default model (falls back to \`openai/gpt-4o-mini\`). Per-task overrides: \`OPENROUTER_VERDICT_MODEL\`, \`OPENROUTER_TRIAGE_MODEL\`, \`OPENROUTER_REVIEW_MODEL\`, \`OPENROUTER_DIGEST_MODEL\`, \`OPENROUTER_SCOUT_MODEL\`, \`OPENROUTER_QUERY_MODEL\`.

  > **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The chosen model must support JSON mode. Compatible models include \`openai/gpt-4o\`, \`openai/gpt-4o-mini\`, \`anthropic/claude-3-5-sonnet\`, \`anthropic/claude-3-haiku\`, and \`google/gemini-flash-1.5\`. Check the [OpenRouter models page](https://openrouter.ai/models) and filter by JSON mode support.

  **Local LLM (fallback):** When \`OPENROUTER_API_KEY\` is absent, the server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

  Edit the \`env\` block in \`~/.claude/plugins/cache/<plugin-name>/.mcp.json\` to set your values.
  ```

### Codex generator

- [ ] **Step 4: Bump VERSION in `generate-plugin-codex.js`**

  Find (line 49):
  ```js
  const VERSION = "1.0.11";
  ```
  Replace with:
  ```js
  const VERSION = "1.0.12";
  ```

- [ ] **Step 5: Add OpenRouter env placeholders to `mcpJson` env block in `generate-plugin-codex.js`**

  Find the `env` object inside `mcpJson` (around lines 146–149):
  ```js
  env: {
    LOCAL_LLM_API_URL: "http://localhost:8080/v1",
    LOCAL_LLM_MODEL: "local-model",
  },
  ```
  Replace with:
  ```js
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
  ```

- [ ] **Step 6: Update the inline README LLM configuration section in `generate-plugin-codex.js`**

  Find the `## LLM configuration` section inside the `readme` template string (around line 294):
  ```
  ## LLM configuration

  A local OpenAI-compatible LLM endpoint is expected. Defaults:
  \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`.
  Optional per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`,
  \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`,
  \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`,
  \`LOCAL_LLM_QUERY_MODEL\`.
  ```
  Replace with:
  ```
  ## LLM configuration

  **OpenRouter (primary):** Set \`OPENROUTER_API_KEY\` in \`.mcp.json\`'s \`env\` block to route all LLM calls through [OpenRouter](https://openrouter.ai). \`OPENROUTER_MODEL\` sets the default model (falls back to \`openai/gpt-4o-mini\`). Per-task overrides: \`OPENROUTER_VERDICT_MODEL\`, \`OPENROUTER_TRIAGE_MODEL\`, \`OPENROUTER_REVIEW_MODEL\`, \`OPENROUTER_DIGEST_MODEL\`, \`OPENROUTER_SCOUT_MODEL\`, \`OPENROUTER_QUERY_MODEL\`.

  > **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The chosen model must support JSON mode. Compatible models include \`openai/gpt-4o\`, \`openai/gpt-4o-mini\`, \`anthropic/claude-3-5-sonnet\`, \`anthropic/claude-3-haiku\`, and \`google/gemini-flash-1.5\`. Check the [OpenRouter models page](https://openrouter.ai/models) and filter by JSON mode support.

  **Local LLM (fallback):** When \`OPENROUTER_API_KEY\` is absent, the server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

  Edit \`.mcp.json\`'s \`env\` block in your Codex plugin installation to set your values.
  ```

### Antigravity generator

- [ ] **Step 7: Bump VERSION in `generate-plugin-antigravity.js`**

  Find (line 82):
  ```js
  const VERSION = "1.1.2";
  ```
  Replace with:
  ```js
  const VERSION = "1.1.3";
  ```

- [ ] **Step 8: Add OpenRouter env placeholders to `mcpConfigJson` env block in `generate-plugin-antigravity.js`**

  Find the `env` object inside `mcpConfigJson` (around lines 124–127):
  ```js
  env: {
    LOCAL_LLM_API_URL: "http://localhost:8080/v1",
    LOCAL_LLM_MODEL: "local-model",
  },
  ```
  Replace with:
  ```js
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
  ```

- [ ] **Step 9: Update the inline README LLM configuration section in `generate-plugin-antigravity.js`**

  Find the `## LLM configuration` section inside the `readme` template string (around line 239):
  ```
  ## LLM configuration

  A local OpenAI-compatible LLM endpoint is expected. Defaults:
  \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`.
  Optional per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`,
  \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`,
  \`LOCAL_LLM_QUERY_MODEL\`. Edit \`mcp_config.json\`'s \`env\` block (or the
  equivalent in your global \`mcp_config.json\` if you merge the entry there) to
  point at a different endpoint or model.
  ```
  Replace with:
  ```
  ## LLM configuration

  **OpenRouter (primary):** Set \`OPENROUTER_API_KEY\` in \`mcp_config.json\`'s \`env\` block to route all LLM calls through [OpenRouter](https://openrouter.ai). \`OPENROUTER_MODEL\` sets the default model (falls back to \`openai/gpt-4o-mini\`). Per-task overrides: \`OPENROUTER_VERDICT_MODEL\`, \`OPENROUTER_TRIAGE_MODEL\`, \`OPENROUTER_REVIEW_MODEL\`, \`OPENROUTER_DIGEST_MODEL\`, \`OPENROUTER_SCOUT_MODEL\`, \`OPENROUTER_QUERY_MODEL\`.

  > **JSON mode requirement:** All requests send \`response_format: { type: "json_object" }\`. The chosen model must support JSON mode. Compatible models include \`openai/gpt-4o\`, \`openai/gpt-4o-mini\`, \`anthropic/claude-3-5-sonnet\`, \`anthropic/claude-3-haiku\`, and \`google/gemini-flash-1.5\`. Check the [OpenRouter models page](https://openrouter.ai/models) and filter by JSON mode support.

  **Local LLM (fallback):** When \`OPENROUTER_API_KEY\` is absent, the server uses a local OpenAI-compatible endpoint. Defaults: \`LOCAL_LLM_API_URL=http://localhost:8080/v1\`, \`LOCAL_LLM_MODEL=local-model\`. Per-task overrides: \`LOCAL_LLM_VERDICT_MODEL\`, \`LOCAL_LLM_TRIAGE_MODEL\`, \`LOCAL_LLM_REVIEW_MODEL\`, \`LOCAL_LLM_DIGEST_MODEL\`, \`LOCAL_LLM_SCOUT_MODEL\`, \`LOCAL_LLM_QUERY_MODEL\`.

  Edit \`mcp_config.json\`'s \`env\` block in your installed plugin folder to set your values. The installed plugin lives at \`~/.gemini/config/plugins/local-tester/mcp_config.json\` (or your Antigravity plugin staging path).
  ```

- [ ] **Step 10: Commit generator changes**

  ```bash
  git add scripts/generate-plugin-claude.js scripts/generate-plugin-codex.js scripts/generate-plugin-antigravity.js
  git commit -m "feat(generators): add OpenRouter env placeholders and bump plugin versions"
  ```

---

## Task 6: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add `## OpenRouter Configuration` section before `## Local LLM Configuration` (line 258)**

  Insert the following section immediately before the `## Local LLM Configuration` heading:

  ```md
  ## OpenRouter Configuration

  Set `OPENROUTER_API_KEY` to route all LLM calls through [OpenRouter](https://openrouter.ai) instead of a local endpoint. When the key is set it takes priority; the local LLM path is used only when the key is absent or when an OpenRouter call fails.

  | Variable | Required | Purpose |
  |---|---|---|
  | `OPENROUTER_API_KEY` | Yes (to enable OpenRouter) | Enables OpenRouter mode. Absence falls back to local LLM. |
  | `OPENROUTER_MODEL` | No | Default model for all tasks. Falls back to `openai/gpt-4o-mini`. |
  | `OPENROUTER_VERDICT_MODEL` | No | Per-task override for `run_test_verdict` |
  | `OPENROUTER_TRIAGE_MODEL` | No | Per-task override for `run_failure_triage` |
  | `OPENROUTER_REVIEW_MODEL` | No | Per-task override for `run_changed_files_review` |
  | `OPENROUTER_DIGEST_MODEL` | No | Per-task override for `run_command_digest` |
  | `OPENROUTER_SCOUT_MODEL` | No | Per-task override for `scout_codebase` |
  | `OPENROUTER_QUERY_MODEL` | No | Per-task override for `query_log` and inline `autoTriage` |

  ### JSON mode requirement

  All requests — both OpenRouter and local — send `response_format: { type: "json_object" }`. **The selected OpenRouter model must support JSON mode.** Models that do not support it will return an API error, which triggers an automatic retry against the local LLM (if configured) or surfaces as an error.

  Known-compatible models (non-exhaustive):
  - `openai/gpt-4o`
  - `openai/gpt-4o-mini` *(default)*
  - `anthropic/claude-3-5-sonnet`
  - `anthropic/claude-3-haiku`
  - `google/gemini-flash-1.5`

  Check the [OpenRouter models page](https://openrouter.ai/models) and filter by JSON mode support before choosing a model.

  ### Setting the key in a plugin install

  The `env` block in each generated plugin config is pre-populated with empty-string placeholders for all OpenRouter variables. Edit the config at your install location and fill in `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL`):

  | Client | Config location |
  |---|---|
  | Claude Code | `~/.claude/plugins/cache/<plugin-name>/.mcp.json` |
  | Codex | Codex plugin installation directory, `.mcp.json` |
  | Antigravity | `~/.gemini/config/plugins/local-tester/mcp_config.json` |

  ```json
  "env": {
    "OPENROUTER_API_KEY": "sk-or-v1-...",
    "OPENROUTER_MODEL": "openai/gpt-4o-mini"
  }
  ```

  ### `check_local_llm_health` when OpenRouter is configured

  When `OPENROUTER_API_KEY` is set, `check_local_llm_health` returns immediately with `skipped: true` and `available: true` without making a network call. The assumption is that a configured key is valid; live errors surface as `fallbackReason` on actual tool calls.

  ```

- [ ] **Step 2: Update `## Local LLM Configuration` to clarify it is the fallback path**

  Find the first line of the section (line 260 after insertion):
  ```md
  The server reads these environment variables:
  ```
  Replace with:
  ```md
  When `OPENROUTER_API_KEY` is not set, the server uses a local OpenAI-compatible endpoint. These environment variables configure that fallback path:
  ```

  Also find and update the last two sentences of the section (after the example block, around line 280):
  ```md
  If the local model is unavailable, returns invalid JSON, or cannot classify the result, the server reports an `uncertain` verdict or an advisory review issue instead of inventing confidence.

  All routing remains local-only. Task-specific model variables select a local model for that task; they do not enable remote fallback or hosted LLM calls.
  ```
  Replace with:
  ```md
  If the local model is unavailable, returns invalid JSON, or cannot classify the result, the server reports an `uncertain` verdict or an advisory review issue instead of inventing confidence.
  ```

- [ ] **Step 3: Update the MCP Client Setup JSON example to include OpenRouter vars**

  Find the JSON example under `## MCP Client Setup` (around lines 289–302):
  ```json
  {
    "mcpServers": {
      "local_tester": {
        "command": "node",
        "args": ["/absolute/path/to/local-tester-mcp/dist/index.js"],
        "env": {
          "LOCAL_LLM_API_URL": "http://localhost:8080/v1",
          "LOCAL_LLM_MODEL": "local-model"
        }
      }
    }
  }
  ```
  Replace with:
  ```json
  {
    "mcpServers": {
      "local_tester": {
        "command": "node",
        "args": ["/absolute/path/to/local-tester-mcp/dist/index.js"],
        "env": {
          "OPENROUTER_API_KEY": "",
          "OPENROUTER_MODEL": "",
          "LOCAL_LLM_API_URL": "http://localhost:8080/v1",
          "LOCAL_LLM_MODEL": "local-model"
        }
      }
    }
  }
  ```

- [ ] **Step 4: Update Requirements section to make local LLM optional**

  Find (around line 221):
  ```md
  - A local OpenAI-compatible chat completions endpoint.
  ```
  Replace with:
  ```md
  - An OpenRouter API key (`OPENROUTER_API_KEY`), **or** a local OpenAI-compatible chat completions endpoint — at least one must be configured.
  ```

- [ ] **Step 5: Commit README changes**

  ```bash
  git add README.md
  git commit -m "docs(readme): add OpenRouter configuration section and update LLM setup docs"
  ```

---

## Task 7: Update `skill/skill-example.md`

**Files:**
- Modify: `skill/skill-example.md`

- [ ] **Step 1: Update the `check_local_llm_health` tool description in the overview list**

  Find (line 14):
  ```md
  - `check_local_llm_health`: verifies the configured local OpenAI-compatible endpoint/model with a tiny JSON-only request and returns availability metadata.
  ```
  Replace with:
  ```md
  - `check_local_llm_health`: verifies the configured LLM provider. When `OPENROUTER_API_KEY` is set, returns `skipped: true` immediately (no network call — the key is assumed valid). Otherwise pings the local OpenAI-compatible endpoint and returns availability metadata.
  ```

- [ ] **Step 2: Add OpenRouter configuration note to the Guardrails section**

  Find the Guardrails section heading (line 187):
  ```md
  ## Guardrails
  ```
  Insert the following block immediately after the heading (before the first bullet):
  ```md
  **LLM provider:** Set `OPENROUTER_API_KEY` in the MCP server's `env` block to use OpenRouter as the primary provider. When absent, the server falls back to a local OpenAI-compatible endpoint (`LOCAL_LLM_API_URL`). If an OpenRouter call fails, the server automatically retries with the local endpoint and surfaces `fallbackReason` in the response. The chosen OpenRouter model must support `response_format: { type: "json_object" }` (JSON mode); models that do not support it will error and trigger the local fallback. Compatible models include `openai/gpt-4o`, `openai/gpt-4o-mini`, `anthropic/claude-3-5-sonnet`, `anthropic/claude-3-haiku`, and `google/gemini-flash-1.5`.

  **OpenRouter env vars:**
  - `OPENROUTER_API_KEY` — enables OpenRouter mode
  - `OPENROUTER_MODEL` — default model for all tasks (falls back to `openai/gpt-4o-mini`)
  - Per-task: `OPENROUTER_VERDICT_MODEL`, `OPENROUTER_TRIAGE_MODEL`, `OPENROUTER_REVIEW_MODEL`, `OPENROUTER_DIGEST_MODEL`, `OPENROUTER_SCOUT_MODEL`, `OPENROUTER_QUERY_MODEL`

  ```

- [ ] **Step 3: Commit skill changes**

  ```bash
  git add skill/skill-example.md
  git commit -m "docs(skill): add OpenRouter provider note and env var reference"
  ```

---

## Task 8: Build plugins and final commit

**Files:**
- Regenerated: `plugin/claude/`, `plugin/codex/` (Antigravity is gitignored)

- [ ] **Step 1: Build TypeScript (required before plugin generation)**

  ```bash
  npm run build 2>&1
  ```

  Expected: Zero errors.

- [ ] **Step 2: Generate all plugins**

  ```bash
  npm run build:plugin 2>&1
  ```

  Expected output (three lines):
  ```
  Generating Claude Code plugin structure...
  Claude Code plugin generated successfully under plugin/claude/
  Generating Codex plugin structure...
  Codex plugin generated successfully under plugin/codex/
  Generating Antigravity plugin structure...
  Antigravity plugin generated successfully under plugin/antigravity/
  ```

- [ ] **Step 3: Verify OpenRouter env placeholders appear in generated configs**

  ```bash
  grep -A3 "OPENROUTER_API_KEY" plugin/claude/.mcp.json plugin/codex/.mcp.json
  ```

  Expected: Both files show `"OPENROUTER_API_KEY": ""` in their `env` blocks.

- [ ] **Step 4: Verify VERSION bumps in generated manifests**

  ```bash
  grep '"version"' plugin/claude/.claude-plugin/plugin.json plugin/codex/.codex-plugin/plugin.json
  ```

  Expected:
  ```
  plugin/claude/.claude-plugin/plugin.json:  "version": "1.2.2",
  plugin/codex/.codex-plugin/plugin.json:  "version": "1.0.12",
  ```

- [ ] **Step 5: Commit regenerated plugin outputs**

  ```bash
  git add plugin/claude/ plugin/codex/ .claude-plugin/ .agents/
  git commit -m "chore(plugin): regenerate claude and codex plugins with OpenRouter env placeholders"
  ```
