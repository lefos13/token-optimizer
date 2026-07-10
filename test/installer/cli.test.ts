import test from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cli = require('../../../packages/installer/bin/token-optimizer.js');

function readlineWith(...answers: string[]) {
  return {
    question(_prompt: string, done: (answer: string) => void) {
      done(answers.shift() || '');
    }
  };
}

test('interactive BYOK setup asks for one optional model', async () => {
  const options = await cli.resolveProviderOptions(
    { provider: 'byok' },
    readlineWith('sk-or-v1-mykey', 'openai/gpt-4o-mini')
  );
  assert.equal(options.byokKey, 'sk-or-v1-mykey');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('--byok-key and --byok-model configure BYOK without prompting', async () => {
  const args = cli.parseArgs([
    '--byok-key', 'sk-or-v1-mykey',
    '--byok-model', 'openai/gpt-4o-mini'
  ]);
  const options = await cli.resolveProviderOptions(args, readlineWith());
  assert.equal(options.provider, 'byok');
  assert.equal(options.byokModel, 'openai/gpt-4o-mini');
});

test('a BYOK key flag without a model remains non-interactive and uses gateway defaults', async () => {
  const options = await cli.resolveProviderOptions(
    { byokKey: 'sk-or-v1-mykey' },
    readlineWith('must-not-be-consumed')
  );
  assert.equal(options.byokModel, '');
});
