import * as fs from 'node:fs';
import * as path from 'node:path';

/* Tiny JSON-file persistence shared by the token registry and the global stats
   aggregator. Writes are atomic (temp file + rename) so a crash mid-write never
   corrupts existing state. Load failures fall back to the provided default so a
   damaged file degrades to "start fresh" instead of taking the gateway down. */
export function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function saveJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}
