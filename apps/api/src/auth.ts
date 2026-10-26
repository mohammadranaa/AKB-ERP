import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.js';
import { many, maybeOne } from './db.js';
import { forbidden, unauthorized } from './lib/errors.js';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: string;
  branchIds: number[] | null;
  permissions: Set<string>;
  sessionId: string;
  scope: 'full' | 'limited';
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export const hashPassword = (pw: string) => argon2.hash(pw, { type: argon2.argon2id });
export const checkPassword = (hash: string, pw: string) => argon2.verify(hash, pw).catch(() => false);

export function passwordProblem(pw: string): string | null {
  if (pw.length < 12) return 'Password must be at least 12 characters';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) {
    return 'Password must include upper-case and lower-case letters and a number';
  }
  return null;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export const newTotpSecret = () => generateSecret();
export const totpUri = (username: string, secret: string) =>
  generateURI({ issuer: 'AKB ERP', label: username, secret });
export async function totpValid(secret: string, token: string): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;
  const r = await verifyTotp({ secret, token, epochTolerance: 30 }).catch(() => ({ valid: false }));
  return r.valid;
}

/** Load the session behind a bearer token, extend its idle timeout, and return the user. */
export async function loadSession(c: Db, token: string, idleHours: number): Promise<AuthUser | null> {
  const row = await maybeOne<{
    session_id: string;
    scope: 'full' | 'limited';
    user_id: number;
    username: string;
    full_name: string;
    role_code: string;
    branch_ids: number[] | null;
    must_change_pw: boolean;
    totp_enabled: boolean;
  }>(
    c,
    `select s.id as session_id, s.scope, u.id as user_id, u.username, u.full_name, u.role_code, u.branch_ids,
            u.must_change_pw, u.totp_enabled
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.active`,
    [tokenHash(token)]
  );
  if (!row) return null;
  await c.query(
    `update sessions set last_seen_at = now(), expires_at = now() + make_interval(hours => $2::int)
      where id = $1 and last_seen_at < now() - interval '1 minute'`,
    [row.session_id, idleHours]
  );
  const perms = await many<{ permission_code: string }>(
    c,
    'select permission_code from role_permissions where role_code = $1',
    [row.role_code]
  );
  return {
    id: row.user_id,
    username: row.username,
    fullName: row.full_name,
    role: row.role_code,
    branchIds: row.branch_ids,
    permissions: new Set(perms.map((p) => p.permission_code)),
    sessionId: row.session_id,
    scope: row.scope,
    mustChangePassword: row.must_change_pw,
    totpEnabled: row.totp_enabled
  };
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/** Route guard: signed in with a full session and holding at least one of the permissions. */
export function requirePerm(...anyOf: string[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const u = req.user;
    if (!u) throw unauthorized();
    if (u.scope !== 'full') throw forbidden('Finish setting up your account (password and authenticator) first');
    if (anyOf.length && !anyOf.some((p) => u.permissions.has(p))) throw forbidden();
  };
}

export const can = (u: AuthUser | undefined, perm: string) => !!u && u.permissions.has(perm);
