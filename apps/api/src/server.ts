import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';

const config = loadConfig();
const db = new Database(config.DATABASE_URL, config.TIMEZONE);
const app = await buildApp({ config, db });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
