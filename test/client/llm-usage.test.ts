import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLLMUsage, combineLLMUsage, getLLMUsage } from '../../src/llm';

/* Auto-triage combines primary and follow-up LLM usage on the same verdict
   object, so the private analytics metadata must be safely replaceable. */
test('usage metadata can be replaced after combining auto-triage usage', () => {
  const verdict = {};
  const primary = { promptTokens: 10, completionTokens: 5, totalTokens: 15, source: 'api' as const };
  const secondary = { promptTokens: 4, completionTokens: 3, totalTokens: 7, source: 'api' as const };

  attachLLMUsage(verdict, primary);
  attachLLMUsage(verdict, combineLLMUsage(getLLMUsage(verdict), secondary));

  assert.deepEqual(getLLMUsage(verdict), {
    promptTokens: 14,
    completionTokens: 8,
    totalTokens: 22,
    source: 'api'
  });
});
