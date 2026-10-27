import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { APP_URL, OWNER_URL } from './env.js';
import { type TestApp, testApp } from './helpers.js';

describe('connection safety', () => {
  it('refuses to serve if queries would run as a role that bypasses row-level security', async () => {
    const owner = new Database(OWNER_URL);
    await expect(owner.assertRestricted()).rejects.toThrow(/bypasses row-level security/);
    await owner.close();
  });

  it('accepts the restricted application role', async () => {
    const app = new Database(APP_URL, 'Asia/Karachi', process.env.DB_SET_ROLE);
    await expect(app.assertRestricted()).resolves.toBeUndefined();
    await app.close();
  });

  it.runIf(!!process.env.DB_SET_ROLE)('with DB_SET_ROLE, the owner login is switched to the restricted role on every connection', async () => {
    const db = new Database(OWNER_URL, 'Asia/Karachi', 'akb_app');
    await expect(db.assertRestricted()).resolves.toBeUndefined();
    const raw = await db.pool.query('select current_user as u, (select count(*)::int from parties) as n');
    expect(raw.rows[0]).toEqual({ u: 'akb_app', n: 0 }); // outside a transaction: no role set, so RLS hides everything
    await db.close();
  });
});

describe('sign-in limit', () => {
  let t: TestApp;
  beforeAll(async () => { t = await testApp({ LOGIN_RATE_LIMIT: '3' }); });
  afterAll(async () => { await t.close(); });

  it('is counted per address in the database, so it holds across copies of the API', async () => {
    const attempt = (app: TestApp['app']) =>
      app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.20.30.40', payload: { username: 'nobody', password: 'wrong-password-1' } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await attempt(t.app)).statusCode);
    expect(codes).toEqual([401, 401, 401]);
    // A second, separate copy of the API sees the same count.
    const other = await testApp({ LOGIN_RATE_LIMIT: '3' });
    const r = await attempt(other.app);
    expect(r.statusCode).toBe(429);
    await other.close();
    // A different address is unaffected.
    const elsewhere = await t.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.20.30.41', payload: { username: 'nobody', password: 'x' } });
    expect(elsewhere.statusCode).toBe(401);
  });
});

describe('embedded migrations', () => {
  it('match db/migrations exactly (run node tools/embed-migrations.mjs after adding one)', async () => {
    const { EMBEDDED_MIGRATIONS } = await import('../src/cli/migrations.embedded.js');
    const { loadMigrations } = await import('../src/cli/migrate.js');
    expect(EMBEDDED_MIGRATIONS).toEqual(loadMigrations());
  });
});
