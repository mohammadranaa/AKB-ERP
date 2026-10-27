// Practice ("trial") system helpers: made-up data only, never real company data.
//   trial init   run on every deploy: apply migrations; on a trial system, load demo data if empty
//   trial reset  wipe everything and start again from demo data (also available to the owner in the app)
import pg from 'pg';
import { loadDotEnv } from '../env-file.js';
import { migrate, ownerUrl } from './migrate.js';
import { seed } from './seed.js';

loadDotEnv();

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TIMEZONE || 'Asia/Karachi' }).format(new Date());

function requireTrial() {
  if (process.env.TRIAL_MODE !== 'true') throw new Error('Refusing: TRIAL_MODE is not true. These commands are only for a practice system with made-up data.');
}

export async function trialInit(url: string, log = console.log) {
  await migrate(url, log, { ensureAppRole: process.env.AKB_ENSURE_APP_ROLE === 'true' || process.env.TRIAL_MODE === 'true' });
  if (process.env.TRIAL_MODE !== 'true') return;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const n = (await c.query('select count(*)::int as n from users')).rows[0].n as number;
    if (n > 0) {
      log(`trial data present (${n} users); leaving it`);
      return;
    }
  } finally {
    await c.end();
  }
  await seed(url, { date: today(), log, password: process.env.TRIAL_PASSWORD || undefined });
}

/** Drop every table and start again from demo data. */
export async function trialReset(url: string, log = console.log) {
  requireTrial();
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('drop schema public cascade');
    await c.query('create schema public');
    await c.query('revoke create on schema public from public');
  } finally {
    await c.end();
  }
  log('trial data wiped');
  await trialInit(url, log);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const url = ownerUrl();
  const run = async () => {
    if (!url) throw new Error('No owner database connection (MIGRATION_DATABASE_URL or DATABASE_URL_UNPOOLED)');
    if (cmd === 'init') return trialInit(url);
    if (cmd === 'reset') {
      if (!process.argv.includes('--yes')) throw new Error('This deletes all trial data. Run again with --yes to confirm.');
      return trialReset(url);
    }
    throw new Error('Usage: trial.ts init | reset --yes');
  };
  run().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
