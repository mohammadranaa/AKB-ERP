import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { businessToday, type Config } from './config.js';
import { Database, type Db, maybeOne } from './db.js';
import { bearer, loadSession } from './auth.js';
import { AppError, fromDatabase, unauthorized } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { mastersRoutes } from './routes/masters.js';
import { ledgerRoutes } from './routes/ledger.js';
import { stockRoutes } from './routes/stock.js';
import { salesRoutes } from './routes/sales.js';
import { receiptRoutes } from './routes/receipts.js';
import { dayRoutes } from './routes/days.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { adminRoutes } from './routes/admin.js';
import { approvalRoutes } from './routes/approvals.js';
import { trialRoutes } from './routes/trial.js';

export interface AppDeps {
  config: Config;
  db: Database;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** Run a write in one transaction as the signed-in user, honouring an Idempotency-Key header. */
    mutate<T>(req: FastifyRequest, route: string, fn: (c: Db) => Promise<T>): Promise<T>;
    /** Run a read in one transaction as the signed-in user (row-level security applies). */
    read<T>(req: FastifyRequest, fn: (c: Db) => Promise<T>): Promise<T>;
    today(): string;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.authorization'] },
    trustProxy: deps.config.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024
  });

  app.decorate('deps', deps);
  app.decorate('today', () => businessToday(deps.config.TIMEZONE));

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: deps.config.CORS_ORIGINS.split(',').map((s) => s.trim()),
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['Content-Disposition']
  });
  await app.register(rateLimit, { global: false });

  // Resolve the session on every request; routes decide whether it is required.
  app.addHook('onRequest', async (req) => {
    const token = bearer(req);
    if (!token) return;
    const user = await deps.db.tx(null, (c) => loadSession(c, token, deps.config.SESSION_IDLE_HOURS));
    if (!user) throw unauthorized('Your session has expired. Please sign in again.');
    req.user = user;
  });

  app.decorate('read', async <T>(req: FastifyRequest, fn: (c: Db) => Promise<T>) => {
    if (!req.user) throw unauthorized();
    return deps.db.tx({ userId: req.user.id, role: req.user.role }, fn);
  });

  app.decorate('mutate', async <T>(req: FastifyRequest, route: string, fn: (c: Db) => Promise<T>) => {
    if (!req.user) throw unauthorized();
    const ctx = { userId: req.user.id, role: req.user.role };
    const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (!key) return deps.db.tx(ctx, fn);
    if (key.length > 200) throw new AppError(400, 'bad_request', 'Idempotency-Key is too long');
    const userId = req.user.id;
    const stored = async () =>
      deps.db.tx(ctx, (c) =>
        maybeOne<{ response: T; route: string }>(
          c,
          'select response, route from idempotency_keys where key = $1 and user_id = $2',
          [key, userId]
        )
      );
    const prior = await stored();
    if (prior) {
      if (prior.route !== route) throw new AppError(409, 'conflict', 'Idempotency-Key was used for a different action');
      return prior.response;
    }
    try {
      return await deps.db.tx(ctx, async (c) => {
        const result = await fn(c);
        await c.query(
          'insert into idempotency_keys(key, user_id, route, status_code, response) values ($1,$2,$3,200,$4)',
          [key, userId, route, JSON.stringify(result ?? null)]
        );
        return result;
      });
    } catch (err) {
      // A concurrent duplicate committed first: return its result.
      if ((err as { constraint?: string }).constraint === 'idempotency_keys_pkey') {
        const again = await stored();
        if (again) return again.response;
      }
      throw err;
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'Some fields are missing or invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      });
    }
    const appErr = err instanceof AppError ? err : fromDatabase(err);
    if (appErr) {
      return reply.status(appErr.status).send({ error: appErr.code, message: appErr.message, details: appErr.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    }
    req.log.error(err);
    if (process.env.AKB_DEBUG) console.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Something went wrong. It has been logged.' });
  });

  app.get('/health', async () => ({ ok: true }));
  // Public: lets the sign-in screen show the practice-system banner before anyone signs in.
  app.get('/api/info', async () => ({ trial: deps.config.TRIAL_MODE }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(mastersRoutes, { prefix: '/api' });
  await app.register(ledgerRoutes, { prefix: '/api/ledger' });
  await app.register(stockRoutes, { prefix: '/api/stock' });
  await app.register(salesRoutes, { prefix: '/api' });
  await app.register(receiptRoutes, { prefix: '/api' });
  await app.register(dayRoutes, { prefix: '/api/days' });
  await app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  await app.register(approvalRoutes, { prefix: '/api/approvals' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(trialRoutes, { prefix: '/api/trial' });

  return app;
}
