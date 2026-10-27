// Vercel detects the Fastify entry point by this import (the app itself is built in build-app.ts).
import 'fastify';
import { buildApp } from './build-app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { loadDotEnv } from './env-file.js';

loadDotEnv();

const config = loadConfig();
// With DB_SET_ROLE the session must stay the restricted role, so prefer the direct connection
// (Neon on Vercel provides DATABASE_URL_UNPOOLED) over a transaction pooler.
const appUrl = config.DB_SET_ROLE && process.env.DATABASE_URL_UNPOOLED ? process.env.DATABASE_URL_UNPOOLED : config.DATABASE_URL;
const db = new Database(appUrl, config.TIMEZONE, config.DB_SET_ROLE);
await db.assertRestricted();
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.ready();
// Not awaited: on Vercel the runtime intercepts listen() to capture the server and never reports it
// as started, so awaiting here would stop the module from finishing loading.
app
  .listen({ host: config.HOST, port: config.PORT })
  .then(() => console.log(`AKB ERP API listening on ${config.HOST}:${config.PORT}${config.TRIAL_MODE ? ' (TRIAL MODE: practice data only)' : ''}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
