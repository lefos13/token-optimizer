# Installer Task 5 review

## Decision

Approved. The follow-up commit adds a bounded default `/health` probe,
canonicalizes provider aliases, rejects placeholder credentials, and exposes
version/source fields. The implementation remains read-only, emits a stable
schema and finding shape, and preserves the required doctor exit-code contract.
No accidental review-artifact or generated-plugin changes are present in the
reviewed range.

## Findings

1. **[P2] JSON credential detection misses non-empty JSON config values.**
   `configContains` requires an `=` separator, while Cursor/OpenCode config
   entries use `:`. A valid credential persisted in those JSON files is not
   recognized and can produce a false `CREDENTIAL_MISSING` finding. Parse the
   supported formats or accept both `:` and `=` with value-aware matching.

2. **[P3] “Detected” version is currently the expected package version.**
   When no `--installed-version` is supplied, the report sets
   `installedVersion` to `expectedVersion` and labels the source `detected`,
   without reading installed launcher/package metadata. This is stable but
   potentially masks stale installs; either inspect the install root or label
   the value as assumed.

3. **[P3] Provider URL is returned without URL-credential redaction.**
   A user-supplied URL containing basic-auth credentials or sensitive query
   parameters would be echoed in JSON. Normalize/redact URL userinfo and
   credential-like query values before returning the report.

These are follow-ups rather than blockers for the read-only contract: no secret
value is returned by the fixture tests, inspection only reads filesystem state,
the default health probe is bounded, and `--strict` correctly maps warning-only
reports to exit code 2.

## Verification performed

- `npm test -- --test-name-pattern='doctor|status|read-only|VERSION_MISMATCH|redact|placeholder|health probe'` — 44 passing, 0 failing.
- Manually verified status suppresses health probes while doctor performs the injectable probe; JSON remained parseable and strict warnings exited 2.
- Reviewed `git diff 0748a7d..1b22343`; only the Task 5 implementation/tests/report were added.
