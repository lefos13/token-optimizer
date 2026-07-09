# Launcher Dependency Recovery Design

## Problem

The generated Token Optimizer launchers currently consider their runtime dependencies ready when the copied `package.json` matches and a `node_modules` directory exists. A partial npm extraction can satisfy those checks while still being unusable. The reproduced installation had a `zod` directory without its `package.json`, causing `@modelcontextprotocol/sdk` to throw `Cannot find module 'zod/v3'` before the MCP server registered any tools.

The configured OpenRouter BYOK route is healthy: a live request through the gateway succeeded with HTTP 200 and no proxy token. The provider credential is therefore unrelated to the startup crash. The generated Codex marketplace configuration nevertheless has a separate BYOK propagation gap because its `env_vars` list omits `OPENROUTER_BYOK_KEY`.

## Goals

- Detect incomplete or unusable runtime dependency caches before starting the MCP server.
- Repair an invalid cache automatically without reinstalling dependencies on every healthy startup.
- Apply the same recovery behavior to every generated client launcher.
- Forward `OPENROUTER_BYOK_KEY` through the generated Codex marketplace configuration.
- Preserve existing provider selection, MCP tool contracts, and healthy-cache startup behavior.

## Design

Each JavaScript launcher will treat a dependency cache as ready only when all of these conditions hold:

1. The cached manifest matches the generated server manifest.
2. The cache contains `node_modules`.
3. Node can resolve the MCP SDK server entry point from that cache.
4. Node can resolve the SDK's required `zod/v3` compatibility entry point from that cache.

When any condition fails, the launcher will remove only the cache's `node_modules` directory, copy the current manifest, and run the existing scoped npm installation. Removing the incomplete dependency tree ensures npm cannot incorrectly retain a damaged package. After npm succeeds, the launcher will repeat the resolution checks. If the cache remains invalid, it will report a concise error on stderr and exit before starting the MCP server.

The POSIX launchers will receive equivalent resolution checks and scoped cache cleanup so behavior remains consistent across clients. The implementation will preserve stderr for installation and diagnostic messages, leaving stdout exclusively for JSON-RPC.

The Codex generator will add `OPENROUTER_BYOK_KEY` to `env_vars` alongside the existing gateway variables. Direct installer configuration will remain unchanged because it already writes the BYOK key correctly.

## Testing

Tests will first reproduce the defect with a matching manifest and an existing but incomplete dependency directory. The expected behavior is that the launcher invokes dependency installation instead of attempting to start the server with the damaged cache.

Generator assertions will verify that:

- generated manifests and launchers contain the dependency validation and recovery behavior;
- generated Codex configuration forwards `OPENROUTER_BYOK_KEY`;
- healthy dependency caches retain the fast path;
- invalid caches fail clearly if installation does not produce resolvable dependencies.

After the focused tests pass, validation will include the TypeScript build, full test suite, plugin regeneration, installer build/package checks where practical, changed-file review, and regression checking without mutating unrelated user files.

## Documentation and Versioning

Because launcher behavior, setup requirements, and generated skill/plugin output change, `README.md` and `skill/skill-example.md` will describe automatic cache validation and repair. Every plugin generator version will be bumped, followed by `npm run build:plugin` so committed Claude and Codex outputs and installer assets match their sources.

## Safety and Scope

Cleanup is restricted to the known `node_modules` directory beneath the launcher-owned data directory. Workspace files, generated test logs, baselines, provider credentials, and unrelated gateway/email changes will not be modified. Secret values will never be printed by tests or diagnostics.
