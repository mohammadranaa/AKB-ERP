// Check AKB's daily Excel cash books, and optionally replay them through the ledger.
//
//   tsx src/cli/cashbook-check.ts <file.xlsx> [more files...]          arithmetic + day-to-day chain
//   tsx src/cli/cashbook-check.ts --ledger <files...>                   also post into a scratch ledger
//
// --ledger needs MIGRATION_DATABASE_URL pointing at an EMPTY scratch database that has been migrated
// and seeded; every posting is rolled back at the end, so nothing is kept.
// Real cash books are client data: run this on the client's machine and never commit the files.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { formatPkr } from '../lib/money.js';
import { checkDay, importCashBookDay, parseCashBook, type CashBookDay } from '../services/cashbook.js';
import { loadDotEnv } from '../env-file.js';

loadDotEnv();

const args = process.argv.slice(2);
const useLedger = args.includes('--ledger');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) {
  console.error('Usage: cashbook-check [--ledger] <file.xlsx>...');
  process.exit(1);
}

const days: CashBookDay[] = [];
for (const f of files) days.push(await parseCashBook(readFileSync(f)));
days.sort((a, b) => a.date.localeCompare(b.date));

let failures = 0;
let prev: CashBookDay | undefined;
for (const d of days) {
  const r = checkDay(d, prev);
  console.log(
    `${d.date}  opening ${formatPkr(d.opening).padStart(16)}  receipts ${String(d.receipts.length).padStart(3)}  payments ${String(d.payments.length).padStart(3)}  closing ${formatPkr(d.computedClosing).padStart(16)}  ${r.ok ? 'OK' : 'MISMATCH'}`
  );
  for (const p of r.problems) console.log(`    ! ${p}`);
  if (process.env.VERBOSE) for (const w of d.warnings) console.log(`    · ${w}`);
  if (!r.ok) failures++;
  prev = d;
}

if (useLedger) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('Set MIGRATION_DATABASE_URL for --ledger');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    const firm = (await c.query('select id from firms order by id limit 1')).rows[0]?.id;
    const user = (await c.query('select id from users order by id limit 1')).rows[0]?.id;
    if (!firm || !user) throw new Error('The scratch database needs a firm and a user (run the seed first)');
    // Use a dedicated cash account so seeded balances do not interfere.
    await c.query("insert into accounts(code, name, type, parent_id, control) select 'CB-IMPORT', 'Cash book import check', 'asset', id, 'cash' from accounts where code = '1100'");
    console.log('\nReplaying through the ledger (rolled back afterwards):');
    for (const d of days) {
      const r = await importCashBookDay(c as unknown as import('../db.js').Db, d, { firmId: firm, userId: user, cashAccountCode: 'CB-IMPORT' });
      console.log(`${d.date}  ledger closing ${formatPkr(r.ledgerClosing).padStart(16)}  sheet ${formatPkr(d.totals['NEXT BALANCE'] ?? d.computedClosing).padStart(16)}  ${r.matches ? 'MATCH' : 'DIFFERENT'}`);
      if (!r.matches) failures++;
    }
  } finally {
    await c.query('rollback');
    await c.end();
  }
}

console.log(failures ? `\n${failures} problem(s) found` : '\nAll days reconcile');
process.exit(failures ? 1 : 0);
