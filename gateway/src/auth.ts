import { timingSafeEqual } from 'node:crypto';

export function extractBearer(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* Accept the request only if its bearer token matches one of the configured
   tokens. Length-guarded timingSafeEqual avoids leaking token length/content
   through comparison timing. */
export function isAuthorized(header: string | undefined, tokens: string[]): boolean {
  const token = extractBearer(header);
  if (!token) {
    return false;
  }
  return tokens.some((t) => safeEqual(t, token));
}
