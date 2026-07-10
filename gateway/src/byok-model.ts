export type ByokModelOverride =
  | { kind: 'absent' }
  | { kind: 'valid'; model: string }
  | { kind: 'invalid' };

const MAX_BYOK_MODEL_LENGTH = 199;
const OPENROUTER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/* Keep caller-controlled model selection narrow and deterministic. An empty
   header opts out, while arrays, whitespace, controls, oversized values, and
   malformed OpenRouter provider/model IDs are rejected before upstream use. */
export function parseByokModelHeader(raw: string | string[] | undefined): ByokModelOverride {
  if (raw === undefined || raw === '') {
    return { kind: 'absent' };
  }
  if (Array.isArray(raw) || raw.length > MAX_BYOK_MODEL_LENGTH) {
    return { kind: 'invalid' };
  }
  if (raw !== raw.trim() || !OPENROUTER_MODEL_RE.test(raw)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', model: raw };
}
