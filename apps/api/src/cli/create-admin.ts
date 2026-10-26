// First-time setup on a real installation: create the firm, a branch and the first admin user.
// Usage: MIGRATION_DATABASE_URL=... pnpm --filter @akb/api exec tsx src/cli/create-admin.ts <username> "<Full name>"
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../auth.js';

const [username, fullName] = process.argv.slice(2);
if (!username || !fullName) {
  console.error('Usage: create-admin <username> "<Full name>"');
  process.exit(1);
}
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('Set MIGRATION_DATABASE_URL');
  process.exit(1);
}
const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  await c.query('begin');
  const firms = await c.query('select id from firms');
  if (firms.rowCount === 0) {
    await c.query("insert into firms(code, name) values ($1, $2)", [process.env.FIRM_CODE ?? 'AKB', process.env.FIRM_NAME ?? 'AKB Group']);
  }
  const raw = randomBytes(12).toString('base64url');
  const pw = `Akb-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10)}7Q`;
  await c.query("insert into users(username, full_name, role_code, password_hash, must_change_pw) values ($1,$2,'admin',$3,true)", [
    username,
    fullName,
    await hashPassword(pw)
  ]);
  await c.query("insert into audit_log(action, entity, entity_id, detail) values ('create_admin','user',$1,null)", [username]);
  await c.query('commit');
  console.log(`Admin "${username}" created. One-time password: ${pw}`);
  console.log('Sign in, set a new password and scan the authenticator QR code.');
} catch (e) {
  await c.query('rollback');
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await c.end();
}
