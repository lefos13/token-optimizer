# Installer Task 4 review

## Decision

Approved. The alpha.7 amendment closes the previously identified Windows, fixture, invalid-mode, and contract-test gaps.

## Findings

No blocking findings remain.


## Positive checks

- `planMigration` preserves a legacy `LLM_GATEWAY_URL` for inferred `gateway-byok` and emits a compatibility warning.
- Explicit `openrouter-direct` resolves to the OpenRouter destination.
- All five generated installer launchers contain serialized credential lookup, including Windows `windows-dpapi`, and aligned alpha.7 versions are present in root/installer metadata, source metadata, generators, and shipped assets.
- Five-client fake-home migration fixtures now verify destination writes, no raw credential persistence, and idempotent repeated application.
- Core and CLI invalid-provider paths fail closed; canonical provider contract tests pass.
- The launcher constructs a separate child environment and does not write resolved secrets back to config or stdout.
- Config-manager metadata keys are additive and existing managed-key merge behavior remains intact.

## Verification run

Ran:

```text
npm test -- --test-name-pattern='provider choice|launcher|gateway config|BYOK|invalid provider'
```

Result: full `npm test` = 179 passed, 0 failed. Alpha.7 alignment checks passed; all five installer launchers contain the Windows DPAPI branch.
