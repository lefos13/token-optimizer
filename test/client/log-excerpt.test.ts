import test from 'node:test';
import assert from 'node:assert/strict';
import { LogExcerptCollector } from '../../src/log-excerpt';

test('collector bounds retained text while counting a large stream', () => {
  const collector = new LogExcerptCollector({ headLines: 100, tailLines: 200, markerWindows: 5 });
  for (let i = 0; i < 1_000_000; i += 1) collector.push('stdout', `line ${i}\n`);
  const result = collector.finish();
  assert.equal(result.totalLines, 1_000_000);
  assert.ok(result.text.length < 200_000);
  assert.equal(result.truncated, true);
});

test('partial lines and chunk boundaries produce deterministic output', () => {
  const whole = new LogExcerptCollector({ headLines: 2, tailLines: 2, markerWindows: 1 });
  whole.push('stdout', 'one\ntwo\nthree error\nfour\n');
  const split = new LogExcerptCollector({ headLines: 2, tailLines: 2, markerWindows: 1 });
  for (const chunk of ['one\n', 'tw', 'o\nthree er', 'ror\nfour\n']) split.push('stdout', chunk);
  assert.deepEqual(split.finish(), whole.finish());
});

test('marker windows retain context from omitted middle', () => {
  const collector = new LogExcerptCollector({ headLines: 1, tailLines: 1, markerWindows: 1, markerContextLines: 1 });
  collector.push('stderr', 'head\nbefore\nERROR happened\nafter\ntail\n');
  const result = collector.finish();
  assert.match(result.text, /before\nERROR happened\nafter/);
});

test('long unbroken lines are capped while counters remain exact', () => {
  const collector = new LogExcerptCollector({ maxLineCharacters: 32 });
  const line = 'x'.repeat(100_000);
  collector.push('stdout', line);
  const result = collector.finish();
  assert.equal(result.totalCharacters, line.length);
  assert.equal(result.totalBytes, Buffer.byteLength(line));
  assert.equal(result.totalLines, 1);
  assert.equal(result.text.length, 32);
  assert.equal(result.truncated, true);
});

test('split UTF-8 characters decode once and retain raw byte counts', () => {
  const collector = new LogExcerptCollector();
  const euro = Buffer.from('€\n', 'utf8');
  collector.push('stdout', euro.subarray(0, 1));
  collector.push('stdout', euro.subarray(1, 2));
  collector.push('stdout', euro.subarray(2));
  const result = collector.finish();
  assert.equal(result.text, '€');
  assert.equal(result.totalCharacters, 2);
  assert.equal(result.totalChars, 2);
  assert.equal(result.totalBytes, euro.length);
  assert.equal(result.totalLines, 1);
});
