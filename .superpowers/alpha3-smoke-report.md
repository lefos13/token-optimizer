# Alpha3 smoke-test report

## Change

The generated plugin and installer entrypoint test now loads each of the ten
`server/index.js` bundles in an isolated Node child process. Each child sets
`TOKEN_OPTIMIZER_NO_AUTOSTART=1`, ignores stdin, and is checked for a successful
exit without `MaxListenersExceededWarning`. This keeps the existing ten-bundle
load coverage while preventing MCP stdin listeners from accumulating in the
test runner.

## Verification

- `npm test` — passed; 158 tests, 0 failures.
- `npm run build` — passed.
- `npm run build:plugin` — passed.
- `npm run build:installer` — passed.
- `npm pack ./packages/installer --dry-run` — passed for `2.0.0-alpha.3`.
- Direct isolated-process smoke — loaded all 10 entrypoints without listener warnings.
- `git diff --check` — passed.
