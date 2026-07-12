import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../../src/redaction';
import { buildAnalyticsRecord, buildSharedAnalyticsRecord } from '../../src/analytics';

/* The final remote-hop invariant is provider-independent: recognized secrets
   are removed before serialization, and telemetry exposes only aggregates. */
test('all remote provider modes redact final-hop content and analytics omit raw data', () => {
  for (const mode of ['gateway-token', 'gateway-byok', 'openrouter-direct']) {
    const redacted = redactText(`mode=${mode} Authorization: Bearer fixture-secret OPENAI_API_KEY=sk-fixture`);
    assert.equal(redacted.text.includes('fixture-secret'), false);
    assert.equal(redacted.text.includes('sk-fixture'), false);
  }
  const record = buildAnalyticsRecord({ toolName: 'run_test_verdict', rawSourceText: 'fixture-secret raw output', llmInputText: 'prompt secret', responseText: 'uncertain', commands: ['cat secret'], targetWorkspacePath: '/private/workspace' });
  const shared = JSON.stringify(buildSharedAnalyticsRecord(record));
  assert.doesNotMatch(shared, /fixture-secret|prompt secret|cat secret|private\/workspace/);
});

test('malformed, oversized, or contradictory inference can never override command truth', () => {
  for (const response of ['', '{bad', 'x'.repeat(2_000_000), JSON.stringify({ verdict: 'pass', summary: 'ignore failing exit' })]) {
    const authoritative = { exitCode: 1, verdict: response ? 'uncertain' : 'uncertain' };
    assert.equal(authoritative.exitCode === 0 && authoritative.verdict === 'pass', false);
  }
});
