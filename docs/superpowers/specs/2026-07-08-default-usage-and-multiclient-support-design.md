# Default-On Usage Directive + opencode/Cursor Client Support — Design

Date: 2026-07-08
Status: Approved (brainstorming), pending implementation plan
Follows: 2026-07-08-gateway-cleanup-and-client-onboarding-design.md (client onboarding via `gateway:config` is live; Claude Code, Codex, and Antigravity are confirmed working end-to-end through the gateway)

## Goal

Three related gaps, closed together:

1. **Make usage default-on.** The shipped skill's trigger description is heuristic — the model may or may not reach for `local_tester` tools on its own. Add a standing, explicit directive into each client's global instructions file so the tools are used by default unless the user says otherwise.
2. **Fix opencode's missing skill discovery.** opencode's MCP registration was wired manually in an earlier session, but opencode never picked up the skill guidance because it discovers skills only via `SKILL.md` files in specific paths — none was ever placed there.
3. **Add full generator support for opencode and Cursor**, bringing them to parity with the existing Claude Code / Codex / Antigravity generators instead of leaving them as one-off manual edits.

## Decisions

| Decision | Choice |
| --- | --- |
| Directive content | Mirrors the skill's existing triggers (scout / verdict / triage / regression / changed-files-review) as a standing default-on rule, not just a heuristic description |
| Directive delivery | Idempotent `<!-- LOCAL_TESTER_START/END -->` marker block, same convention CodeGraph's installer already uses in the same three files |
| Directive command home | New subcommands on the existing `scripts/manage-gateway-config.js` (`enable-defaults` / `disable-defaults`), reusing its `getManagedTargets(home)` plumbing |
| opencode packaging | Full generator (`scripts/generate-plugin-opencode.js` → `plugin/opencode/`), not manual wiring |
| Cursor packaging | Full generator (`scripts/generate-plugin-cursor.js` → `plugin/cursor/`), not manual wiring |
| opencode/Cursor output tracking | **Gitignored**, like Antigravity — neither client has a marketplace/git-based auto-install, so committing the output buys nothing; regenerate + re-copy/re-merge on change |
| Cursor cross-project rule reach | No filesystem-writable global rule exists in Cursor (Settings-UI only) — ship a project-scoped `.cursor/rules/local-tester.mdc` per generator output; document the limitation rather than solve it |

## Section 1 — `gateway:config` gains `enable-defaults` / `disable-defaults`

Targets (all confirmed to exist and already carry a CodeGraph marker block in the same idempotent style):

- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`
- `~/.gemini/GEMINI.md`

Block content:

```
<!-- LOCAL_TESTER_START -->
## Local Tester (default-on)

Always use the `local_tester` MCP tools by default:

- `scout_codebase` before broad exploration of an unfamiliar area.
- `run_test_verdict` before claiming a change works.
- `run_failure_triage` on test/build/lint failures instead of reading raw logs.
- `run_regression_check` before merging.
- `run_changed_files_review` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
<!-- LOCAL_TESTER_END -->
```

- `enable-defaults`: if the target file exists, insert the block if the markers are absent; if the markers are present, replace only the content between them (idempotent — safe to re-run after wording changes; does not duplicate).
- `disable-defaults`: remove the marker block (including the markers) if present; no-op if absent.
- `status`: each target gains a fourth reported line — directive `configured` / `not configured` — alongside the existing token/URL line.
- Targets that don't exist on disk are skipped (matches existing `getManagedTargets` behavior for missing files) — do not create a client's global instructions file from scratch.

## Section 2 — opencode generator (`scripts/generate-plugin-opencode.js` → `plugin/opencode/`)

opencode has no plugin/marketplace concept for MCP servers (confirmed: plugins are JS lifecycle hooks only; MCP registration and skills are both separate, static, file-based mechanisms). Output layout:

```
plugin/opencode/server/*.js            (compiled server, copied from dist/, same as other generators)
plugin/opencode/server/package.json    (single runtime dep to install)
plugin/opencode/server/start.sh        (self-locating launcher, same pattern as Antigravity's)
plugin/opencode/skills/local-llm-subagent/SKILL.md   (same content as plugin/claude/skills/local-llm-subagent/SKILL.md)
plugin/opencode/mcp-snippet.jsonc      (the exact block to merge into opencode.jsonc's "mcp" object)
plugin/opencode/README.md              (install/merge instructions)
```

`mcp-snippet.jsonc` content:

```jsonc
{
  "local_tester": {
    "type": "local",
    "command": ["bash", "<absolute-path-to-copied-server>/start.sh"],
    "environment": {
      "LLM_GATEWAY_URL": "{env:LLM_GATEWAY_URL}",
      "LLM_GATEWAY_TOKEN": "{env:LLM_GATEWAY_TOKEN}"
    },
    "enabled": true
  }
}
```

`README.md` documents: copy `server/` to a stable location (e.g. `~/.config/opencode/local-tester-server/`), copy `skills/local-llm-subagent/` to `~/.config/opencode/skills/local-llm-subagent/` (global — applies to every opencode project), merge `mcp-snippet.jsonc` into `~/.config/opencode/opencode.jsonc`'s `"mcp"` object (substituting the real server path), then run `gateway:config setup` for the token/URL.

## Section 3 — Cursor generator (`scripts/generate-plugin-cursor.js` → `plugin/cursor/`)

Output layout:

```
plugin/cursor/server/*.js              (compiled server, copied from dist/)
plugin/cursor/server/package.json
plugin/cursor/server/start.sh          (self-locating launcher)
plugin/cursor/rules/local-tester.mdc   (alwaysApply: true, same directive content as Section 1's block)
plugin/cursor/mcp-snippet.json         (the exact block to merge into mcp.json)
plugin/cursor/README.md                (install/merge instructions + documented rule-scope limitation)
```

`local-tester.mdc`:

```
---
alwaysApply: true
---

Always use the `local_tester` MCP tools by default:

- `scout_codebase` before broad exploration of an unfamiliar area.
- `run_test_verdict` before claiming a change works.
- `run_failure_triage` on test/build/lint failures instead of reading raw logs.
- `run_regression_check` before merging.
- `run_changed_files_review` for small diffs before running expensive validation.

Skip only when the user explicitly says not to use it.
```

`mcp-snippet.json` content:

```json
{
  "mcpServers": {
    "local_tester": {
      "command": "bash",
      "args": ["<absolute-path-to-copied-server>/start.sh"],
      "env": {
        "LLM_GATEWAY_URL": "${env:LLM_GATEWAY_URL}",
        "LLM_GATEWAY_TOKEN": "${env:LLM_GATEWAY_TOKEN}"
      }
    }
  }
}
```

`README.md` documents: copy `server/` to a stable location, merge `mcp-snippet.json` into `~/.cursor/mcp.json` (global, substituting the real server path), copy `rules/local-tester.mdc` into each project's `.cursor/rules/` (per-project — Cursor has no filesystem-writable global rule; a true cross-project default requires the user to also add an equivalent rule via Cursor Settings, which is documented as a limitation, not solved), then run `gateway:config setup` for the token/URL.

## Section 4 — Build wiring, versioning, docs

- `package.json`: add `build:plugin:opencode`, `build:plugin:cursor`; `build:plugin` runs all five generators.
- `.gitignore`: add `plugin/opencode/` and `plugin/cursor/` (alongside the existing `plugin/antigravity/` ignore).
- `VERSION` bumped to `1.5.0` in **all five** generator scripts (the three existing ones bump too, per the project's "bump every plugin package for every change" rule, since this change touches shared skill content and adds new capability).
- `README.md`: new "opencode" and "Cursor" install sections (parallel to the existing "Antigravity" section); mention `gateway:config -- enable-defaults` / `disable-defaults` in the "Provide your token" section.
- `AGENTS.md` / `CLAUDE.md`: repo-shape sections list the two new generator scripts and the two new gitignore entries.
- `skill/skill-example.md`: no content change expected (the skill's own trigger text is unchanged); confirm during implementation that nothing there contradicts the new default-on directive.

## Testing

- `test/scripts/gateway-config.test.ts`: new cases for `enable-defaults` (insert into a fresh temp file with no markers; re-run is idempotent, no duplication; re-run after content change replaces only the inner block), `disable-defaults` (removes cleanly; no-op when absent), and `status` reporting the directive line — all via the existing temp-home + real-file seam, no mocks.
- `npm run build`, `npm run build:gateway`, `npm test` — full suite must stay green.
- `npm run build:plugin` — regenerate all five; grep for `1.5.0` across all five manifests; grep case-insensitively for `OPENROUTER` (none expected); confirm `plugin/opencode/` and `plugin/cursor/` exist on disk but are excluded by `git status` (gitignored, matching Antigravity's existing behavior).

## Out of scope / non-goals

- No attempt to make Cursor's rule apply across all projects automatically — documented limitation only.
- No change to the gateway service itself.
- No automatic merge of the opencode/Cursor MCP snippets into the user's live config files — the generator produces the snippet; merging it in is a manual, documented step (same shape as Antigravity's existing copy-in step).
- No removal or change to the existing manual opencode MCP wiring already present on this machine's `~/.config/opencode/opencode.jsonc` — the new generator's output supersedes it going forward, but this spec doesn't require touching that file as part of the implementation (a follow-up local step, not a repo change).

## Risks

- Five generators now share a `VERSION` bump discipline; missing one on a future change silently breaks the intended parity — same risk that already exists for the three current generators, unchanged in kind.
- opencode and Cursor's MCP/skill/rule file formats are based on external documentation research (opencode.ai/docs, cursor.com/docs) rather than hands-on verification in this repo before now; the implementation should smoke-test the generated snippet against each real client where practical.
