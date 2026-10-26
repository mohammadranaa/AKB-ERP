import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne } from '../db.js';
import { audit } from '../lib/audit.js';
import { rule } from '../lib/errors.js';
import { AmountOrZero, formatPkr, fromPaisa, toPaisa } from '../lib/money.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface MoneyAccountDay {
  account_id: number;
  code: string;
  name: string;
  control: 'cash' | 'bank';
  opening: string;
  receipts: string;
  payments: string;
  closing: string;
}

async function moneyAccountsForDay(c: Db, date: string): Promise<MoneyAccountDay[]> {
  return many<MoneyAccountDay>(
    c,
    `select a.id as account_id, a.code, a.name, a.control,
            coalesce(sum(p.debit - p.credit) filter (where p.business_date < $1),0) as opening,
            coalesce(sum(p.debit) filter (where p.business_date = $1),0) as receipts,
            coalesce(sum(p.credit) filter (where p.business_date = $1),0) as payments,
            coalesce(sum(p.debit - p.credit) filter (where p.business_date <= $1),0) as closing
       from accounts a left join posted_lines p on p.account_id = a.id
      where a.control in ('cash','bank') and a.postable
      group by a.id order by a.control desc, a.code`,
    [date]
  );
}

/** The day book: every posted line on cash and bank accounts for the day, two-sided like the paper cash book. */
async function dayBook(c: Db, date: string) {
  const accounts = await moneyAccountsForDay(c, date);
  const lines = await many<{
    account_id: number; entry_no: string; narration: string; memo: string | null; debit: string; credit: string; party_name: string | null; counter: string | null;
  }>(
    c,
    `select p.account_id, p.entry_no, p.narration, p.memo, p.debit, p.credit,
            (select pa.name_en from journal_lines l2 join parties pa on pa.id = l2.party_id where l2.entry_id = p.entry_id and l2.party_id is not null limit 1) as party_name,
            (select string_agg(a2.name, ', ') from journal_lines l2 join accounts a2 on a2.id = l2.account_id where l2.entry_id = p.entry_id and l2.id <> p.id) as counter
       from posted_lines p join accounts a on a.id = p.account_id
      where a.control in ('cash','bank') and p.business_date = $1
      order by p.account_id, p.entry_id, p.line_no`,
    [date]
  );
  const journals = await many(
    c,
    `select e.entry_no, e.narration, e.source_type, a.code, a.name as account_name, pa.name_en as party_name, l.debit, l.credit
       from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
       left join parties pa on pa.id = l.party_id
      where e.status = 'posted' and e.business_date = $1 order by e.id, l.line_no`,
    [date]
  );
  return { accounts, lines, journals };
}

async function buildWorkbook(date: string, book: Awaited<ReturnType<typeof dayBook>>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AKB ERP';
  wb.created = new Date();
  const money = '#,##,##0.00';
  for (const acc of book.accounts.filter((a) => a.control === 'cash')) {
    const ws = wb.addWorksheet(`Cash book ${acc.code}`.slice(0, 31));
    ws.addRow([`${acc.name} · cash book · ${date}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    ws.addRow(['PAYMENTS', '', '', '', 'RECEIPTS', '', '']).font = { bold: true };
    ws.addRow(['Amount Rs', 'Particular', 'Detail', '', 'Amount Rs', 'Particular', 'Detail']).font = { bold: true };
    const pays = book.lines.filter((l) => l.account_id === acc.account_id && toPaisa(l.credit) > 0n);
    const recs = book.lines.filter((l) => l.account_id === acc.account_id && toPaisa(l.debit) > 0n);
    const rows: (string | number | null)[][] = [[null, '', '', '', Number(acc.opening), 'Opening balance', '']];
    const n = Math.max(pays.length, recs.length);
    for (let i = 0; i < n; i++) {
      const p = pays[i];
      const r = recs[i];
      rows.push([
        p ? Number(p.credit) : null, p ? (p.party_name ?? p.counter ?? '') : '', p ? `${p.entry_no} · ${p.memo ?? p.narration}` : '', '',
        r ? Number(r.debit) : null, r ? (r.party_name ?? r.counter ?? '') : '', r ? `${r.entry_no} · ${r.memo ?? r.narration}` : ''
      ]);
    }
    for (const row of rows) ws.addRow(row);
    ws.addRow([]);
    const totalCredit = toPaisa(acc.opening) + toPaisa(acc.receipts);
    ws.addRow(['', '', '', '', Number(fromPaisa(totalCredit)), 'TOTAL RECEIPTS (incl. opening)']).font = { bold: true };
    ws.addRow(['', '', '', '', Number(acc.payments), 'TOTAL PAYMENTS']).font = { bold: true };
    ws.addRow(['', '', '', '', Number(acc.closing), 'CLOSING BALANCE']).font = { bold: true };
    [1, 5].forEach((col) => (ws.getColumn(col).numFmt = money));
    ws.columns.forEach((c, i) => (c.width = [14, 28, 40, 3, 14, 28, 40][i] ?? 12));
  }
  const sum = wb.addWorksheet('Cash and bank');
  sum.addRow(['Account', 'Type', 'Opening', 'Receipts', 'Payments', 'Closing']).font = { bold: true };
  for (const a of book.accounts) sum.addRow([`${a.code} ${a.name}`, a.control, Number(a.opening), Number(a.receipts), Number(a.payments), Number(a.closing)]);
  [3, 4, 5, 6].forEach((col) => (sum.getColumn(col).numFmt = money));
  sum.columns.forEach((c, i) => (c.width = [34, 8, 16, 16, 16, 16][i] ?? 12));
  const jw = wb.addWorksheet('Journal');
  jw.addRow(['Entry', 'Narration', 'Source', 'Account', 'Party', 'Debit', 'Credit']).font = { bold: true };
  for (const j of book.journals as Record<string, string>[]) {
    jw.addRow([j.entry_no, j.narration, j.source_type, `${j.code} ${j.account_name}`, j.party_name ?? '', Number(j.debit) || null, Number(j.credit) || null]);
  }
  [6, 7].forEach((col) => (jw.getColumn(col).numFmt = money));
  jw.columns.forEach((c, i) => (c.width = [16, 50, 14, 30, 28, 14, 14][i] ?? 12));
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function toCsv(book: Awaited<ReturnType<typeof dayBook>>): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = ['entry_no,narration,source_type,account_code,account_name,party,debit,credit'];
  for (const j of book.journals as Record<string, string>[]) {
    out.push([j.entry_no, j.narration, j.source_type, j.code, j.account_name, j.party_name, j.debit, j.credit].map(esc).join(','));
  }
  return out.join('\n') + '\n';
}

export async function dayRoutes(app: FastifyInstance) {
  app.get('/:date', { preHandler: requirePerm('day.close', 'ledger.read') }, async (req) => {
    const { date } = z.object({ date: DateStr }).parse(req.params);
    return app.read(req, async (c) => {
      const day = await maybeOne(c, 'select d.business_date, d.status, d.locked_at, d.locked_by, d.checklist, d.export_sha256, d.csv_sha256, u.full_name as locked_by_name from business_days d left join users u on u.id = d.locked_by where business_date = $1', [date]);
      const accounts = await moneyAccountsForDay(c, date);
      const pending = await many(
        c,
        "select id, narration, created_at from journal_entries where business_date = $1 and status = 'pending_approval'",
        [date]
      );
      const unallocated = await many(
        c,
        `select r.id, r.receipt_no, p.name_en as party_name,
                r.amount - coalesce((select sum(x.amount) from receipt_allocations x where x.receipt_id = r.id and x.reversed_at is null),0) as unallocated
           from receipts r join parties p on p.id = r.party_id
          where r.business_date = $1 and r.status = 'posted'
            and r.amount > coalesce((select sum(x.amount) from receipt_allocations x where x.receipt_id = r.id and x.reversed_at is null),0)`,
        [date]
      );
      const counts = await maybeOne(
        c,
        `select (select count(*) from receipts where business_date = $1) as receipts,
                (select count(*) from dispatches where business_date = $1) as dispatches,
                (select coalesce(sum(-bags),0) from stock_movements where business_date = $1 and kind = 'dispatch') as bags_dispatched,
                (select coalesce(sum(bags),0) from stock_movements where business_date = $1 and kind = 'receipt') as bags_received,
                (select count(*) from ogs where business_date = $1 and status <> 'draft') as ogs,
                (select count(*) from journal_entries where business_date = $1 and status = 'posted') as entries`,
        [date]
      );
      const prevOpen = await many(
        c,
        `select d::date as business_date from generate_series($1::date - 7, $1::date - 1, interval '1 day') d
          where exists (select 1 from journal_entries e where e.business_date = d::date and e.status = 'posted')
            and not exists (select 1 from business_days b where b.business_date = d::date and b.status = 'locked')`,
        [date]
      );
      return { date, status: (day as { status?: string } | null)?.status ?? 'open', day, accounts, pendingApprovals: pending, unallocatedReceipts: unallocated, counts, earlierOpenDays: prevOpen };
    });
  });

  app.post('/:date/lock', { preHandler: requirePerm('day.close') }, async (req) => {
    const { date } = z.object({ date: DateStr }).parse(req.params);
    const b = z
      .object({
        counts: z.array(z.object({ accountId: z.number().int(), amount: AmountOrZero })).default([]),
        note: z.string().max(500).nullish()
      })
      .parse(req.body);
    if (date > app.today()) throw rule('A future date cannot be closed');
    return app.mutate(req, 'days.lock', async (c) => {
      const day = await maybeOne<{ status: string }>(c, 'select status from business_days where business_date = $1 for update', [date]);
      if (day?.status === 'locked') throw rule(`${date} is already locked`);
      const pending = await many(c, "select id from journal_entries where business_date = $1 and status = 'pending_approval'", [date]);
      if (pending.length) throw rule(`${pending.length} journal entr${pending.length === 1 ? 'y is' : 'ies are'} still waiting for approval on this date`);
      const accounts = await moneyAccountsForDay(c, date);
      const problems: string[] = [];
      const checklist: Record<string, unknown>[] = [];
      for (const a of accounts) {
        const active = toPaisa(a.closing) !== 0n || toPaisa(a.receipts) !== 0n || toPaisa(a.payments) !== 0n;
        const given = b.counts.find((x) => x.accountId === a.account_id);
        if (!given) {
          if (active) problems.push(`Enter the ${a.control === 'cash' ? 'cash counted' : 'statement balance'} for ${a.name}`);
          continue;
        }
        const diff = toPaisa(given.amount) - toPaisa(a.closing);
        checklist.push({ accountId: a.account_id, name: a.name, system: a.closing, counted: given.amount, difference: fromPaisa(diff) });
        if (diff !== 0n) problems.push(`${a.name}: system shows Rs ${formatPkr(a.closing)}, you entered Rs ${formatPkr(given.amount)} (difference Rs ${formatPkr(diff)})`);
      }
      if (problems.length) throw rule('The day cannot be locked yet', problems);
      // Generate the day book once, at lock time, and store it. Later downloads return these exact bytes.
      const book = await dayBook(c, date);
      const xlsx = await buildWorkbook(date, book);
      const csv = toCsv(book);
      const sha = createHash('sha256').update(xlsx).digest('hex');
      const csvSha = createHash('sha256').update(csv, 'utf8').digest('hex');
      await c.query(
        `insert into business_days(business_date, status, locked_at, locked_by, checklist, export_sha256, export_xlsx, export_csv, csv_sha256)
         values ($1,'locked',now(),$2,$3,$4,$5,$6,$7)
         on conflict (business_date) do update set status='locked', locked_at=now(), locked_by=$2, checklist=$3,
           export_sha256=$4, export_xlsx=$5, export_csv=$6, csv_sha256=$7`,
        [date, req.user!.id, JSON.stringify({ accounts: checklist, note: b.note ?? null }), sha, xlsx, csv, csvSha]
      );
      await audit(c, req.user!.id, 'lock', 'business_day', date, { checklist, sha256: sha, csvSha256: csvSha });
      return { date, status: 'locked', sha256: sha, csvSha256: csvSha };
    });
  });

  // Downloads are logged. The checksum lets anyone confirm a saved file has not been edited.
  app.get('/:date/daybook', { preHandler: requirePerm('daybook.export') }, async (req, reply) => {
    const { date } = z.object({ date: DateStr }).parse(req.params);
    const { format } = z.object({ format: z.enum(['xlsx', 'csv']).default('xlsx') }).parse(req.query);
    const { body, sha } = await app.mutate(req, 'days.export', async (c) => {
      const day = await maybeOne<{ status: string; export_sha256: string; export_xlsx: Buffer; export_csv: string; csv_sha256: string }>(
        c,
        'select status, export_sha256, export_xlsx, export_csv, csv_sha256 from business_days where business_date = $1',
        [date]
      );
      if (day?.status !== 'locked') throw rule('Lock the day before downloading its day book');
      const data = format === 'xlsx' ? day.export_xlsx : Buffer.from(day.export_csv, 'utf8');
      const hash = format === 'xlsx' ? day.export_sha256 : day.csv_sha256;
      await audit(c, req.user!.id, 'export', 'business_day', date, { format, sha256: hash });
      return { body: data.toString('base64'), sha: hash };
    });
    reply.header('X-Content-SHA256', sha);
    reply.header('Content-Disposition', `attachment; filename="AKB-daybook-${date}.${format}"`);
    reply.type(format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv; charset=utf-8');
    return reply.send(Buffer.from(body, 'base64'));
  });
}

