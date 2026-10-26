import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword, requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound } from '../lib/errors.js';

const UserInput = z.object({
  username: z.string().trim().min(3).max(60).regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dot, dash and underscore only'),
  fullName: z.string().trim().min(2).max(120),
  role: z.string(),
  branchIds: z.array(z.number().int()).nullish(),
  active: z.boolean().default(true)
});

/** A readable one-time password the admin passes on; the user must change it at first sign-in. */
function tempPassword(): string {
  const raw = randomBytes(9).toString('base64url');
  return `Akb-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}9a`;
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/users', { preHandler: requirePerm('users.manage') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select u.id, u.username, u.full_name, u.role_code, r.name as role_name, u.branch_ids, u.active, u.totp_enabled,
                u.must_change_pw, u.locked_until, u.created_at,
                (select max(last_seen_at) from sessions s where s.user_id = u.id) as last_seen
           from users u join roles r on r.code = u.role_code order by u.full_name`
      )
    )
  );

  app.get('/roles', { preHandler: requirePerm('users.manage') }, async (req) =>
    app.read(req, async (c) => {
      const roles = await many(c, 'select * from roles order by name');
      const perms = await many(c, 'select * from permissions order by code');
      const grants = await many(c, 'select * from role_permissions');
      return { roles, permissions: perms, grants };
    })
  );

  app.post('/users', { preHandler: requirePerm('users.manage') }, async (req) => {
    const b = UserInput.parse(req.body);
    const pw = tempPassword();
    const hash = await hashPassword(pw);
    return app.mutate(req, 'users.create', async (c) => {
      const r = await one<{ id: number }>(
        c,
        `insert into users(username, full_name, role_code, branch_ids, active, password_hash, must_change_pw, created_by)
         values ($1,$2,$3,$4,$5,$6,true,$7) returning id`,
        [b.username, b.fullName, b.role, b.branchIds ?? null, b.active, hash, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'user', r.id, { username: b.username, role: b.role });
      return { id: r.id, temporaryPassword: pw };
    });
  });

  app.put('/users/:id', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = UserInput.parse(req.body);
    if (id === req.user!.id && (!b.active || b.role !== req.user!.role)) throw forbidden('You cannot change your own role or deactivate yourself');
    return app.mutate(req, 'users.update', async (c) => {
      const before = await maybeOne(c, 'select username, full_name, role_code, branch_ids, active from users where id = $1', [id]);
      if (!before) throw notFound('User');
      await c.query('update users set username=$2, full_name=$3, role_code=$4, branch_ids=$5, active=$6 where id=$1', [
        id, b.username, b.fullName, b.role, b.branchIds ?? null, b.active
      ]);
      if (!b.active) await c.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(c, req.user!.id, 'update', 'user', id, { before, after: b });
      return { id };
    });
  });

  // Reset password and/or authenticator; always signs the user out everywhere.
  app.post('/users/:id/reset', { preHandler: requirePerm('users.manage') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ password: z.boolean().default(true), totp: z.boolean().default(false) }).parse(req.body ?? {});
    const pw = b.password ? tempPassword() : null;
    const hash = pw ? await hashPassword(pw) : null;
    return app.mutate(req, 'users.reset', async (c) => {
      const u = await maybeOne(c, 'select id from users where id = $1', [id]);
      if (!u) throw notFound('User');
      if (hash) await c.query('update users set password_hash=$2, must_change_pw=true, failed_logins=0, locked_until=null where id=$1', [id, hash]);
      if (b.totp) await c.query('update users set totp_enabled=false, totp_secret=null where id=$1', [id]);
      await c.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [id]);
      await audit(c, req.user!.id, 'reset_access', 'user', id, { password: b.password, totp: b.totp });
      return { id, temporaryPassword: pw };
    });
  });

  app.get('/audit', { preHandler: requirePerm('audit.read') }, async (req) => {
    const q = z.object({ entity: z.string().optional(), entityId: z.string().optional(), limit: z.coerce.number().int().max(1000).default(200) }).parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `select l.id, l.at, l.action, l.entity, l.entity_id, l.detail, u.full_name as user_name
           from audit_log l left join users u on u.id = l.user_id
          where ($1::text is null or l.entity = $1) and ($2::text is null or l.entity_id = $2)
          order by l.id desc limit $3`,
        [q.entity ?? null, q.entityId ?? null, q.limit]
      )
    );
  });

  app.get('/audit/verify', { preHandler: requirePerm('audit.read') }, async (req) =>
    app.read(req, async (c) => {
      const r = await one<{ broken: string | null; total: string }>(c, 'select audit_log_verify() as broken, (select count(*) from audit_log) as total');
      return { intact: r.broken === null, firstBrokenId: r.broken, entries: Number(r.total) };
    })
  );
}
