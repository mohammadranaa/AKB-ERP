// Applies db/migrations/*.sql in order, once each, as the owner role.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { dbDir } from './paths.js';
import { loadDotEnv } from '../env-file.js';

loadDotEnv();

export async function migrate(url: string, log = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
    await client.query('select pg_advisory_lock(724900)');
    const done = new Map(
      (await client.query<{ name: string; sha256: string }>('select name, sha256 from schema_migrations')).rows.map((r) => [r.name, r.sha256])
    );
    const dir = join(dbDir(), 'migrations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prev = done.get(file);
      if (prev) {
        if (prev !== sha) throw new Error(`Migration ${file} was changed after it was applied. Add a new migration instead.`);
        continue;
      }
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name, sha256) values ($1,$2)', [file, sha]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (!applied.length) log('database is up to date');
  } finally {
    await client.query('select pg_advisory_unlock(724900)').catch(() => undefined);
    await client.end();
  }
  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL (the akb_owner connection)');
    process.exit(1);
  }
  migrate(url).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
