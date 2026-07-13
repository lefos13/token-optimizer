import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectCommands } from '../../src/detector';

function tempWorkspace(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'to-detector-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('a pyproject.toml-only project (Poetry/uv/hatch/PEP 621) is detected as Python', async () => {
  const workspace = tempWorkspace({ 'pyproject.toml': '[project]\nname = "fixture"\n' });
  assert.deepEqual(await detectCommands(workspace), ['pytest']);
});

test('a pyproject.toml project with manage.py still prefers Django test runner', async () => {
  const workspace = tempWorkspace({ 'pyproject.toml': '[project]\nname = "fixture"\n', 'manage.py': '' });
  assert.deepEqual(await detectCommands(workspace), ['python manage.py test']);
});

test('a project with none of the recognized markers detects nothing', async () => {
  const workspace = tempWorkspace({ 'notes.txt': 'hello' });
  assert.deepEqual(await detectCommands(workspace), []);
});
