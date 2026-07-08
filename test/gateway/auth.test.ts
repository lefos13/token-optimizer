import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBearer, isAuthorized } from '../../gateway/src/auth';

test('extractBearer pulls the token or returns null', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc');
  assert.equal(extractBearer('bearer  xyz '), 'xyz');
  assert.equal(extractBearer('Token abc'), null);
  assert.equal(extractBearer(undefined), null);
});

test('isAuthorized accepts a listed token and rejects others', () => {
  const tokens = ['good-token'];
  assert.equal(isAuthorized('Bearer good-token', tokens), true);
  assert.equal(isAuthorized('Bearer bad', tokens), false);
  assert.equal(isAuthorized(undefined, tokens), false);
});
