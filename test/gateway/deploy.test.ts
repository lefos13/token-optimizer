import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');

test('PM2 deployment ships and installs gateway runtime dependencies', () => {
  const deployScript = fs.readFileSync(path.join(root, 'gateway', 'deploy', 'deploy-pm2.sh'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'gateway', 'package.json'), 'utf8')) as any;

  assert.equal(packageJson.private, true);
  assert.ok(packageJson.dependencies.nodemailer);
  assert.ok(fs.existsSync(path.join(root, 'gateway', 'package-lock.json')));
  assert.match(deployScript, /gateway\/package\.json/);
  assert.match(deployScript, /gateway\/package-lock\.json/);
  assert.match(deployScript, /sudo env "PATH=\$PATH" npm ci --omit=dev/);
  assert.match(deployScript, /npm ci --omit=dev/);
});
