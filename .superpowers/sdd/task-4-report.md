# Task 4 report: validate every LLM task response

## Changes

- Added `src/llm-schemas.ts` with strict, task-specific Zod schemas for verdict/triage, review, digest, scout, and query responses.
- Added bounded strings and array sizes, numeric confidence bounds, strict object checking, nested failure/pointer validation, and semantic checks for contradictory `pass` verdicts and reviews.
- Added `parseLLMResponse`, returning a discriminated success result or compact validation errors, including malformed JSON and unsupported task handling.
- Updated all LLM query paths to parse through the schemas and preserve their existing conservative fallback behavior when model output is invalid.
- Added shared response-task and validation-error types in `src/types.ts`.
- Added malformed, contradictory, oversized, unknown-field, and valid-fixture coverage in `test/client/llm-schemas.test.ts`.

## Verification

- `npm test -- --test-name-pattern="LLM|verdict|triage|review|digest|scout|query"` — passed.
- `npm test` — 123 tests passed.
- `npm run build` — passed.
- `git diff --check` — passed.

## Notes

Invalid model responses now enter the same existing fallback paths used for invalid JSON or unavailable providers. Valid responses retain their previous output fields and metadata attachment behavior.
