# Installer Task 4 review

## Decision

Not approved. Alpha.6 adds fail-closed core validation, but the Windows native path is still incompatible with the emitted DPAPI reference and the full suite is red.

## Findings

1. **Critical — Windows DPAPI references still cannot be resolved.** `credential-store-windows.js` emits `store: "windows-dpapi"` and stores ciphertext at `credential.dpapi`; generated launchers only enter the `parsed.store === "native"` branch and then attempt to read a JSON config file. Windows installs therefore inject no secret. Match the emitted store and invoke DPAPI unprotect against the configured file path, with a generated-asset test.

2. **Important — migration fixtures do not exercise actual client destinations or idempotency.** `test/installer/migration.test.ts` loops over five client labels, but `planMigration` ignores `client`; each case is the same pure object assertion. There is no fixture that reads/writes Claude, Codex, Antigravity, OpenCode, or Cursor config, and no repeated migration/apply assertion. Add per-client destination fixtures and an idempotency check.

3. **Important — invalid installer provider values are fail-closed in the CLI but not in the core API.** `resolveProviderOptions` now rejects an invalid explicit flag, which is good, but `buildProviderValues({provider: 'gateway-tokn', gatewayToken: ...})` still silently infers `gateway-token`. Any programmatic installer caller can therefore bypass the fail-closed behavior. Make core normalization distinguish invalid explicit input from omitted input and add a direct core test.

4. **Important — verification claim is false on the current tree.** Full `npm test` reports 176 passed and 3 failed: the stale canonical BYOK CLI expectation, the installer `buildProviderValues` key-shape expectation, and the config-manager `emptyManagedValues` key-shape expectation. Update those compatibility tests/contracts before claiming the suite passes.

## Positive checks

- `planMigration` preserves a legacy `LLM_GATEWAY_URL` for inferred `gateway-byok` and emits a compatibility warning.
- Explicit `openrouter-direct` resolves to the OpenRouter destination.
- All five generated installer launchers contain serialized credential lookup, and aligned alpha.6 versions are present in root/installer metadata, source metadata, generators, and shipped assets.
- The launcher constructs a separate child environment and does not write resolved secrets back to config or stdout for the supported env/config stores.
- Config-manager metadata keys are additive and existing managed-key merge behavior remains intact.

## Verification run

Ran:

```text
npm test -- --test-name-pattern='provider choice|launcher|gateway config|BYOK|invalid provider'
```

Result: full `npm test` = 176 passed, 3 failed. Alpha.6 alignment checks passed; generated launchers were inspected for the credential branches.
