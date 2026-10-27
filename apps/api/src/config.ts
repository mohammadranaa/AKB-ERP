import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4000),
  // The API connects as akb_app (no ownership, subject to row-level security).
  DATABASE_URL: z.string().min(1),
  // Migrations run as akb_owner.
  MIGRATION_DATABASE_URL: z.string().optional(),
  // Require an authenticator-app code for every login. Always true in production.
  REQUIRE_TOTP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(8),
  // Sign-in attempts allowed per IP address per minute.
  LOGIN_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  TIMEZONE: z.string().default('Asia/Karachi'),
  FIRM_CODE: z.string().default('AKB'),
  // Neon/Vercel: the API connects with the database owner login and switches to this restricted
  // role at the start of every transaction, so row-level security still applies (e.g. akb_app).
  DB_SET_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).optional(),
  // Practice system for staff to try with made-up data: shows a trial banner everywhere and allows
  // the owner to reset to demo data. Never set for a system holding real data.
  TRIAL_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // true only when the API sits behind our own web server (Docker setup), so client IPs come from X-Forwarded-For.
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && !cfg.REQUIRE_TOTP && !cfg.TRIAL_MODE) {
    throw new Error('REQUIRE_TOTP cannot be false in production (only a TRIAL_MODE practice system may switch it off)');
  }
  return cfg;
}

/** Today's date in the business time zone, as YYYY-MM-DD. */
export function businessToday(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date()
  );
}
