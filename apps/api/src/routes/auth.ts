import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  LOCK_MINUTES,
  MAX_FAILED_LOGINS,
  checkPassword,
  hashPassword,
  newToken,
  newTotpSecret,
  passwordProblem,
  tokenHash,
  totpUri,
  totpValid
} from '../auth.js';
import { maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { AppError, rule, unauthorized } from '../lib/errors.js';

const Login = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
  totp: z.string().max(10).optional()
});

const GENERIC = 'Username, password or authenticator code is incorrect';

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;

  app.post(
    '/login',
    { config: { rateLimit: { max: config.LOGIN_RATE_LIMIT, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = Login.parse(req.body);
      // Per-address limit kept in the database, so it holds across every running copy of the API.
      const recent = await db.tx(null, async (c) => {
        await c.query("delete from login_attempts where at < now() - interval '1 hour'");
        const n = await one<{ n: number }>(c, "select count(*)::int as n from login_attempts where ip = $1 and at > now() - interval '1 minute'", [req.ip]);
        await c.query('insert into login_attempts(ip) values ($1)', [req.ip]);
        return n.n;
      });
      if (recent >= config.LOGIN_RATE_LIMIT) {
        return reply.status(429).send({ error: 'rate_limited', message: 'Too many sign-in attempts from this connection. Wait a minute and try again.' });
      }
      const result = await db.tx(null, async (c) => {
        const u = await maybeOne<{
          id: number;
          password_hash: string;
          active: boolean;
          locked_until: string | null;
          failed_logins: number;
          totp_enabled: boolean;
          totp_secret: string | null;
          must_change_pw: boolean;
        }>(
          c,
          `select id, password_hash, active, locked_until, failed_logins, totp_enabled, totp_secret, must_change_pw
             from users where username = $1`,
          [body.username]
        );
        if (!u || !u.active) {
          await audit(c, null, 'login_failed', 'user', null, { username: body.username, reason: 'unknown_or_inactive' });
          return { ok: false as const, message: GENERIC };
        }
        if (u.locked_until && new Date(u.locked_until) > new Date()) {
          await audit(c, u.id, 'login_failed', 'user', u.id, { reason: 'locked' });
          return { ok: false as const, message: `Account locked after repeated failures. Try again in ${LOCK_MINUTES} minutes or ask an admin.` };
        }
        const pwOk = await checkPassword(u.password_hash, body.password);
        let totpOk = true;
        if (pwOk && u.totp_enabled) {
          if (!body.totp) return { ok: false as const, needTotp: true, message: 'Enter the 6-digit code from your authenticator app' };
          totpOk = await totpValid(u.totp_secret ?? '', body.totp);
        }
        if (!pwOk || !totpOk) {
          const failed = u.failed_logins + 1;
          await c.query(
            `update users set failed_logins = $2::int,
                    locked_until = case when $2::int >= $3::int then now() + make_interval(mins => $4::int) else locked_until end
              where id = $1`,
            [u.id, failed, MAX_FAILED_LOGINS, LOCK_MINUTES]
          );
          await audit(c, u.id, 'login_failed', 'user', u.id, { reason: pwOk ? 'bad_totp' : 'bad_password', failed });
          return { ok: false as const, message: GENERIC };
        }
        const needsSetup = u.must_change_pw || (config.REQUIRE_TOTP && !u.totp_enabled);
        const token = newToken();
        await c.query(
          `insert into sessions(user_id, token_hash, scope, expires_at, ip, user_agent)
           values ($1,$2,$3, now() + make_interval(hours => $4::int), $5, $6)`,
          [u.id, tokenHash(token), needsSetup ? 'limited' : 'full', config.SESSION_IDLE_HOURS, req.ip, req.headers['user-agent'] ?? null]
        );
        await c.query('update users set failed_logins = 0, locked_until = null where id = $1', [u.id]);
        await audit(c, u.id, 'login', 'user', u.id, { scope: needsSetup ? 'limited' : 'full' });
        return {
          ok: true as const,
          token,
          setupRequired: needsSetup
            ? { changePassword: u.must_change_pw, enableTotp: config.REQUIRE_TOTP && !u.totp_enabled }
            : null
        };
      });
      if (!result.ok) {
        return reply.status(401).send({ error: 'unauthorized', message: result.message, needTotp: 'needTotp' in result });
      }
      return result;
    }
  );

  app.post('/logout', async (req) => {
    const u = req.user;
    if (!u) return { ok: true };
    await db.tx(null, async (c) => {
      await c.query('update sessions set revoked_at = now() where id = $1', [u.sessionId]);
      await audit(c, u.id, 'logout', 'user', u.id);
    });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const u = req.user;
    if (!u) throw unauthorized();
    return {
      id: u.id,
      username: u.username,
      fullName: u.fullName,
      role: u.role,
      branchIds: u.branchIds,
      permissions: [...u.permissions].sort(),
      scope: u.scope,
      setupRequired:
        u.scope === 'limited'
          ? { changePassword: u.mustChangePassword, enableTotp: config.REQUIRE_TOTP && !u.totpEnabled }
          : null,
      businessDate: app.today()
    };
  });

  app.post('/password', async (req) => {
    const u = req.user;
    if (!u) throw unauthorized();
    const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
    const problem = passwordProblem(body.next);
    if (problem) throw rule(problem);
    await db.tx(null, async (c) => {
      const row = await one<{ password_hash: string }>(c, 'select password_hash from users where id = $1', [u.id]);
      if (!(await checkPassword(row.password_hash, body.current))) throw rule('Current password is incorrect');
      if (body.current === body.next) throw rule('Choose a password you have not used here before');
      await c.query('update users set password_hash = $2, must_change_pw = false where id = $1', [
        u.id,
        await hashPassword(body.next)
      ]);
      // Sign out every other session.
      await c.query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [
        u.id,
        u.sessionId
      ]);
      await upgradeIfReady(c, u.id, u.sessionId, config.REQUIRE_TOTP);
      await audit(c, u.id, 'password_changed', 'user', u.id);
    });
    return { ok: true };
  });

  // Step 1: create a secret and show it as a QR code. Step 2: confirm with a code to switch it on.
  app.post('/totp/setup', async (req) => {
    const u = req.user;
    if (!u) throw unauthorized();
    if (u.totpEnabled) throw rule('Authenticator is already set up. Ask an admin to reset it.');
    const secret = newTotpSecret();
    await db.tx(null, (c) => c.query('update users set totp_secret = $2 where id = $1', [u.id, secret]));
    return { secret, otpauthUri: totpUri(u.username, secret) };
  });

  app.post('/totp/enable', async (req) => {
    const u = req.user;
    if (!u) throw unauthorized();
    const { code } = z.object({ code: z.string() }).parse(req.body);
    await db.tx(null, async (c) => {
      const row = await one<{ totp_secret: string | null; totp_enabled: boolean }>(
        c,
        'select totp_secret, totp_enabled from users where id = $1',
        [u.id]
      );
      if (row.totp_enabled) throw rule('Authenticator is already set up');
      if (!row.totp_secret) throw rule('Start the authenticator setup first');
      if (!(await totpValid(row.totp_secret, code))) throw new AppError(422, 'rule', 'That code is not valid. Check the time on your phone and try again.');
      await c.query('update users set totp_enabled = true where id = $1', [u.id]);
      await upgradeIfReady(c, u.id, u.sessionId, config.REQUIRE_TOTP);
      await audit(c, u.id, 'totp_enabled', 'user', u.id);
    });
    return { ok: true };
  });
}

async function upgradeIfReady(
  c: import('../db.js').Db,
  userId: number,
  sessionId: string,
  requireTotp: boolean
): Promise<void> {
  const u = await one<{ must_change_pw: boolean; totp_enabled: boolean }>(
    c,
    'select must_change_pw, totp_enabled from users where id = $1',
    [userId]
  );
  if (!u.must_change_pw && (!requireTotp || u.totp_enabled)) {
    await c.query("update sessions set scope = 'full' where id = $1", [sessionId]);
  }
}
