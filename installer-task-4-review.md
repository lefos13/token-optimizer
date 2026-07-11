# Installer Task 4 review

## Decision

Not approved yet. Alpha.5 assets and native lookup support improved, but the core API, destination/idempotence coverage, and canonical CLI suite still have gaps.

## Findings

1. **Important — Windows native credential references still cannot be resolved.** The generated launchers now resolve serialized `env`, `config`, macOS Keychain, and Linux Secret Service references, but the `native` branch has no Windows/DPAPI path even though `credential-store-windows.js` emits native references. A Windows migration therefore yields no provider secret. Add a DPAPI lookup bridge or explicitly reject unsupported native references, with child-only tests.

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
