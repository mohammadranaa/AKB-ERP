import { loadDotEnv } from '../src/env-file.js';

loadDotEnv();

/** The test database is the main one with "_test" added to its name; it is wiped on every run. */
const toTest = (url: string | undefined) => (url ? url.replace(/\/([^/?]+)(\?|$)/, (_m, db: string, q: string) => `/${db}_test${q}`) : undefined);

export const OWNER_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? toTest(process.env.MIGRATION_DATABASE_URL) ?? 'postgres://akb_owner:owner_dev_pw@localhost:5432/akb_test';
export const APP_URL =
  process.env.TEST_DATABASE_URL ?? toTest(process.env.DATABASE_URL) ?? 'postgres://akb_app:app_dev_pw@localhost:5432/akb_test';
export const SEED_DATE = '2026-10-01';
