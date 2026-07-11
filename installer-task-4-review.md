# Installer Task 4 review

## Decision

Not approved. The provider migration direction is sound, but the submitted Task 4 package is incomplete and the shipped installer artifacts do not match the launcher source.

## Findings

1. **Critical — generated/shipped launchers are stale.** `scripts/launcher-template.js` now resolves `TOKEN_OPTIMIZER_CREDENTIAL_REF`, but none of the five committed `packages/installer/assets/plugin/*/server/start.js` launchers contain that logic. The installer therefore ships launchers that cannot perform the credential-reference migration it advertises. The report explicitly defers regeneration; that is not safe for an installable change. Bump aligned release versions and run `npm run build:plugin` before merge, then verify all five bundles and installer assets.

2. **Critical — native credential references cannot be resolved.** `credential-store.js` produces object references (`{ store, service, account, fingerprint }`), while `buildProviderValues` writes `options.credentialRef` directly into an environment value and the launcher treats the value as an environment-variable-name string. Objects are discarded by config sanitizers, and config/native stores are never queried. Add a stable serialized reference/lookup contract (or a launcher-side credential-store resolver) and tests proving no plaintext is written and the secret reaches only the MCP child.

3. **Important — required five-client migration fixtures are missing.** The Task 4 plan calls for `test/installer/migration.test.ts` covering all five clients, destination preservation, warnings, native-store references, and idempotency. No such test exists, so client-specific destination regressions are not covered.

4. **Important — invalid installer provider values silently fall through.** `normalizeProviderChoice` returns `null` for an invalid explicit value; `buildProviderValues` then infers a provider and the CLI falls into the interactive menu. A typo such as `--provider=gateway-tokn` can therefore configure a different provider rather than fail clearly. Reject invalid explicit values (while retaining `gateway`/`byok` aliases), or return a documented conservative warning/result and add a test.

5. **Important — verification claim is false on the current tree.** The focused suite has one failure: `test/installer/cli.test.ts` still expects `--byok-key` to return `byok`, while the implementation returns `gateway-byok`. Either update the compatibility test to assert the canonical mode plus alias behavior, or preserve the legacy return shape at this API boundary. The report's claim that `npm test` passed is therefore not reproducible.

## Positive checks

- `planMigration` preserves a legacy `LLM_GATEWAY_URL` for inferred `gateway-byok` and emits a compatibility warning.
- Explicit `openrouter-direct` resolves to the OpenRouter destination.
- The launcher constructs a separate child environment and does not write resolved secrets back to config or stdout.
- Config-manager metadata keys are additive and existing managed-key merge behavior remains intact.

## Verification run

Ran:

```text
npm test -- --test-name-pattern='provider choice|launcher|gateway config|BYOK|invalid provider'
```

Result: 53 passed, 1 failed (legacy CLI expectation described above). Also confirmed the five committed installer launchers lack `TOKEN_OPTIMIZER_CREDENTIAL_REF` handling.
