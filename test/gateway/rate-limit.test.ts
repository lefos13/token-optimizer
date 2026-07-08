import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../../gateway/src/rate-limit';

test('limiter allows up to N per window then blocks, and resets', () => {
  let now = 1000;
  const limiter = createRateLimiter(2, () => now);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  now += 60_000;
  assert.equal(limiter.allow('k'), true);
});

test('perMin<=0 disables limiting', () => {
  const limiter = createRateLimiter(0);
  for (let i = 0; i < 100; i++) assert.equal(limiter.allow('k'), true);
});
