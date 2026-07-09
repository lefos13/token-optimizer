# Token-request notifications and bot hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the operator about accepted token requests and quietly discard basic bot submissions without a CAPTCHA provider.

**Architecture:** A Nodemailer helper sends an operator notice to `GMAIL_USER` after token storage succeeds. The public form submits a honeypot and start time; the API's bot checks return the standard pending response without state changes.

**Tech Stack:** TypeScript, Node HTTP, Nodemailer, Node test runner.

## Global Constraints

- `GMAIL_USER` must be the notification recipient and never appear in a public response.
- Notifications are best-effort and cannot change a valid HTTP 202 outcome.
- Preserve rate limits, duplicate prevention, and current JSON errors.
- Honeypot or too-fast requests return HTTP 202 and neither store nor notify.
- Use concise block comments for non-obvious TypeScript logic.
- Update docs and skill materials, bump every generator from `1.10.3` to `1.10.4`, then regenerate assets.

---

### Task 1: Operator notification helper

**Files:**
- Modify: `gateway/src/email.ts`
- Test: `test/gateway/email.test.ts`

**Interfaces:**
- Produces `buildTokenRequestNotificationText(requesterEmail: string, requestedAt: Date): string`.
- Produces `sendTokenRequestNotification(config: GatewayConfig, requesterEmail: string, requestedAt: Date): Promise<EmailResult>`.

- [ ] **Step 1: Write a failing test**

```ts
test('operator notification includes requester and UTC timestamp', () => {
  const text = gatewayEmail.buildTokenRequestNotificationText('requester@example.com', new Date('2026-07-10T12:00:00.000Z'));
  assert.match(text, /requester@example\.com/);
  assert.match(text, /2026-07-10T12:00:00\.000Z/);
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- --test-name-pattern "operator notification"`

Expected: FAIL because the helper is undefined.

- [ ] **Step 3: Add the minimal helper**

```ts
export function buildTokenRequestNotificationText(email: string, requestedAt: Date): string {
  return ['A Token Optimizer gateway access token was requested.', '', `Requester email: ${email}`, `Requested at: ${requestedAt.toISOString()}`].join('\n');
}
```

Implement `sendTokenRequestNotification` with the existing transport, `to: config.gmailUser`, subject `New token-optimizer access request`, and the same `EmailResult` failure convention as `sendTokenEmail`.

- [ ] **Step 4: Verify green and commit**

Run: `npm test -- --test-name-pattern "operator notification"`

Expected: PASS.

Run: `git add gateway/src/email.ts test/gateway/email.test.ts && git commit -m "feat: notify operator of token requests"`

### Task 2: Request handler notification and bot filtering

**Files:**
- Modify: `gateway/src/server.ts`
- Modify: `gateway/src/pages.ts`
- Test: `test/gateway/token-flow.test.ts`

**Interfaces:**
- Extends `ServerDeps` with `tokenRequestNotificationSender?: (config: GatewayConfig, requesterEmail: string, requestedAt: Date) => Promise<EmailResult>`.
- Accepts `{ email: string; website?: string; startedAt?: number }` for `POST /v1/token-requests`.

- [ ] **Step 1: Write failing request-flow tests**

```ts
test('a new request notifies the operator after storage', async () => {
  // Inject tokenRequestNotificationSender, submit a valid body, assert one call with notify@example.com.
});
test('honeypot and too-fast requests return pending without storage or notification', async () => {
  // Submit website='spam' and startedAt=Date.now(); assert 202 and zero admin request records.
});
```

- [ ] **Step 2: Verify red**

Run: `npm test -- --test-name-pattern "notifies the operator|honeypot and too-fast"`

Expected: FAIL because the dependency and controls are absent.

- [ ] **Step 3: Implement the minimal controls**

```ts
/* Bot checks occur before persistent state mutation and use the ordinary pending
   response so automated callers cannot determine which control rejected them. */
const MIN_REQUEST_COMPLETION_MS = 1_500;
const PENDING_RESPONSE = { status: 'pending', message: 'Request received. You will get your token by email once approved.' };
if (typeof body?.website === 'string' && body.website.trim()) return sendJson(res, 202, PENDING_RESPONSE);
if (body?.startedAt !== undefined && (!Number.isFinite(body.startedAt) || Date.now() - body.startedAt < MIN_REQUEST_COMPLETION_MS || Date.now() - body.startedAt > 3_600_000)) return sendJson(res, 202, PENDING_RESPONSE);
// Invoke notificationSender(config, email, new Date()) only after requestToken succeeds.
```

Add a visually hidden `website` input, set `const startedAt = Date.now()` when the page initializes, and submit both fields with email.

- [ ] **Step 4: Verify green and commit**

Run: `npm test -- --test-name-pattern "notifies the operator|honeypot and too-fast"`

Expected: PASS.

Run: `git add gateway/src/server.ts gateway/src/pages.ts test/gateway/token-flow.test.ts && git commit -m "feat: harden token request endpoint"`

### Task 3: Documentation, generated packages, and validation

**Files:**
- Modify: `gateway/README.md`, `gateway/deploy/gateway.env.example`, `README.md`, `skill/skill-example.md`
- Modify: all five `scripts/generate-plugin-*.js` files
- Regenerate: `plugin/claude/`, `plugin/codex/`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`

- [ ] **Step 1: Update documentation and versions**

Document best-effort accepted-request alerts sent to `GMAIL_USER`, quiet honeypot/too-fast discards, and browser fields. Change every `const VERSION = "1.10.3";` to `const VERSION = "1.10.4";`.

- [ ] **Step 2: Compile and run tests**

Run: `npm run build && npm run build:gateway`

Expected: exit 0.

Call `mcp__token_optimizer__run_test_verdict` with `testCommand: "npm test"`, changed files, `autoTriage: true`, and a concrete task summary. Expected: `verdict: "pass"`.

- [ ] **Step 3: Review and generate**

Call `mcp__token_optimizer__run_changed_files_review` with `useDiff: true` before `npm run build:plugin`; resolve verified findings. Regenerate, then review generated committed artifacts with that tool.

- [ ] **Step 4: Commit documentation and generated assets**

Run: `git add gateway/README.md gateway/deploy/gateway.env.example README.md skill/skill-example.md scripts plugin/claude plugin/codex .claude-plugin/marketplace.json .agents/plugins/marketplace.json && git commit -m "docs: document token request protections"`
