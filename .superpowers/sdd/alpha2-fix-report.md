# Alpha.2 final fixes

- Baseline and analytics metadata now reject symlinks/non-regular files and use atomic replacement under the managed log root.
- Production command streaming uses bounded head/tail/marker collectors with linear counters.
- Safe/standard command policy rejects environment-variable path operands.
- Failure triage requires a workspace and confines logs to the managed registry directory.
- Unix fallback termination reports `guarantee: false` when only the direct child can be signalled.

Verification:

- `npm run build` — passed.
- `npm test` — 157 passed, 0 failed.
- `npm run build:plugin` — passed; generated assets refreshed.
- `npm run build:installer` — passed; installer assets refreshed.
- `npm pack ./packages/installer --dry-run` — passed (`@softawarest/token-optimizer-installer@2.0.0-alpha.3`).
