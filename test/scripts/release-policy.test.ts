import test from 'node:test';
import assert from 'node:assert/strict';
const { distTagForVersion, validateCycloneDx } = require('../../../scripts/release-policy');

test('dist tags never promote prereleases to latest', () => {
  assert.equal(distTagForVersion('2.0.0'), 'latest');
  assert.equal(distTagForVersion('2.0.0-alpha.1'), 'alpha');
  assert.equal(distTagForVersion('2.0.0-rc.1'), 'rc');
  assert.equal(distTagForVersion('2.0.0-rc.2'), 'rc');
  assert.throws(() => distTagForVersion('2.0.0-preview.1'), /TAG_POLICY_REJECTED/);
});

test('CycloneDX validation rejects shallow lookalikes', () => {
  assert.equal(validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [] }), false);
  assert.equal(validateCycloneDx({ bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'urn:uuid:123e4567-e89b-12d3-a456-426614174000', version: 1, metadata: { timestamp: '2026-01-01T00:00:00Z', component: { type: 'application', 'bom-ref': 'root', name: 'root', version: '1.0.0' } }, components: [] }), true);
});
