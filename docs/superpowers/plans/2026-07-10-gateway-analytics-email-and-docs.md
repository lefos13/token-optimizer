# Gateway Analytics, Email, and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count only significant analytics in the gateway, deliver approved tokens through Nodemailer, and make npm installation the end-user quickstart while moving all gateway operations guidance into `gateway/README.md`.

**Architecture:** The gateway stats store owns both the 1,000-token admission threshold and a schema-version reset, keeping every MCP client consistent. The approval route retains its injectable email sender while the production sender switches from Resend HTTP to Nodemailer transport configuration compatible with `softaware-apis`. Documentation is split by audience: product users, installer users, and gateway operators.

**Tech Stack:** TypeScript, Node.js built-in test runner, Nodemailer, npm package generation.

## Global Constraints

- Only analytics records with `rawSourceTokens >= 1000` contribute to public gateway statistics.
- Reset legacy `global-stats.json` aggregate data automatically on gateway startup; do not modify token records.
- Do not log email credentials, issued plaintext tokens, or request bodies.
- Preserve the approval API's existing manual-token fallback when delivery is unavailable or fails.
- Add short `/* ... */` comments above non-obvious modified code sections.
- Update `README.md`, `gateway/README.md`, `skill/skill-example.md`, and generated plugin assets when instructions or gateway behavior change.
- Bump every generated plugin version and the installer patch version; regenerate assets with `npm run build:plugin` and `npm run build:installer`.

---

### Task 1: Filter and reset public gateway analytics

**Files:**
- Modify: `gateway/src/stats.ts`
- Modify: `test/gateway/token-flow.test.ts`

**Interfaces:**
- Consumes: `createStatsStore(stateDir)` and `StatsStore.ingest(raw)`.
- Produces: `StatsStore.publicStats()` that excludes sub-1,000-token records and starts from an empty v2 aggregate state.

- [ ] **Step 1: Write failing stats tests**

Add tests that ingest a 999-token record and a 1,000-token record, then assert only the latter is counted. Seed `global-stats.json` with a legacy state lacking the new schema version and assert the next store instance returns zero calls.

```ts
assert.equal(store.ingest({ toolName: 'digest', rawSourceTokens: 999 }), true);
assert.equal(store.ingest({ toolName: 'digest', rawSourceTokens: 1000 }), true);
assert.equal(store.publicStats().totalCalls, 1);
assert.equal(reopened.publicStats().totalCalls, 0);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- --test-name-pattern=analytics`

Expected: FAIL because the current store counts the 999-token record and loads legacy aggregate totals.

- [ ] **Step 3: Implement the stats schema and threshold**

Add `STATS_SCHEMA_VERSION = 2` and `MIN_SHARED_ANALYTICS_RAW_TOKENS = 1000`. Initialize a new empty state whenever the persisted state version differs, persist that reset immediately, and return success without aggregation when a sanitized record is below the threshold.

```ts
if (record.rawSourceTokens < MIN_SHARED_ANALYTICS_RAW_TOKENS) {
  return true;
}
```

- [ ] **Step 4: Run the focused tests and verify success**

Run: `npm test -- --test-name-pattern=analytics`

Expected: PASS.

### Task 2: Replace Resend delivery with Nodemailer Gmail/SMTP transport

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `gateway/src/config.ts`
- Modify: `gateway/src/email.ts`
- Modify: `gateway/deploy/gateway.env.example`
- Test: `test/gateway/token-flow.test.ts`

**Interfaces:**
- Consumes: `GatewayConfig` and `sendTokenEmail(config, to, token)`.
- Produces: Gmail app-password or SMTP delivery for approved tokens, returning `{ sent, error? }` without leaking secrets.

- [ ] **Step 1: Add a failing email transport test**

Export a narrow transport-options builder from `gateway/src/email.ts` and test the desired Gmail and SMTP configurations:

```ts
assert.deepEqual(buildTransportOptions(gmailConfig), {
  service: 'gmail', auth: { user: 'mailer@example.com', pass: 'app-password' }
});
assert.equal(buildTransportOptions(smtpConfig).host, 'smtp.example.com');
```

- [ ] **Step 2: Run the focused email test and verify failure**

Run: `npm test -- --test-name-pattern=Nodemailer`

Expected: FAIL because the Resend sender has no Nodemailer transport builder.

- [ ] **Step 3: Install the runtime dependency**

Run: `npm install nodemailer@^8.0.10`.

Expected: `package.json` and `package-lock.json` include Nodemailer. If TypeScript requires it, run `npm install -D @types/nodemailer` and include its lockfile update.

- [ ] **Step 4: Implement configuration and Nodemailer sender**

Replace `resendApiKey` with provider-specific fields in `GatewayConfig`; load `EMAIL_PROVIDER`, Gmail app-password fields, SMTP fields, `EMAIL_FROM`, and `EMAIL_REPLY_TO`. Build a Gmail service transport for `EMAIL_PROVIDER=gmail`, otherwise a generic SMTP transport. Call `transporter.sendMail` with the existing token email content and return a safe error string on failure.

- [ ] **Step 5: Update the deployment environment example**

Replace `RESEND_API_KEY` with documented Gmail and SMTP variables; use empty placeholders only.

- [ ] **Step 6: Run focused gateway tests and verify success**

Run: `npm test -- --test-name-pattern="Nodemailer|token request"`

Expected: PASS. No external SMTP connection is attempted by tests.

### Task 3: Align user and operator documentation, version generated outputs

**Files:**
- Modify: `README.md`
- Modify: `packages/installer/README.md`
- Modify: `gateway/README.md`
- Modify: `skill/skill-example.md`
- Modify: `scripts/generate-plugin-antigravity.js`
- Modify: `scripts/generate-plugin-claude.js`
- Modify: `scripts/generate-plugin-codex.js`
- Modify: `scripts/generate-plugin-opencode.js`
- Modify: `scripts/generate-plugin-cursor.js`
- Modify: `packages/installer/package.json`
- Generated: `plugin/claude/`, `plugin/codex/`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json`, `packages/installer/assets/`

**Interfaces:**
- Consumes: the threshold and Nodemailer behavior from Tasks 1–2.
- Produces: audience-specific docs and versioned generated plugin/installer releases.

- [ ] **Step 1: Make npm installation the root quickstart**

Start `README.md` with a concise end-user quickstart using `npx @softawarest/token-optimizer-installer`, provider selection, and client restart. Remove gateway deployment, token administration, SMTP, and portal-operation instructions from this file; link operators to `gateway/README.md`.

- [ ] **Step 2: Update installer and skill instructions**

Document running `npx` outside a source checkout, provider options, the 1,000-token global analytics threshold, and that operator setup lives in the gateway README. Keep credentials out of examples.

- [ ] **Step 3: Update the gateway operator README**

Document the automatic v2 stats reset, qualifying-call threshold, NodeMailer Gmail app-password variables, generic SMTP variables, approval delivery behavior, and manual fallback.

- [ ] **Step 4: Bump release versions**

Increase all five generator `VERSION` constants for regenerated plugin instruction output. Increase `packages/installer/package.json` from `1.9.2` to `1.9.3`.

- [ ] **Step 5: Generate artifacts and run verification**

Run: `npm run build:plugin`, `npm run build:installer`, `npm test`, and `npm pack ./packages/installer --dry-run`.

Expected: generators complete; tests pass; the packed installer reports version `1.9.3` and includes the changed gateway runtime plus updated documentation assets.

- [ ] **Step 6: Commit release-ready changes**

```bash
git add gateway src package.json package-lock.json README.md packages/installer skill scripts plugin .claude-plugin .agents test docs/superpowers/plans
git commit -m "feat: refine gateway analytics and token delivery"
```

Do not publish to npm or deploy the gateway; those remain release-owner actions.
