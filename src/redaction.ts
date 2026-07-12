export type RedactionReplacement = (substring: string, ...args: unknown[]) => string;

export interface RedactionRule {
  pattern: RegExp | string;
  flags?: string;
  category: string;
  replace?: RedactionReplacement;
  replacement?: string;
}

export interface RedactionOptions {
  customRules?: readonly RedactionRule[];
}

export interface RedactionResult {
  text: string;
  count: number;
  categories: string[];
}

const MAX_CUSTOM_RULES = 20;
const MAX_PATTERN_LENGTH = 500;
const MAX_REPLACEMENT_LENGTH = 256;
const MAX_REDACTION_INPUT_LENGTH = 1024 * 1024;
const SAFE_FLAGS = /^[dgimsuv]*$/;

/* These rules target credential-shaped values while retaining labels, routes, and
 * surrounding diagnostics. They intentionally avoid matching prose placeholders. */
const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /(\bAuthorization\s*:\s*Bearer\s+)[^\s,;]+/gi,
    category: 'bearer-token',
    replace: (_match, prefix) => `${String(prefix)}***`,
  },
  {
    pattern: /((?:Authorization|Proxy-Authorization)\s*:\s*)(?:Basic|Digest|Token)\s+[^\r\n]+/gi,
    category: 'auth-header',
    replace: (_match, prefix) => `${String(prefix)}***`,
  },
  {
    pattern: /((?:X-Api-Key|X-API-Token|X-Auth-Token|X-Access-Token|Api-Key|API_Token)\s*:\s*)[^\r\n]+/gi,
    category: 'api-key-header',
    replace: (_match, prefix) => `${String(prefix)}***`,
  },
  {
    pattern: /\b((?:[A-Z][A-Z0-9]*_)?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD))\s*([:=])\s*([^\s,;]+)/g,
    category: 'secret-assignment',
    replace: (_match, name, separator) => `${String(name)}${String(separator)}***`,
  },
  {
    pattern: /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/)([^\s/:@]+):([^\s/@]+)@/gi,
    category: 'connection-string',
    replace: (_match, scheme, user) => `${String(scheme)}${String(user)}:***@`,
  },
  {
    pattern: /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|AWSAccessKeyId|Signature|sig|access_token|oauth_token|token)=)[^&#\s]+/gi,
    category: 'signed-url',
    replace: (_match, prefix) => `${String(prefix)}***`,
  },
];

function normalizeRule(rule: RedactionRule): RedactionRule & { pattern: RegExp } {
  if (!rule || typeof rule.category !== 'string' || rule.category.trim().length === 0) {
    throw new TypeError('redaction rule category must be a non-empty string');
  }
  if (rule.flags && !SAFE_FLAGS.test(rule.flags)) throw new TypeError('redaction rule contains invalid or duplicate flags');
  if (rule.replacement && rule.replacement.length > MAX_REPLACEMENT_LENGTH) throw new RangeError('redaction rule replacement is too long');
  let pattern: RegExp;
  if (rule.pattern instanceof RegExp) {
    if (rule.pattern.source.length > MAX_PATTERN_LENGTH) throw new RangeError('redaction rule pattern is too long');
    pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
  } else if (typeof rule.pattern === 'string') {
    if (rule.pattern.length > MAX_PATTERN_LENGTH) throw new RangeError('redaction rule pattern is too long');
    try {
      /* Nested unbounded quantifiers are rejected before compilation because they
       * are the common catastrophic-backtracking shape in user configuration. */
      /* Custom expressions use a deliberately small safe subset. Ambiguous
       * branching, backreferences, lookarounds, and quantified groups are
       * excluded because JavaScript has no dependable regex execution budget. */
      if (/\||\\[1-9]|\(\?|\)[+*?{]|(?:[+*?]|\{\d+(?:,\d*)?\})(?:[+*?]|\{)/.test(rule.pattern)) throw new TypeError('unsafe redaction rule pattern');
      const flags = rule.flags || '';
      pattern = new RegExp(rule.pattern, flags.includes('g') ? flags : `${flags}g`);
    } catch (error) {
      throw new TypeError(`invalid regular expression in redaction rule: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    throw new TypeError('redaction rule pattern must be a regular expression or string');
  }
  return { ...rule, pattern };
}

export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  if (text.length > MAX_REDACTION_INPUT_LENGTH) throw new RangeError('redaction input is too large');
  const customRules = options.customRules ?? [];
  if (customRules.length > MAX_CUSTOM_RULES) throw new RangeError(`too many custom redaction rules (maximum ${MAX_CUSTOM_RULES})`);
  let output = text;
  let count = 0;
  const categories = new Set<string>();
  for (const rule of [...DEFAULT_REDACTION_RULES, ...customRules.map(normalizeRule)]) {
    const replacement = rule.replace ?? (rule.replacement !== undefined ? (() => rule.replacement as string) : (() => '***'));
    output = output.replace(rule.pattern, (...args) => {
      count += 1;
      categories.add(rule.category);
      return replacement(...args);
    });
  }
  return { text: output, count, categories: [...categories].sort() };
}
