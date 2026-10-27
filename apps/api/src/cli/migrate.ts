// Applies db/migrations/*.sql in order, once each, as the owner role.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { dbDir } from './paths.js';
import { EMBEDDED_MIGRATIONS } from './migrations.embedded.js';
import { loadDotEnv } from '../env-file.js';

loadDotEnv();

/**
 * On hosted Postgres without a superuser (Neon), create the restricted application role here.
 * It cannot log in; the API switches to it inside every transaction (DB_SET_ROLE=akb_app).
 */
async function ensureAppRole(client: pg.Client, log: (s: string) => void) {
  const exists = (await client.query("select 1 from pg_roles where rolname = 'akb_app'")).rowCount;
  if (!exists) {
    await client.query('create role akb_app nologin nosuperuser nocreatedb nocreaterole nobypassrls');
    log('created role akb_app');
  }
  // The owner must be able to SET ROLE akb_app. (On PostgreSQL 16+ creating a role grants ADMIN but not SET.)
  let canSet = true;
  try {
    await client.query('set role akb_app');
    await client.query('reset role');
  } catch {
    canSet = false;
  }
  if (!canSet) {
    await client.query('grant akb_app to current_user');
    log('granted akb_app to the owner role (for SET ROLE)');
  }
}

/** Migration files from db/migrations, or the copy embedded in the code when bundled (Vercel). */
export function loadMigrations(): [string, string][] {
  let dir: string | null = null;
  try {
    dir = join(dbDir(), 'migrations');
  } catch {
    dir = null;
  }
  if (!dir) return EMBEDDED_MIGRATIONS;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => [f, readFileSync(join(dir!, f), 'utf8')] as [string, string]);
}

/** The owner connection: MIGRATION_DATABASE_URL, or Neon's direct (unpooled) URL on Vercel. */
export function ownerUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.MIGRATION_DATABASE_URL || env.DATABASE_URL_UNPOOLED || (env.DB_SET_ROLE ? env.DATABASE_URL : undefined);
}

export async function migrate(url: string, log = console.log, opts: { ensureAppRole?: boolean } = {}): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    if (opts.ensureAppRole ?? process.env.AKB_ENSURE_APP_ROLE === 'true') await ensureAppRole(client, log);
    await client.query(`create table if not exists schema_migrations (
      name text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
    await client.query('select pg_advisory_lock(724900)');
    const done = new Map(
      (await client.query<{ name: string; sha256: string }>('select name, sha256 from schema_migrations')).rows.map((r) => [r.name, r.sha256])
    );
    for (const [file, sql] of loadMigrations()) {
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
  const url = ownerUrl();
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL (the akb_owner connection)');
    process.exit(1);
  }
  migrate(url).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
