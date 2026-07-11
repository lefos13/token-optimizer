# Installer Task 4 review

## Decision

Not approved yet. The amended commit fixes the generated-asset/version gap and adds the requested migration fixtures, but credential lookup coverage and the canonical CLI test suite are still incomplete.

## Findings

1. **Important — native credential references still cannot be resolved.** The generated launchers now resolve serialized `env` and `config` references, but `credential-store.js` also emits native references for macOS Keychain, Linux Secret Service, and Windows DPAPI. No launcher path invokes those native stores, and there is no child-only native lookup test. A migrated native reference therefore yields no provider secret. Add a platform-neutral launcher resolver/bridge (or explicitly constrain references to stores the launcher supports) and tests for config plus each native adapter without exposing the secret to the parent/config.

2. **Important — migration fixtures do not exercise actual client destinations or idempotency.** `test/installer/migration.test.ts` loops over five client labels, but `planMigration` ignores `client`; each case is the same pure object assertion. There is no fixture that reads/writes Claude, Codex, Antigravity, OpenCode, or Cursor config, and no repeated migration/apply assertion. Add per-client destination fixtures and an idempotency check.

3. **Important — invalid installer provider values are fail-closed in the CLI but not in the core API.** `resolveProviderOptions` now rejects an invalid explicit flag, which is good, but `buildProviderValues({provider: 'gateway-tokn', gatewayToken: ...})` still silently infers `gateway-token`. Any programmatic installer caller can therefore bypass the fail-closed behavior. Make core normalization distinguish invalid explicit input from omitted input and add a direct core test.

4. **Important — verification claim is still false on the current tree.** The focused suite has one failure: `test/installer/cli.test.ts` still expects `--byok-key` to return `byok`, while the implementation returns `gateway-byok`. Update the canonical CLI test (and add explicit alias coverage) before claiming the full suite passes.

## Positive checks

- `planMigration` preserves a legacy `LLM_GATEWAY_URL` for inferred `gateway-byok` and emits a compatibility warning.
- Explicit `openrouter-direct` resolves to the OpenRouter destination.
- All five generated installer launchers now contain the serialized `credentialRef` lookup, and aligned alpha.4 versions are present in root/installer metadata, source metadata, generators, and shipped assets.
- The launcher constructs a separate child environment and does not write resolved secrets back to config or stdout for the supported env/config stores.
- Config-manager metadata keys are additive and existing managed-key merge behavior remains intact.

## Verification run

Ran:

```text
npm test -- --test-name-pattern='provider choice|launcher|gateway config|BYOK|invalid provider'
```

Result: 59 passed, 1 failed (legacy CLI expectation described above). `npm run build` passed and `npm pack ./packages/installer --dry-run` passed for `2.0.0-alpha.4`.
