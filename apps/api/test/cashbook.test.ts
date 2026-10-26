// Golden test for the cash book importer. The workbooks are generated here in the same layout as
// AKB's real daily cash books (including the awkward parts), with invented names and amounts.
// The real files are checked with `pnpm cashbook:check` on the client's machine and are never committed.
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { checkDay, importCashBookDay, parseCashBook } from '../src/services/cashbook.js';
import { APP_URL } from './env.js';
import { ids, ownerQuery } from './helpers.js';

type Row = [pay: number | null, payPart: string, payDetail: string, sn: number | null, rec: number | null, recPart: string, recDetail: string];

async function workbook(date: Date, opening: number, main: Row[], swl: Row[], opts: { labelOpening?: boolean; corruptTotals?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('CASH');
  ws.getCell('B1').value = 'CASH ';
  ws.getCell('B2').value = date;
  ws.getCell('A3').value = 'PAYMENT/DEBIT';
  ws.getCell('E3').value = 'PAYMENT/CREDIT';
  ws.getRow(4).values = ['AMOUNT\nRS.', 'PARTICULAR', 'DETAIL', 'S.N', 'AMOUNT\nRS.', 'PARTICULAR', 'DETAIL'];
  ws.getRow(5).values = opts.labelOpening === false ? [null, null, null, null, opening] : ['-----', '------------', '-------', null, opening, 'OPENING BALANCE', '-----'];
  let r = 6;
  for (const row of main) ws.getRow(r++).values = row;
  ws.getRow(r++).values = [null, null, 'CASH BOOK SWL '];
  for (const row of swl) ws.getRow(r++).values = row;
  // padding rows with only a serial number, as in the real sheets
  for (let i = 0; i < 3; i++) ws.getRow(r++).values = [null, null, null, 40 + i];
  const pays = [...main, ...swl].reduce((s, x) => s + (x[0] && (x[1] || x[2]) ? x[0] : 0), 0);
  const recs = [...main, ...swl].reduce((s, x) => s + (x[4] && (x[5] || x[6]) ? x[4] : 0), 0);
  // an unlabelled column-total row, which must be ignored
  ws.getRow(r++).values = [pays, null, null, null, opening + recs];
  ws.getRow(r++).values = [null, null, null, null, null, 'TOTAL CREDIT', opening + recs];
  ws.getRow(r++).values = [null, null, null, null, null, 'TOTAL DEBIT', pays];
  ws.getRow(r++).values = [null, null, null, null, null, 'NEXT BALANCE', opts.corruptTotals ? opening + recs - pays + 1 : opening + recs - pays];
  ws.getRow(r++).values = [null, null, null, null, null, 'PK BALANCE ', 12345];
  ws.getRow(r++).values = [null, null, null, null, null, 'TOTAL ', opening + recs - pays];
  ws.getRow(r++).values = [null, null, null, null, null, 'DIFF', 0];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const day1: Row[] = [
  [22800, 'FREIGHT EXP', '600 BAGS DAP', 1, 67750, 'DEMO TRADERS PK', 'CASH BY SELF'],
  [300000, 'BANK-0001', 'SAMPLE TRD', 2, 300000, 'SAMPLE TRD', 'ONLINE'],
  [4206, 'LOADING EXP', 'LABOUR', 3, 80246, 'TEST AGRI PK', 'CASH'],
  [1500, 'CHARITY', 'COINS', 4, null, '', '']
];
const day1swl: Row[] = [
  [26760, 'FREIGHT EXP', 'STORE A', 1, 26760, 'STORE A', '2230 DAP FREIGHT @ 12'],
  [5500, 'LOADING EXP', 'WORKER B', 2, 5500, 'WORKER B', '1100 BAGS @ 5']
];
const day2: Row[] = [
  [100000, 'DEMO PERSON', 'CASH BY SELF', 1, 191400, 'DEMO C/S PK', 'CASH'],
  [6000, 'STAFF KHATA', 'ADVANCE', 2, 9000, 'SAMPLE KAMEER', 'CASH']
];

let db: Database;
beforeAll(() => {
  db = new Database(APP_URL);
});
afterAll(async () => db.close());

describe('cash book reader', () => {
  it('reads the opening, both books, and ignores subtotals, padding and the totals block', async () => {
    const d = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 26)), 6061445, day1, day1swl));
    expect(d.date).toBe('2019-07-26');
    expect(d.opening).toBe('6061445.00');
    expect(d.receipts).toHaveLength(5);
    expect(d.payments).toHaveLength(6);
    expect(d.payments.filter((p) => p.book === 'swl')).toHaveLength(2);
    expect(d.totals['NEXT BALANCE']).toBe(d.computedClosing);
    expect(checkDay(d).ok).toBe(true);
  });

  it('finds an unlabelled opening balance', async () => {
    const d = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 27)), 1000, day2, [], { labelOpening: false }));
    expect(d.opening).toBe('1000.00');
  });

  it('reports a day whose totals do not add up, and a broken chain between days', async () => {
    const d1 = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 26)), 6061445, day1, day1swl));
    const bad = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 27)), 999, day2, [], { corruptTotals: true }));
    const r = checkDay(bad, d1);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/NEXT BALANCE/);
    expect(r.problems.join(' ')).toMatch(/previous day's closing/);
  });
});

describe('golden test: the ledger reproduces each day\'s closing balance', () => {
  it('two consecutive days', async () => {
    const I = await ids();
    const firm = Number((await ownerQuery('select id from firms limit 1'))[0].id);
    const d1 = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 26)), 6061445, day1, day1swl));
    const d2Opening = Number(d1.computedClosing);
    const d2 = await parseCashBook(await workbook(new Date(Date.UTC(2019, 6, 27)), d2Opening, day2, []));
    expect(checkDay(d2, d1).ok).toBe(true);
    await ownerQuery("insert into accounts(code, name, type, parent_id, control) select 'CB-TEST', 'Cash book test', 'asset', id, 'cash' from accounts where code = '1100' on conflict do nothing");
    await db.tx({ userId: I.users.accounts!, role: 'accounts' }, async (c) => {
      const r1 = await importCashBookDay(c, d1, { firmId: firm, userId: I.users.accounts!, cashAccountCode: 'CB-TEST' });
      expect(r1.matches).toBe(true);
      expect(r1.ledgerClosing).toBe(d1.totals['NEXT BALANCE']);
      const r2 = await importCashBookDay(c, d2, { firmId: firm, userId: I.users.accounts!, cashAccountCode: 'CB-TEST' });
      expect(r2.matches).toBe(true);
      expect(r2.ledgerClosing).toBe(d2.totals['NEXT BALANCE']);
    });
  });
});
