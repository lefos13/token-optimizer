import * as fs from 'fs';
import * as path from 'path';

export async function detectCommands(workspacePath: string): Promise<string[]> {
  const commands: string[] = [];

  const checkFile = (file: string) => {
    return fs.existsSync(path.join(workspacePath, file));
  };

  // Node.js project detection
  if (checkFile('package.json')) {
    try {
      const packageJsonContent = fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf8');
      const pkg = JSON.parse(packageJsonContent);
      const scripts = pkg.scripts || {};

      // Order of run preference
      if (scripts.build) {
        commands.push('npm run build');
      }
      if (scripts.typecheck) {
        commands.push('npm run typecheck');
      }
      if (scripts.lint) {
        commands.push('npm run lint');
      }
      if (scripts.test) {
        commands.push('npm test');
      } else {
        // Fallback if package.json exists but no test script is explicitly defined
        commands.push('npm test');
      }
    } catch (e) {
      // In case package.json is invalid JSON or unreadable
      commands.push('npm test');
    }
    return commands;
  }

  // Rust project detection
  if (checkFile('Cargo.toml')) {
    commands.push('cargo check');
    commands.push('cargo test');
    return commands;
  }

  // Go project detection
  if (checkFile('go.mod')) {
    commands.push('go build ./...');
    commands.push('go test ./...');
    return commands;
  }

  // Python project detection
  if (checkFile('pytest.ini') || checkFile('conftest.py') || checkFile('requirements.txt') || checkFile('Pipfile') || checkFile('pyproject.toml')) {
    // If pytest is typical or manage.py is present for Django, etc.
    if (checkFile('manage.py')) {
      commands.push('python manage.py test');
    } else {
      commands.push('pytest');
    }
    return commands;
  }

  // Generic fallback if nothing matches
  return [];
}

/* Explicit-command authorization accepts npm's equivalent test spelling
   without adding a second command to the auto-detected execution list. */
export async function detectTrustedCommands(workspacePath: string): Promise<string[]> {
  const commands = await detectCommands(workspacePath);
  return commands.includes('npm test') ? [...commands, 'npm run test'] : commands;
}
