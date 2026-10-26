import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Load the repository's .env file, if there is one, without overriding variables that are already set.
 * Docker passes its settings directly, so this only matters when running on the laptop with pnpm.
 */
export function loadDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) return;
      const vars = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
      return;
    }
    dir = dirname(dir);
  }
}
