# Gateway Access Request Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public root-page portal that submits access-token requests through the existing gateway API without changing any existing route contracts.

**Architecture:** Add a self-contained HTML renderer to `gateway/src/pages.ts`, parallel to the existing stats and admin pages. Register `GET /` in the existing HTTP router; the embedded browser script will call the existing `POST /v1/token-requests` endpoint and translate its documented status codes into safe, user-facing feedback.

**Tech Stack:** Node 18+ built-in HTTP server, TypeScript, Node's built-in test runner.

## Global Constraints

- Preserve the `POST /v1/token-requests` request and response contract for programmatic clients.
- Keep `/admin`, `/stats`, `/health`, and existing `/v1/*` routes unchanged.
- Do not add runtime dependencies or expose server error details in the public page.
- Add a short block comment when modifying a non-obvious code section.
- Run `npm run build`, `npm test`, and `npm run build:plugin` after the TypeScript and documentation changes.

---

### Task 1: Public portal route and renderer

**Files:**
- Modify: `gateway/src/pages.ts`
- Modify: `gateway/src/server.ts`
- Test: `test/gateway/token-flow.test.ts`

**Interfaces:**
- Consumes: `sendHtml(res, status, html)` and `createGatewayServer(config, deps)` from `gateway/src/server.ts`.
- Produces: `renderAccessRequestPage(): string`, served by `GET /` as `text/html; charset=utf-8`.

- [ ] **Step 1: Write the failing route-level test**

Add this test to `test/gateway/token-flow.test.ts` before changing production code:

```ts
test('root serves the public access request portal', async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.ok(html.includes('Request access'));
    assert.ok(html.includes('/v1/token-requests'));
    assert.ok(html.includes('type="email"'));
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- --test-name-pattern="root serves the public access request portal"`

Expected: FAIL because `GET /` currently returns `404`.

- [ ] **Step 3: Add the minimal HTML renderer**

Append this renderer to `gateway/src/pages.ts`:

```ts
/* Public access-request page delegates all validation and request persistence
   to the established JSON endpoint, keeping browser and API clients aligned. */
export function renderAccessRequestPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>token-optimizer — request access</title>
<style>
:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:38rem;margin:10vh auto;padding:0 1.25rem}form{display:grid;gap:.75rem}input,button{font:inherit;padding:.65rem}#message{min-height:1.5rem}
</style></head><body><main>
<h1>Request access</h1><p>Enter your email to request a token for the token-optimizer gateway.</p>
<form id="request-form"><label>Email <input id="email" name="email" type="email" autocomplete="email" required></label><button type="submit">Request access</button></form>
<p id="message" role="status" aria-live="polite"></p>
<script>
const form=document.getElementById('request-form');const email=document.getElementById('email');const message=document.getElementById('message');
form.addEventListener('submit',async function(event){event.preventDefault();message.textContent='Submitting…';const response=await fetch('/v1/token-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email.value.trim()})});if(response.status===202){message.textContent='Request submitted. You will receive your token after approval.';form.reset();return}if(response.status===400){message.textContent='Enter a valid email address.';return}if(response.status===409){message.textContent='A request already exists for this email address.';return}if(response.status===429){message.textContent='Too many requests. Please try again shortly.';return}message.textContent='Unable to submit your request. Please try again.';});
</script></main></body></html>`;
}
```

- [ ] **Step 4: Register the root route**

Update the pages import in `gateway/src/server.ts` and insert this route before the health route:

```ts
import { renderAccessRequestPage, renderStatsPage, renderAdminPage } from './pages';

// Inside the HTTP request handler:
if (req.method === 'GET' && req.url === '/') {
  return sendHtml(res, 200, renderAccessRequestPage());
}
```

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `npm test -- --test-name-pattern="root serves the public access request portal"`

Expected: PASS, with the root page returned as HTML and containing the existing API endpoint.

- [ ] **Step 6: Commit the implementation test and route**

```bash
git add gateway/src/pages.ts gateway/src/server.ts test/gateway/token-flow.test.ts
git commit -m "feat: add gateway access request portal"
```

### Task 2: Document and package the public route

**Files:**
- Modify: `gateway/README.md`
- Modify: `README.md`
- Modify: `skill/skill-example.md`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Regenerate: `plugin/claude/`, `plugin/codex/`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`

**Interfaces:**
- Consumes: the public `GET /` route from Task 1 and the unchanged `POST /v1/token-requests` API.
- Produces: consistent user and skill documentation; regenerated packages marked with incremented versions.

- [ ] **Step 1: Add the failing documentation expectation to the route test**

Extend the test from Task 1 with an assertion that the portal provides the success wording:

```ts
assert.ok(html.includes('You will receive your token after approval.'));
```

- [ ] **Step 2: Run the focused test to verify it is already green**

Run: `npm test -- --test-name-pattern="root serves the public access request portal"`

Expected: PASS because Task 1's page already communicates the documented approval lifecycle.

- [ ] **Step 3: Document the route and preserve API guidance**

In `gateway/README.md`, add `GET /` to the request contract before `POST /v1/token-requests`, state that it is the browser portal, and keep the existing API endpoint documented for programmatic clients. In the root `README.md` and `skill/skill-example.md`, tell users to visit `https://<gateway-host>/` to request a token and retain the existing API form where applicable.

- [ ] **Step 4: Bump each generated plugin version**

Increment each `VERSION` constant in the five generator scripts by one patch version. Do not edit files below `plugin/` manually.

- [ ] **Step 5: Build, test, and regenerate packages**

Run:

```bash
npm run build
npm test
npm run build:plugin
```

Expected: TypeScript compiles, the Node test suite passes, and generated Claude/Codex plugin assets reflect the version bumps and current skill documentation.

- [ ] **Step 6: Commit docs and generated packages**

```bash
git add gateway/README.md README.md skill/skill-example.md scripts/generate-plugin-antigravity.js scripts/generate-plugin-claude.js scripts/generate-plugin-codex.js scripts/generate-plugin-opencode.js scripts/generate-plugin-cursor.js plugin .claude-plugin/marketplace.json .agents/plugins/marketplace.json
git commit -m "docs: document gateway access request portal"
```

### Task 3: Final changed-file review and verification

**Files:**
- Review: `gateway/src/pages.ts`
- Review: `gateway/src/server.ts`
- Review: `test/gateway/token-flow.test.ts`
- Review: documentation and regenerated plugin files from Task 2

**Interfaces:**
- Consumes: completed source, tests, documentation, and generated plugin assets from Tasks 1–2.
- Produces: verification evidence that the public portal is additive and existing gateway surfaces remain stable.

- [ ] **Step 1: Run a changed-file review**

Use `run_changed_files_review` with `workspacePath` set to the repository root, the changed repo-relative file paths, and `useDiff: true`.

Expected: advisory review result; investigate any concrete issue before finalizing.

- [ ] **Step 2: Run the final gateway test verdict**

Use `run_test_verdict` with:

```json
{
  "workspacePath": "C:\\Users\\slode\\Documents\\Projects\\local-llm-connector-mcp",
  "taskSummary": "Validate the additive public gateway access-request portal and unchanged token lifecycle/admin routes.",
  "testCommand": "npm test",
  "changedFiles": ["gateway/src/pages.ts", "gateway/src/server.ts", "test/gateway/token-flow.test.ts"],
  "autoTriage": true
}
```

Expected: `pass`. If the Token Optimizer MCP surface is unavailable, run `npm test` directly and report that fallback.

- [ ] **Step 3: Confirm the final diff is cleanly scoped**

Run:

```bash
git diff --check HEAD~2..HEAD
git status --short
```

Expected: no whitespace errors and no unintended files.
