# BYOK OpenRouter Model Override Design

## Status

Approved for implementation on 2026-07-10.

## Goal

Allow a user who configures a bring-your-own OpenRouter key to optionally choose one OpenRouter model for all Token Optimizer LLM tasks. If the user does not provide a model, the gateway continues selecting its configured task-specific or default model exactly as it does today.

The override applies only to BYOK requests. Users of shared or issued gateway tokens cannot override the operator-controlled model selection.

## User Experience

The interactive BYOK installation and configuration flows ask for the OpenRouter API key and then prompt:

```text
OpenRouter model ID (optional; Enter for gateway default):
```

An empty answer preserves the existing gateway-managed behavior. A non-empty answer is stored as the single model used for verdict, triage, review, digest, scout, and query tasks.

Automated installations expose the same capability through:

```text
--byok-model <model-id>
```

The option is meaningful only with the BYOK provider. It does not change local-LLM or shared-gateway-token configuration.

## Architecture

The client stores the optional selection in `OPENROUTER_BYOK_MODEL`. When resolving a gateway provider, it sends `X-OpenRouter-Model` only when both `OPENROUTER_BYOK_KEY` and a non-empty model value are configured.

The gateway honors `X-OpenRouter-Model` only when the request also contains a valid BYOK key accepted by the existing BYOK path. For an eligible request, the gateway replaces the request body's model with the validated caller selection. Otherwise, it continues calling `resolveModel(...)`, preserving central task-specific and default model selection.

This explicit header keeps model-selection intent separate from the OpenAI-compatible request body and prevents gateway-token callers from selecting arbitrary operator-funded models.

## Configuration Surfaces

`OPENROUTER_BYOK_MODEL` becomes a managed configuration key everywhere provider configuration is written. Provider changes must clear it together with the other managed values so a stale BYOK model cannot affect a later setup.

The following surfaces must remain aligned:

- The npm installer's interactive BYOK flow and `--byok-model` flag.
- The repository `gateway:config` setup/update flow.
- Client-specific configuration writers for Claude, Codex, Antigravity, OpenCode, Cursor, and the macOS GUI-session environment.
- Generated plugin and installer assets.

No per-task BYOK model map is introduced. A single configured override applies to every LLM task.

## Validation and Error Handling

The client trims the configured model and omits the header when the result is empty. A configured model without a BYOK key is not sent.

The gateway validates the header as a bounded, non-empty OpenRouter model identifier before forwarding a request. Validation should accept normal provider/model identifiers while rejecting control characters, whitespace-containing values, and oversized input.

If a BYOK request contains an invalid model header, the gateway returns `400` and does not silently fall back to the operator-funded model. Model override headers on non-BYOK requests are ignored, and normal gateway model pinning remains authoritative.

OpenRouter responses for unknown, unavailable, unauthorized, or unfunded model access pass through unchanged. The client then uses its existing gateway-failure behavior, including its configured local-LLM fallback and `fallbackReason` metadata.

Neither the BYOK key nor its model value is persisted by the gateway or included in error details. The chosen model may appear in existing response metadata and privacy-preserving analytics because those surfaces already record the model that actually ran.

## Compatibility

The change is backward compatible:

- Existing installations do not have `OPENROUTER_BYOK_MODEL`, so they retain gateway-managed selection.
- BYOK installations that leave the new prompt blank behave exactly as before.
- Shared gateway-token and local-provider behavior is unchanged.
- OpenRouter's response model remains authoritative for returned LLM metadata and analytics.

## Testing

Tests must cover:

- Interactive BYOK setup stores an optional model and accepts a blank value.
- `--byok-model` configures the same managed value non-interactively.
- Switching provider modes clears a stale BYOK model.
- Client provider resolution emits `X-OpenRouter-Model` only with a BYOK key and configured model.
- A valid BYOK model overrides task-specific and default gateway models.
- A BYOK request without an override retains existing gateway model selection.
- Shared gateway-token requests cannot override the model.
- Empty, malformed, control-character-containing, whitespace-containing, and oversized model headers are handled according to the validation rules.
- Upstream model errors are forwarded and do not fall back to the gateway operator's OpenRouter key.
- Returned metadata reports the model OpenRouter says actually ran.

## Documentation and Release Work

Update `README.md`, `gateway/README.md`, the installer README/help output, and `skill/skill-example.md` to document the optional model, its BYOK-only scope, and blank-value behavior.

Because this affects server behavior, installer behavior, environment variables, and shipped documentation, implementation must bump the aligned release version in the root package, installer package, MCP server metadata, and all five plugin generators. It must then regenerate plugin and installer assets according to the repository instructions.

## Out of Scope

- Separate model choices per Token Optimizer task.
- A model-discovery API or interactive list of current OpenRouter models.
- Direct client-to-OpenRouter requests that bypass the gateway.
- Allowing shared gateway-token users to override operator-managed models.
