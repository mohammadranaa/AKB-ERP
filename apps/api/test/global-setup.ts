// Rebuilds the test database from scratch before the suite runs.
import pg from 'pg';
import { migrate } from '../src/cli/migrate.js';
import { seed } from '../src/cli/seed.js';
import { OWNER_URL, SEED_DATE } from './env.js';

export default async function setup() {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    const db = (await c.query('select current_database() as d')).rows[0].d as string;
    if (!db.endsWith('_test')) throw new Error(`Refusing to wipe "${db}": the test database name must end in _test`);
    await c.query('drop schema public cascade');
    await c.query('create schema public');
    await c.query('revoke create on schema public from public');
  } finally {
    await c.end();
  }
  await migrate(OWNER_URL, () => undefined, { ensureAppRole: !!process.env.DB_SET_ROLE });
  await seed(OWNER_URL, { date: SEED_DATE, log: () => undefined });
}
