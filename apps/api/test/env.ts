export const OWNER_URL = process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://akb_owner:owner_dev_pw@localhost:5432/akb_test';
export const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://akb_app:app_dev_pw@localhost:5432/akb_test';
export const SEED_DATE = '2026-10-01';
