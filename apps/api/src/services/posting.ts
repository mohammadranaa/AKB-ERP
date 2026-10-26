import type { Db } from '../db.js';
import { one } from '../db.js';
import { fromPaisa, toPaisa } from '../lib/money.js';

export interface PostingLine {
  accountId: number;
  debit?: string; // "1234.50"
  credit?: string;
  partyId?: number | null;
  branchId?: number | null;
  costCentreId?: number | null;
  memo?: string | null;
}

export interface PostingInput {
  firmId: number;
  businessDate: string;
  narration: string;
  sourceType: string;
  sourceId?: string | null;
  createdBy: number;
  approvedBy?: number | null;
  status?: 'posted' | 'draft' | 'pending_approval';
  lines: PostingLine[];
}

/**
 * Write a journal entry and its lines in the current transaction.
 * The database checks balance at commit, but we check here too for a clear error message.
 */
export async function postEntry(c: Db, input: PostingInput): Promise<{ id: string; entryNo: string | null }> {
  const lines = input.lines.filter((l) => toPaisa(l.debit ?? '0') !== 0n || toPaisa(l.credit ?? '0') !== 0n);
  let d = 0n;
  let cr = 0n;
  for (const l of lines) {
    d += toPaisa(l.debit ?? '0');
    cr += toPaisa(l.credit ?? '0');
  }
  if ((input.status ?? 'posted') === 'posted' && d !== cr) {
    throw new Error(`Unbalanced posting for ${input.sourceType}: debits ${fromPaisa(d)} vs credits ${fromPaisa(cr)}`);
  }
  const e = await one<{ id: string; entry_no: string | null }>(
    c,
    `insert into journal_entries(firm_id, business_date, narration, source_type, source_id, status, created_by, approved_by, approved_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, case when $8::int is null then null else now() end)
     returning id, entry_no`,
    [
      input.firmId,
      input.businessDate,
      input.narration,
      input.sourceType,
      input.sourceId ?? null,
      input.status ?? 'posted',
      input.createdBy,
      input.approvedBy ?? null
    ]
  );
  let n = 1;
  for (const l of lines) {
    await c.query(
      `insert into journal_lines(entry_id, line_no, account_id, party_id, branch_id, cost_centre_id, debit, credit, memo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        e.id,
        n++,
        l.accountId,
        l.partyId ?? null,
        l.branchId ?? null,
        l.costCentreId ?? null,
        l.debit ?? '0',
        l.credit ?? '0',
        l.memo ?? null
      ]
    );
  }
  return { id: e.id, entryNo: e.entry_no };
}

/** Look up a postable account id by its code (codes are stable; ids differ per installation). */
export async function accountId(c: Db, code: string): Promise<number> {
  const r = await one<{ id: number }>(c, 'select id from accounts where code = $1', [code]);
  return r.id;
}

export const ACC = {
  receivables: '1300',
  payables: '2100',
  sales: '4100',
  freightRecovered: '4200',
  freightExpense: '5200',
  bankCharges: '5300',
  discounts: '5600',
  suspense: '9999',
  openingEquity: '3300'
} as const;

export async function firmId(c: Db, code: string): Promise<number> {
  const r = await one<{ id: number }>(c, 'select id from firms where code = $1', [code]);
  return r.id;
}
