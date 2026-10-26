import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD } from '../src/cli/seed.js';
import { as, login, ownerQuery, testApp, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(async () => t.close());

describe('sign in', () => {
  it('rejects a wrong password with a generic message and locks after five failures', async () => {
    await ownerQuery("update users set failed_logins = 0, locked_until = null where username = 'auditor'");
    for (let i = 0; i < 5; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'auditor', password: 'nope' } });
      expect(r.statusCode).toBe(401);
      expect(r.json().message).toMatch(/incorrect/);
    }
    const locked = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'auditor', password: DEMO_PASSWORD } });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().message).toMatch(/locked/);
    await ownerQuery("update users set failed_logins = 0, locked_until = null where username = 'auditor'");
  });

  it('does not reveal whether a username exists', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'x' } });
    expect(r.statusCode).toBe(401);
    expect(r.json().message).toBe('Username, password or authenticator code is incorrect');
  });

  it('stores only a hash of the session token, and logout revokes it', async () => {
    const token = await login(t.app, 'accounts');
    const rows = await ownerQuery('select token_hash from sessions where token_hash = encode(digest($1, $2), $3)', [token, 'sha256', 'hex']);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(await ownerQuery('select * from sessions'))).not.toContain(token);
    const call = as(t.app, token);
    expect((await call('GET', '/api/auth/me')).status).toBe(200);
    await call('POST', '/api/auth/logout');
    expect((await call('GET', '/api/auth/me')).status).toBe(401);
  });
});

describe('authenticator (TOTP) and first sign-in', () => {
  it('forces a password change and authenticator setup before anything else works', async () => {
    const strict = await testApp({ REQUIRE_TOTP: 'true' });
    try {
      // The admin creates the user (signed in on the normal app; admins also need 2FA on a strict one).
      const owner = as(t.app, await login(t.app, 'admin'));
      const created = await owner('POST', '/api/admin/users', { username: 'newstaff', fullName: 'New Staff', role: 'accounts' });
      expect(created.status).toBe(200);
      const temp = created.body.temporaryPassword as string;

      const first = await strict.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'newstaff', password: temp } });
      expect(first.json().setupRequired).toEqual({ changePassword: true, enableTotp: true });
      const me = as(strict.app, first.json().token);
      // Limited session: business endpoints are refused.
      expect((await me('GET', '/api/receipts')).status).toBe(403);

      expect((await me('POST', '/api/auth/password', { current: temp, next: 'short' })).status).toBe(422);
      expect((await me('POST', '/api/auth/password', { current: temp, next: 'A-much-better-pass-1' })).status).toBe(200);
      expect((await me('GET', '/api/receipts')).status).toBe(403); // still needs TOTP

      const setup = await me('POST', '/api/auth/totp/setup');
      expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect((await me('POST', '/api/auth/totp/enable', { code: '000000' })).status).toBe(422);
      const code = await generate({ secret: setup.body.secret });
      expect((await me('POST', '/api/auth/totp/enable', { code })).status).toBe(200);
      expect((await me('GET', '/api/receipts')).status).toBe(200);

      // From now on a code is required to sign in.
      const noCode = await strict.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'newstaff', password: 'A-much-better-pass-1' } });
      expect(noCode.statusCode).toBe(401);
      expect(noCode.json().needTotp).toBe(true);
      const withCode = await strict.app.inject({
        method: 'POST', url: '/api/auth/login',
        payload: { username: 'newstaff', password: 'A-much-better-pass-1', totp: await generate({ secret: setup.body.secret }) }
      });
      expect(withCode.statusCode).toBe(200);
      expect(withCode.json().setupRequired).toBeNull();
    } finally {
      await strict.close();
    }
  });
});

describe('permissions', () => {
  it('distribution sees stock and OGs but no prices or balances', async () => {
    const dist = as(t.app, await login(t.app, 'dist'));
    const ogs = await dist('GET', '/api/ogs');
    expect(ogs.status).toBe(200);
    for (const o of ogs.body) expect(o.total_value).toBeUndefined();
    const parties = await dist('GET', '/api/parties?kind=customer');
    for (const p of parties.body) {
      expect(p.credit_limit).toBeUndefined();
      expect(p.balance).toBeUndefined();
    }
    expect((await dist('GET', '/api/receipts')).status).toBe(403);
    expect((await dist('GET', '/api/ledger/trial-balance')).status).toBe(403);
    expect((await dist('GET', '/api/dashboard')).status).toBe(403);
  });

  it('a sales rep cannot open another rep\'s customer', async () => {
    const s1 = as(t.app, await login(t.app, 'sales1'));
    const other = (await ownerQuery("select id from parties where code = 'C005'"))[0].id;
    expect((await s1('GET', `/api/parties/${other}`)).status).toBe(404);
    const list = await s1('GET', '/api/parties?kind=customer');
    expect(list.body.map((p: { code: string }) => p.code).sort()).toEqual(['C001', 'C002', 'C003', 'C004']);
  });

  it('admin cannot post financial entries; auditor is read-only', async () => {
    const admin = as(t.app, await login(t.app, 'admin'));
    expect((await admin('POST', '/api/receipts', {})).status).toBe(403);
    const auditor = as(t.app, await login(t.app, 'auditor'));
    expect((await auditor('GET', '/api/ledger/trial-balance')).status).toBe(200);
    expect((await auditor('POST', '/api/ogs', {})).status).toBe(403);
  });
});
