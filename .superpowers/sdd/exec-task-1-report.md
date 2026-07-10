# Task 1 execution report

Implemented deny-first command policy and workspace confinement.

- Added `evaluateCommand` with safe, standard, and unrestricted profile decisions.
- Added canonical workspace/symlink containment checks, sensitive-path and environment-dump detection, nested-shell, destructive, and network/exfiltration denials.
- Extended execution configuration/types with optional auto-detected command prefixes.
- Added focused policy tests covering allowlist, sensitive paths, symlink escape, profile behavior, and deny-first enforcement.

Follow-up fixes closed review findings: redirection operands are parsed and
confined, separated `rm -r -f`/`rm -f -r` flags are denied, and `runCommand`
evaluates policy before invoking the shell. An integration test verifies a
blocked command cannot execute.

Verification: focused policy/runner tests, `npm run build`, and `git diff --check` all pass.
