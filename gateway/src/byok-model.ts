export type ByokModelOverride =
  | { kind: 'absent' }
  | { kind: 'valid'; model: string }
  | { kind: 'invalid' };

const MAX_BYOK_MODEL_LENGTH = 199;
const OPENROUTER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/* Keep caller-controlled model selection narrow and deterministic. OpenRouter
   IDs use provider/model form; arrays, whitespace, controls, and oversized
   values are rejected before any upstream request is made. */
export function parseByokModelHeader(raw: string | string[] | undefined): ByokModelOverride {
  if (raw === undefined) {
    return { kind: 'absent' };
  }
  if (Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BYOK_MODEL_LENGTH) {
    return { kind: 'invalid' };
  }
  if (raw !== raw.trim() || !OPENROUTER_MODEL_RE.test(raw)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', model: raw };
}
