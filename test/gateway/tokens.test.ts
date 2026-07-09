import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTokenStore, normalizeEmail } from '../../gateway/src/tokens';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-tokens-'));
}

test('normalizeEmail lowercases, trims, and rejects garbage', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(42), null);
  assert.equal(normalizeEmail('a b@example.com'), null);
});

test('one request per email ever, case-insensitive', () => {
  const store = createTokenStore(tmpDir(), 20);
  assert.deepEqual(store.requestToken('user@example.com'), { ok: true });
  assert.deepEqual(store.requestToken('USER@example.com'), { ok: false, error: 'exists' });
  assert.deepEqual(store.requestToken('bad'), { ok: false, error: 'invalid_email' });
});

test('approve issues a token whose plaintext is never persisted', () => {
  const dir = tmpDir();
  const store = createTokenStore(dir, 20);
  store.requestToken('user@example.com');
  const approved = store.approve('user@example.com');
  assert.ok(approved.ok && approved.token.startsWith('to_'));
  const persisted = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8');
  assert.ok(!persisted.includes((approved as any).token));
  assert.ok(persisted.includes('tokenHash'));
});

test('daily limit is enforced per UTC day and resets on the next day', () => {
  let clock = Date.parse('2026-07-09T10:00:00Z');
  const store = createTokenStore(tmpDir(), 2, () => clock);
  store.requestToken('user@example.com');
  const approved = store.approve('user@example.com');
  assert.ok(approved.ok);
  const token = (approved as any).token as string;

  assert.equal(store.authorize(token, true).ok, true);
  assert.equal(store.authorize(token, true).ok, true);
  const limited = store.authorize(token, true);
  assert.deepEqual(limited, { ok: false, reason: 'daily_limit', dailyLimit: 2 });
  /* Non-consuming validation (health/analytics) still succeeds at the limit. */
  assert.equal(store.authorize(token, false).ok, true);

  clock = Date.parse('2026-07-10T00:01:00Z');
  assert.equal(store.authorize(token, true).ok, true);
});

test('revoked tokens stop authorizing; unknown tokens never authorize', () => {
  const store = createTokenStore(tmpDir(), 20);
  store.requestToken('user@example.com');
  const approved = store.approve('user@example.com');
  assert.ok(approved.ok);
  const token = (approved as any).token as string;
  assert.equal(store.authorize(token, true).ok, true);
  store.revoke('user@example.com');
  assert.deepEqual(store.authorize(token, true), { ok: false, reason: 'revoked' });
  assert.deepEqual(store.authorize('to_deadbeef', true), { ok: false, reason: 'unknown' });
});

test('setDailyLimit validates and updates; state survives reload from disk', () => {
  const dir = tmpDir();
  const store = createTokenStore(dir, 20);
  store.requestToken('user@example.com');
  const approved = store.approve('user@example.com');
  assert.ok(approved.ok);
  assert.equal(store.setDailyLimit('user@example.com', 100).ok, true);
  assert.deepEqual(store.setDailyLimit('user@example.com', -1), { ok: false, error: 'invalid_limit' });
  assert.deepEqual(store.setDailyLimit('missing@example.com', 5), { ok: false, error: 'not_found' });

  const reloaded = createTokenStore(dir, 20);
  const record = reloaded.listRequests()[0];
  assert.equal(record.dailyLimit, 100);
  assert.equal(reloaded.authorize((approved as any).token, true).ok, true);
});
