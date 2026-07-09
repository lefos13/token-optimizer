import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import { loadJsonFile, saveJsonFile } from './store';

/* Per-email issued-token registry backing the request → approve → email flow.
   Only a sha256 hash of each issued token is persisted; the plaintext exists
   exactly once, at issue time, so it can be emailed to the requester. The
   public request endpoint enforces "one token per email ever": any existing
   record (whatever its status) blocks a new self-service request. Admin
   actions may still re-approve/regenerate deliberately. */
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'revoked';

export interface TokenRecord {
  email: string;
  status: RequestStatus;
  requestedAt: string;
  decidedAt?: string;
  tokenHash?: string;
  dailyLimit: number;
  usageDate?: string;
  usageCount?: number;
  totalCalls?: number;
}

export type AuthorizeResult =
  | { ok: true; email: string; remainingToday: number }
  | { ok: false; reason: 'unknown' | 'revoked' | 'daily_limit'; dailyLimit?: number };

export interface TokenStore {
  requestToken(email: string): { ok: true } | { ok: false; error: 'invalid_email' | 'exists' };
  listRequests(): TokenRecord[];
  approve(email: string): { ok: true; token: string; record: TokenRecord } | { ok: false; error: 'not_found' };
  deny(email: string): { ok: true; record: TokenRecord } | { ok: false; error: 'not_found' };
  revoke(email: string): { ok: true; record: TokenRecord } | { ok: false; error: 'not_found' };
  setDailyLimit(email: string, dailyLimit: number): { ok: true; record: TokenRecord } | { ok: false; error: 'not_found' | 'invalid_limit' };
  /* consume=true counts the call against the token's daily limit (chat);
     consume=false only validates (health checks, analytics pushes). */
  authorize(token: string, consume: boolean): AuthorizeResult;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,24}$/;

export function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') {
    return null;
  }
  const trimmed = email.trim().toLowerCase();
  return EMAIL_RE.test(trimmed) ? trimmed : null;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function today(now: () => number): string {
  return new Date(now()).toISOString().slice(0, 10);
}

export function createTokenStore(
  stateDir: string,
  defaultDailyLimit: number,
  now: () => number = () => Date.now()
): TokenStore {
  const filePath = path.join(stateDir, 'tokens.json');
  const records = new Map<string, TokenRecord>(
    Object.entries(loadJsonFile<Record<string, TokenRecord>>(filePath, {}))
  );

  function persist(): void {
    try {
      saveJsonFile(filePath, Object.fromEntries(records));
    } catch {
      /* persistence is best-effort; in-memory state still serves this process */
    }
  }

  return {
    requestToken(email: string) {
      const normalized = normalizeEmail(email);
      if (!normalized) {
        return { ok: false, error: 'invalid_email' as const };
      }
      if (records.has(normalized)) {
        return { ok: false, error: 'exists' as const };
      }
      records.set(normalized, {
        email: normalized,
        status: 'pending',
        requestedAt: new Date(now()).toISOString(),
        dailyLimit: defaultDailyLimit
      });
      persist();
      return { ok: true as const };
    },

    listRequests(): TokenRecord[] {
      return [...records.values()].sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    },

    approve(email: string) {
      const record = records.get(normalizeEmail(email) || '');
      if (!record) {
        return { ok: false, error: 'not_found' as const };
      }
      const token = `to_${randomBytes(32).toString('hex')}`;
      record.status = 'approved';
      record.decidedAt = new Date(now()).toISOString();
      record.tokenHash = hashToken(token);
      record.usageDate = undefined;
      record.usageCount = 0;
      persist();
      return { ok: true as const, token, record };
    },

    deny(email: string) {
      const record = records.get(normalizeEmail(email) || '');
      if (!record) {
        return { ok: false, error: 'not_found' as const };
      }
      record.status = 'denied';
      record.decidedAt = new Date(now()).toISOString();
      record.tokenHash = undefined;
      persist();
      return { ok: true as const, record };
    },

    revoke(email: string) {
      const record = records.get(normalizeEmail(email) || '');
      if (!record) {
        return { ok: false, error: 'not_found' as const };
      }
      record.status = 'revoked';
      record.decidedAt = new Date(now()).toISOString();
      persist();
      return { ok: true as const, record };
    },

    setDailyLimit(email: string, dailyLimit: number) {
      if (!Number.isFinite(dailyLimit) || dailyLimit < 0 || dailyLimit > 1_000_000) {
        return { ok: false, error: 'invalid_limit' as const };
      }
      const record = records.get(normalizeEmail(email) || '');
      if (!record) {
        return { ok: false, error: 'not_found' as const };
      }
      record.dailyLimit = Math.floor(dailyLimit);
      persist();
      return { ok: true as const, record };
    },

    authorize(token: string, consume: boolean): AuthorizeResult {
      const presented = hashToken(token);
      /* Scan all records (small registry) so lookup time does not depend on
         whether the token exists. Hash comparison is timing-safe. */
      let match: TokenRecord | undefined;
      for (const record of records.values()) {
        if (record.tokenHash && hashesEqual(record.tokenHash, presented)) {
          match = record;
        }
      }
      if (!match) {
        return { ok: false, reason: 'unknown' };
      }
      if (match.status !== 'approved') {
        return { ok: false, reason: 'revoked' };
      }
      const day = today(now);
      if (match.usageDate !== day) {
        match.usageDate = day;
        match.usageCount = 0;
      }
      const used = match.usageCount || 0;
      if (consume) {
        if (used >= match.dailyLimit) {
          return { ok: false, reason: 'daily_limit', dailyLimit: match.dailyLimit };
        }
        match.usageCount = used + 1;
        match.totalCalls = (match.totalCalls || 0) + 1;
        persist();
        return { ok: true, email: match.email, remainingToday: match.dailyLimit - match.usageCount };
      }
      return { ok: true, email: match.email, remainingToday: Math.max(0, match.dailyLimit - used) };
    }
  };
}
