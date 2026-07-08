import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../gateway/src/config';

const base = { OPENROUTER_API_KEY: 'sk-real', PROXY_TOKENS: 'tok1, tok2' };

test('loadConfig requires the OpenRouter key', () => {
  assert.throws(() => loadConfig({ PROXY_TOKENS: 'tok1' } as any), /OPENROUTER_API_KEY/);
});

test('loadConfig requires at least one proxy token', () => {
  assert.throws(() => loadConfig({ OPENROUTER_API_KEY: 'sk-real' } as any), /PROXY_TOKENS/);
});

test('loadConfig parses tokens, defaults, and per-task models', () => {
  const c = loadConfig({ ...base, DEFAULT_MODEL: 'd/model', MODEL_VERDICT: 'v/model' } as any);
  assert.deepEqual(c.tokens, ['tok1', 'tok2']);
  assert.equal(c.defaultModel, 'd/model');
  assert.equal(c.taskModels.verdict, 'v/model');
  assert.equal(c.port, 8787);
  assert.equal(c.openRouterUrl, 'https://openrouter.ai/api/v1');
});
