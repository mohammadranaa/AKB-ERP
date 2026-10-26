// Reader for AKB's existing daily Excel cash book (sheet "CASH"), used for migration and as a
// "golden" test: the ledger must reproduce each day's closing balance exactly.
//
// Layout (columns A–G):
//   A amount paid | B particular | C detail | D serial | E amount received | F particular | G detail
//   Row 2 holds the date. The opening balance sits in column E near the top (labelled or not).
//   A second book ("CASH BOOK SWL") continues in the same columns further down.
//   Labelled rows TOTAL CREDIT / TOTAL DEBIT / NEXT BALANCE / PK BALANCE / TOTAL / DIFF close the day.
//   Unlabelled column-total rows also appear; a data row always has a particular or detail.

import ExcelJS from 'exceljs';
import type { Db } from '../db.js';
import { one } from '../db.js';
import { formatPkr, fromPaisa, toPaisa } from '../lib/money.js';
import { ACC, accountId, postEntry } from './posting.js';

export interface CashBookRow {
  row: number;
  amount: string;
  particular: string;
  detail: string;
  serial: number | null;
  book: 'main' | 'swl';
}

export interface CashBookDay {
  date: string;
  opening: string;
  receipts: CashBookRow[];
  payments: CashBookRow[];
  totals: Partial<Record<'TOTAL CREDIT' | 'TOTAL DEBIT' | 'NEXT BALANCE' | 'PK BALANCE' | 'TOTAL' | 'DIFF', string>>;
  computedClosing: string;
  warnings: string[];
}

const LABELS = ['TOTAL CREDIT', 'TOTAL DEBIT', 'NEXT BALANCE', 'PK BALANCE', 'TOTAL', 'DIFF'] as const;

function value(v: ExcelJS.CellValue): unknown {
  if (v && typeof v === 'object' && 'result' in (v as object)) return (v as { result: unknown }).result;
  if (v && typeof v === 'object' && 'richText' in (v as object)) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
  return v;
}
const isText = (v: unknown) => typeof v === 'string' && v.trim() !== '' && !/^[-\s]+$/.test(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v == null ? '' : String(v));
const money = (n: number) => fromPaisa(toPaisa(n));

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (isNum(v)) {
    // Excel serial date (1900 system).
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  return null;
}

export async function parseCashBook(data: Buffer | ArrayBuffer, sheetName = 'CASH'): Promise<CashBookDay> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const ws = wb.getWorksheet(sheetName) ?? wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheets');

  const warnings: string[] = [];
  let date: string | null = null;
  for (let r = 1; r <= 4 && !date; r++) for (let col = 1; col <= 4 && !date; col++) date = isoDate(value(ws.getCell(r, col).value));
  if (!date) throw new Error('Could not find the cash book date near the top of the sheet');

  let opening: number | null = null;
  let book: 'main' | 'swl' = 'main';
  let sawData = false;
  const receipts: CashBookRow[] = [];
  const payments: CashBookRow[] = [];
  const totals: CashBookDay['totals'] = {};

  for (let r = 3; r <= ws.rowCount; r++) {
    const cells = [1, 2, 3, 4, 5, 6, 7].map((i) => value(ws.getCell(r, i).value));
    const [a, b, c, d, e, f, g] = cells;
    const label = typeof f === 'string' ? f.trim().toUpperCase() : '';
    if ((LABELS as readonly string[]).includes(label)) {
      if (isNum(g)) totals[label as keyof CashBookDay['totals']] = money(g);
      continue;
    }
    if (typeof c === 'string' && /CASH\s*BOOK\s*SWL/i.test(c)) {
      book = 'swl';
      continue;
    }
    if (opening === null && !sawData && isNum(e) && (label === 'OPENING BALANCE' || (!isText(f) && !isText(b) && d == null))) {
      opening = e;
      continue;
    }
    const serial = isNum(d) ? d : null;
    if (isNum(a) && (isText(b) || isText(c))) {
      payments.push({ row: r, amount: money(a), particular: str(b), detail: str(c), serial, book });
      sawData = true;
    } else if (isNum(a) && a !== 0) {
      // A number with no description is a subtotal; it is ignored but reported.
      warnings.push(`Row ${r}: payment column amount ${formatPkr(money(a))} has no particular and was treated as a subtotal`);
    }
    if (isNum(e) && (isText(f) || isText(g))) {
      receipts.push({ row: r, amount: money(e), particular: str(f), detail: str(g), serial, book });
      sawData = true;
    } else if (isNum(e) && e !== 0 && opening !== null) {
      warnings.push(`Row ${r}: receipt column amount ${formatPkr(money(e))} has no particular and was treated as a subtotal`);
    }
  }
  if (opening === null) throw new Error('Could not find the opening balance');
  const sum = (rows: CashBookRow[]) => rows.reduce((s, x) => s + toPaisa(x.amount), 0n);
  const computed = toPaisa(opening) + sum(receipts) - sum(payments);
  return {
    date,
    opening: money(opening),
    receipts,
    payments,
    totals,
    computedClosing: fromPaisa(computed),
    warnings
  };
}

export interface DayCheck {
  date: string;
  ok: boolean;
  problems: string[];
}

/** Check one day's arithmetic against its own totals, and the chain from the previous day. */
export function checkDay(day: CashBookDay, previous?: CashBookDay): DayCheck {
  const problems: string[] = [];
  const t = day.totals;
  const recs = day.receipts.reduce((s, x) => s + toPaisa(x.amount), 0n);
  const pays = day.payments.reduce((s, x) => s + toPaisa(x.amount), 0n);
  if (t['TOTAL CREDIT'] && toPaisa(t['TOTAL CREDIT']) !== toPaisa(day.opening) + recs) {
    problems.push(`Receipts + opening = ${formatPkr(toPaisa(day.opening) + recs)} but TOTAL CREDIT says ${formatPkr(t['TOTAL CREDIT'])}`);
  }
  if (t['TOTAL DEBIT'] && toPaisa(t['TOTAL DEBIT']) !== pays) {
    problems.push(`Payments = ${formatPkr(pays)} but TOTAL DEBIT says ${formatPkr(t['TOTAL DEBIT'])}`);
  }
  if (t['NEXT BALANCE'] && toPaisa(t['NEXT BALANCE']) !== toPaisa(day.computedClosing)) {
    problems.push(`Computed closing ${formatPkr(day.computedClosing)} but NEXT BALANCE says ${formatPkr(t['NEXT BALANCE'])}`);
  }
  if (previous && toPaisa(previous.computedClosing) !== toPaisa(day.opening)) {
    problems.push(`Opening ${formatPkr(day.opening)} does not equal the previous day's closing ${formatPkr(previous.computedClosing)} (${previous.date})`);
  }
  return { date: day.date, ok: problems.length === 0, problems };
}

/**
 * Post one cash book day into the ledger: every receipt debits cash, every payment credits cash,
 * with the other side held in a suspense account until parties and banks are mapped.
 * On the first imported day the opening balance is posted against opening-balance equity.
 * Returns the ledger's cash balance after the day, which must equal the sheet's closing balance.
 */
export async function importCashBookDay(
  c: Db,
  day: CashBookDay,
  opts: { firmId: number; userId: number; cashAccountCode?: string }
): Promise<{ ledgerOpening: string; ledgerClosing: string; matches: boolean }> {
  const cash = await accountId(c, opts.cashAccountCode ?? '1101');
  const suspense = await accountId(c, ACC.suspense);
  const before = await one<{ b: string; n: string }>(
    c,
    `select coalesce(sum(debit - credit),0) as b, count(*) as n from posted_lines where account_id = $1 and business_date < $2`,
    [cash, day.date]
  );
  if (Number(before.n) === 0 && toPaisa(day.opening) !== 0n) {
    await postEntry(c, {
      firmId: opts.firmId,
      businessDate: day.date,
      narration: `Opening cash from cash book ${day.date}`,
      sourceType: 'import_opening',
      sourceId: day.date,
      createdBy: opts.userId,
      lines: [
        { accountId: cash, debit: day.opening },
        { accountId: await accountId(c, ACC.openingEquity), credit: day.opening }
      ]
    });
  } else if (toPaisa(before.b) !== toPaisa(day.opening)) {
    throw new Error(`Ledger cash before ${day.date} is ${formatPkr(before.b)} but the sheet opens with ${formatPkr(day.opening)}`);
  }
  const lines = [
    ...day.receipts.map((r) => [
      { accountId: cash, debit: r.amount, memo: `R${r.serial ?? ''} ${r.particular} · ${r.detail}`.trim() },
      { accountId: suspense, credit: r.amount, memo: r.particular }
    ]),
    ...day.payments.map((p) => [
      { accountId: suspense, debit: p.amount, memo: p.particular },
      { accountId: cash, credit: p.amount, memo: `P${p.serial ?? ''} ${p.particular} · ${p.detail}`.trim() }
    ])
  ].flat();
  if (lines.length) {
    await postEntry(c, {
      firmId: opts.firmId,
      businessDate: day.date,
      narration: `Cash book import ${day.date} (${day.receipts.length} receipts, ${day.payments.length} payments)`,
      sourceType: 'import_cashbook',
      sourceId: day.date,
      createdBy: opts.userId,
      lines
    });
  }
  const after = await one<{ b: string }>(
    c,
    'select coalesce(sum(debit - credit),0) as b from posted_lines where account_id = $1 and business_date <= $2',
    [cash, day.date]
  );
  return { ledgerOpening: day.opening, ledgerClosing: after.b, matches: toPaisa(after.b) === toPaisa(day.computedClosing) };
}
