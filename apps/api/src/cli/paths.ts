import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Find the repository's db/ folder by walking up from this file (works from src/ and dist/). */
export function dbDir(): string {
  if (process.env.AKB_DB_DIR) return resolve(process.env.AKB_DB_DIR);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'db', 'migrations');
    if (existsSync(candidate)) return join(dir, 'db');
    dir = dirname(dir);
  }
  throw new Error('Could not find the db/migrations folder; set AKB_DB_DIR');
}
