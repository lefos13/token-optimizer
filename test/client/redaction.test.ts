import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { redactText } from '../../src/redaction';

test('redacts credentials while preserving actionable context', () => {
  const input = [
    'Authorization: Bearer abc.def.ghi',
    'OPENAI_API_KEY=sk-live-1234567890',
    'postgres://user:password@db.example/app',
  ].join('\n');
  const result = redactText(input);
  assert.doesNotMatch(result.text, /abc\.def|sk-live|password/);
  assert.match(result.text, /Authorization: Bearer \*\*\*/);
  assert.equal(result.count, 3);
});

test('redacts broad auth and API-key headers across multiline text', () => {
  const result = redactText([
    'X-Api-Key: key-value',
    'api-key: another-key',
    'Proxy-Authorization: Basic dXNlcjpwYXNz',
  ].join('\n'));
  assert.match(result.text, /X-Api-Key: \*\*\*/);
  assert.match(result.text, /api-key: \*\*\*/);
  assert.match(result.text, /Proxy-Authorization: \*\*\*/);
  assert.equal(result.count, 3);
});

test('redacts signed URL secrets but keeps the URL route and safe parameters', () => {
  const input = 'GET https://storage.example/files/report.csv?download=1&X-Amz-Signature=abc123&sig=xyz';
  const result = redactText(input);
  assert.match(result.text, /https:\/\/storage\.example\/files\/report\.csv\?download=1/);
  assert.doesNotMatch(result.text, /abc123|xyz/);
  assert.equal(result.count, 2);
});

test('supports bounded custom rules and typed replacement callbacks', () => {
  const result = redactText('ticket SECRET-123 and SECRET-456', {
    customRules: [{
      pattern: /SECRET-\d{3}/g,
      category: 'ticket',
      replace: (match) => `[${match.length} chars]`,
    }],
  });
  assert.equal(result.text, 'ticket [10 chars] and [10 chars]');
  assert.deepEqual(result.categories, ['ticket']);
  assert.equal(result.count, 2);
});

test('rejects invalid or oversized custom rules', () => {
  assert.throws(() => redactText('x', { customRules: [{ pattern: '(', category: 'bad' }] }), /unsafe|invalid regular expression/i);
  assert.throws(() => redactText('x', { customRules: new Array(21).fill({ pattern: /x/g, category: 'too-many' }) }), /too many/i);
  assert.throws(() => redactText('x', { customRules: [{ pattern: new RegExp('x'.repeat(501), 'g'), category: 'too-long' }] }), /too long/i);
});

test('does not redact ordinary prose that merely mentions API keys', () => {
  const input = 'Use the API_KEY_NAME placeholder in the documentation; no credential is present.';
  const result = redactText(input);
  assert.equal(result.text, input);
  assert.equal(result.count, 0);
});

test('rejects unsafe flags, replacements, and catastrophic nested quantifiers', () => {
  assert.throws(() => redactText('x', { customRules: [{ pattern: 'x', flags: 'y', category: 'bad' }] as any }), /flags/i);
  assert.throws(() => redactText('a'.repeat(100), { customRules: [{ pattern: '(a+)+$', category: 'bad' }] }), /unsafe/i);
  assert.throws(() => redactText('x', { customRules: [{ pattern: 'x', category: 'bad', replacement: 'z'.repeat(257) }] as any }), /replacement/i);
});

test('rejects ambiguous or stateful regex constructs and bounds input', () => {
  for (const pattern of ['a|aa', '(a){1,3}{2}', '(a+){2}', '(?=secret)secret', '(a)\\1', '[a-z]+(?:x)?', 'a+a+$', '[a-z]+[a-z]+$', 'a{1,500}a{1,500}$']) {
    assert.throws(() => redactText('secret', { customRules: [{ pattern, category: 'unsafe' }] }), /unsafe/i, pattern);
  }
  assert.throws(() => redactText('x'.repeat(1_048_577)), /input is too large/i);
});

test('rejects aggregate expanded-width amplification within a subprocess budget', () => {
  const modulePath = path.resolve(__dirname, '../../src/redaction.js');
  const source = '[a]{100}'.repeat(60) + 'b';
  const script = `const { redactText } = require(${JSON.stringify(modulePath)}); try { redactText('a'.repeat(1048000), { customRules: [{ pattern: ${JSON.stringify(source)}, category: 'amplification' }] }); process.exit(2); } catch (error) { if (!/expanded-width|unsafe/.test(String(error))) process.exit(3); }`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 1000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `signal=${result.signal}`);
  assert.ok(Date.now() - started < 1000, 'adversarial validation exceeded subprocess budget');
});

test('enforces aggregate budget across rules and keeps a near-limit set responsive', () => {
  const oversized = new Array(20).fill(null).map((_, index) => ({ pattern: `[${String.fromCharCode(65 + index)}]{64}`, category: `rule-${index}` }));
  assert.throws(() => redactText('x', { customRules: oversized }), /aggregate expanded-width/i);

  const modulePath = path.resolve(__dirname, '../../src/redaction.js');
  const nearLimit = new Array(19).fill(null).map((_, index) => ({ pattern: `[${String.fromCharCode(65 + index)}]{3}`, category: `rule-${index}` }));
  nearLimit.push({ pattern: '[Z]{7}', category: 'rule-19' });
  const script = `const { redactText } = require(${JSON.stringify(modulePath)}); redactText('x'.repeat(1048000), { customRules: ${JSON.stringify(nearLimit)} });`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['-e', script], { timeout: 1000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || `signal=${result.signal}`);
  assert.ok(Date.now() - started < 1000, 'near-limit rule set exceeded subprocess budget');
});
