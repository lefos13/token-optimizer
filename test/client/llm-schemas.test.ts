import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLLMResponse } from '../../src/llm-schemas';

const failure = { file: 'src/app.ts', reason: 'broken', suggestedFix: null };
const pointer = (i: number) => ({ file: `src/file-${i}.ts`, lineRange: '1-3', why: 'relevant', confidence: 0.8 });

test('rejects pass verdict with non-empty failures', () => {
  const parsed = parseLLMResponse('verdict', JSON.stringify({
    verdict: 'pass', confidence: 0.9, summary: 'ok', likelyRelevantToRecentChanges: false, failures: [failure], needsRawLogs: false,
  }));
  assert.equal(parsed.success, false);
});

test('rejects oversized scout arrays', () => {
  const content = JSON.stringify({ pointers: Array.from({ length: 101 }, (_, i) => pointer(i)), suggestedNextSearches: [], summary: 'many', needsDeeperLook: false });
  assert.equal(parseLLMResponse('scout', content).success, false);
});

test('accepts valid responses for every task type', () => {
  const fixtures = {
    verdict: { verdict: 'fail', confidence: 0.9, summary: 'failed', likelyRelevantToRecentChanges: true, failures: [failure], needsRawLogs: false },
    triage: { verdict: 'uncertain', confidence: 0.5, summary: 'unclear', likelyRelevantToRecentChanges: false, failures: [], needsRawLogs: true },
    review: { hasIssues: true, issues: [{ file: 'src/app.ts', line: 4, severity: 'warning', description: 'style', suggestedFix: 'fix' }], summary: 'minor issue' },
    digest: { summary: 'done', keyFindings: ['one'], digest: 'details', needsRawLogs: false },
    scout: { pointers: [pointer(1)], suggestedNextSearches: ['search'], summary: 'found', needsDeeperLook: false },
    query: { answer: 'yes', relevantExcerpt: '1: yes', lineRange: '1-1' },
  } as const;
  for (const [task, content] of Object.entries(fixtures)) {
    const parsed = parseLLMResponse(task as keyof typeof fixtures, JSON.stringify(content));
    assert.equal(parsed.success, true, task);
  }
});

test('rejects contradictory review and malformed nested failure data', () => {
  assert.equal(parseLLMResponse('review', JSON.stringify({ hasIssues: false, issues: [{ file: 'a', severity: 'error', description: 'bad', suggestedFix: null }], summary: 'none' })).success, false);
  assert.equal(parseLLMResponse('verdict', JSON.stringify({ verdict: 'fail', confidence: 0.8, summary: 'bad', likelyRelevantToRecentChanges: false, failures: [{ file: 7, reason: 'bad', suggestedFix: null }], needsRawLogs: false })).success, false);
});

test('rejects oversized strings and unknown fields', () => {
  assert.equal(parseLLMResponse('query', JSON.stringify({ answer: 'x'.repeat(4001), relevantExcerpt: '', lineRange: '' })).success, false);
  assert.equal(parseLLMResponse('digest', JSON.stringify({ summary: 'ok', keyFindings: [], digest: '', needsRawLogs: false, extra: true })).success, false);
});
