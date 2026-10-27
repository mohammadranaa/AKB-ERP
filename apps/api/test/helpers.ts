import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/build-app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { DEMO_PASSWORD } from '../src/cli/seed.js';
import { APP_URL, OWNER_URL } from './env.js';

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  close(): Promise<void>;
}

export async function testApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const setRole = process.env.DB_SET_ROLE ? { DB_SET_ROLE: process.env.DB_SET_ROLE } : {};
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: APP_URL, REQUIRE_TOTP: 'false', LOGIN_RATE_LIMIT: '10000', ...setRole, ...overrides });
  const db = new Database(config.DATABASE_URL, config.TIMEZONE, config.DB_SET_ROLE);
  const app = await buildApp({ config, db });
  await app.ready();
  return { app, db, close: async () => { await app.close(); await db.close(); } };
}

export async function login(app: FastifyInstance, username: string, password = DEMO_PASSWORD): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (r.statusCode !== 200) throw new Error(`login ${username} failed: ${r.body}`);
  return r.json().token as string;
}

export type Call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;

export function as(app: FastifyInstance, token: string): Call {
  return async (method, url, body, headers = {}) => {
    const r = await app.inject({ method, url, payload: body as object | undefined, headers: { authorization: `Bearer ${token}`, ...headers } });
    let parsed: unknown = r.body;
    try { parsed = r.json(); } catch { /* binary */ }
    return { status: r.statusCode, body: parsed };
  };
}

/** A direct owner connection for checks the API does not expose. */
export async function ownerQuery<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export async function appQuery<T = any>(role: string, userId: number, sql: string, params: unknown[] = []): Promise<T[]> {
  const db = new Database(APP_URL, 'Asia/Karachi', process.env.DB_SET_ROLE);
  try {
    return await db.tx({ userId, role }, async (c) => (await c.query(sql, params)).rows as T[]);
  } finally {
    await db.close();
  }
}

export async function ids() {
  const q = async (sql: string) => Object.fromEntries((await ownerQuery<{ k: string; id: number }>(sql)).map((r) => [r.k, Number(r.id)]));
  return {
    users: await q('select username as k, id from users'),
    parties: await q('select code as k, id from parties'),
    products: await q('select code as k, id from products'),
    branches: await q('select code as k, id from branches'),
    accounts: await q('select code as k, id from accounts')
  };
}
