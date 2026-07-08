import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../../gateway/src/model-map';
import { loadConfig } from '../../gateway/src/config';

const config = loadConfig({
  OPENROUTER_API_KEY: 'sk', PROXY_TOKENS: 't',
  DEFAULT_MODEL: 'default/model', MODEL_VERDICT: 'verdict/model'
} as any);

test('resolveModel uses the per-task model when configured', () => {
  assert.equal(resolveModel('verdict', config), 'verdict/model');
});

test('resolveModel falls back to default for unmapped/unknown/missing task', () => {
  assert.equal(resolveModel('triage', config), 'default/model');
  assert.equal(resolveModel('bogus', config), 'default/model');
  assert.equal(resolveModel(undefined, config), 'default/model');
});
