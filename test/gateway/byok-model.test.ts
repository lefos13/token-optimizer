import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByokModelHeader } from '../../gateway/src/byok-model';

test('parseByokModelHeader distinguishes absent, valid, and invalid values', () => {
  assert.deepEqual(parseByokModelHeader(undefined), { kind: 'absent' });
  assert.deepEqual(parseByokModelHeader('openai/gpt-4o-mini'), {
    kind: 'valid', model: 'openai/gpt-4o-mini'
  });
  assert.deepEqual(parseByokModelHeader('meta-llama/llama-3.3-70b-instruct:free'), {
    kind: 'valid', model: 'meta-llama/llama-3.3-70b-instruct:free'
  });

  for (const value of [
    '',
    'openai',
    ' openai/gpt-4o-mini',
    'openai/gpt 4o',
    'openai/gpt-4o\nmini',
    `${'a'.repeat(100)}/${'b'.repeat(100)}`,
  ]) {
    assert.deepEqual(parseByokModelHeader(value), { kind: 'invalid' });
  }
  assert.deepEqual(parseByokModelHeader(['openai/gpt-4o-mini']), { kind: 'invalid' });
});
