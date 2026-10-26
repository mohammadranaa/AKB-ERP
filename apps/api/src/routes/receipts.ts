import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, rule } from '../lib/errors.js';
import { Amount, AmountOrZero, formatPkr, fromPaisa, toPaisa } from '../lib/money.js';
import { ACC, accountId, firmId, postEntry } from '../services/posting.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const Allocation = z.object({ ogId: z.number().int(), amount: Amount });

const ReceiptInput = z.object({
  businessDate: DateStr.optional(),
  partyId: z.number().int(),
  mode: z.enum(['cash', 'bank_transfer', 'cheque', 'online']),
  accountId: z.number().int(),
  instrumentNo: z.string().trim().max(40).nullish(),
  drawerBank: z.string().trim().max(80).nullish(),
  amount: Amount,
  note: z.string().max(500).nullish(),
  allocations: z.array(Allocation).max(100).default([])
});

/** Validate and write allocations of a receipt to OGs of the same customer. */
async function allocate(c: Db, receiptId: string, partyId: number, available: bigint, allocs: z.infer<typeof Allocation>[], userId: number) {
  let total = 0n;
  const seen = new Set<number>();
  for (const a of allocs) {
    if (seen.has(a.ogId)) throw rule('An OG appears twice in the allocation');
    seen.add(a.ogId);
    const og = await maybeOne<{ customer_id: number; status: string; og_no: string; outstanding: string }>(
      c,
      `select o.customer_id, o.status, o.og_no, s.outstanding from ogs o join og_status s on s.og_id = o.id where o.id = $1 for update of o`,
      [a.ogId]
    );
    if (!og) throw notFound('OG');
    if (og.customer_id !== partyId) throw rule(`${og.og_no} belongs to a different customer`);
    if (og.status !== 'approved') throw rule(`${og.og_no} is not approved`);
    const amt = toPaisa(a.amount);
    if (amt > toPaisa(og.outstanding)) {
      throw rule(`Rs ${formatPkr(a.amount)} is more than the Rs ${formatPkr(og.outstanding)} outstanding on ${og.og_no}`);
    }
    total += amt;
    await c.query('insert into receipt_allocations(receipt_id, og_id, amount, created_by) values ($1,$2,$3,$4)', [receiptId, a.ogId, a.amount, userId]);
  }
  if (total > available) throw rule(`Allocations total Rs ${formatPkr(total)} but only Rs ${formatPkr(available)} is available`);
  return total;
}

export async function receiptRoutes(app: FastifyInstance) {
  const { config } = app.deps;

  app.get('/receipts', { preHandler: requirePerm('receipt.read') }, async (req) => {
    const q = z.object({ partyId: z.coerce.number().int().optional(), from: DateStr.optional(), to: DateStr.optional() }).parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `select r.id, r.receipt_no, r.business_date, r.party_id, p.name_en as party_name, r.mode, r.instrument_no, r.drawer_bank,
                r.amount, r.status, a.name as account_name, u.full_name as created_by_name, r.created_at,
                coalesce((select sum(x.amount) from receipt_allocations x where x.receipt_id = r.id and x.reversed_at is null),0) as allocated,
                case when r.status = 'returned' then 0
                     else r.amount - coalesce((select sum(x.amount) from receipt_allocations x where x.receipt_id = r.id and x.reversed_at is null),0)
                end as unallocated,
                je.entry_no
           from receipts r join parties p on p.id = r.party_id join accounts a on a.id = r.account_id
           join users u on u.id = r.created_by join journal_entries je on je.id = r.journal_entry_id
          where ($1::int is null or r.party_id = $1) and ($2::date is null or r.business_date >= $2) and ($3::date is null or r.business_date <= $3)
          order by r.business_date desc, r.id desc limit 500`,
        [q.partyId ?? null, q.from ?? null, q.to ?? null]
      )
    );
  });

  // Open OGs for the allocation panel, oldest first.
  app.get('/receipts/open-ogs', { preHandler: requirePerm('receipt.create') }, async (req) => {
    const { partyId } = z.object({ partyId: z.coerce.number().int() }).parse(req.query);
    return app.read(req, async (c) => {
      const ogs = await many(
        c,
        `select o.id, o.og_no, o.business_date, o.due_date, o.terms, s.total_value, s.paid, s.outstanding, s.payment, s.fulfilment,
                (select string_agg(distinct pr.name_en, ', ') from og_lines l join products pr on pr.id = l.product_id where l.og_id = o.id) as products
           from ogs o join og_status s on s.og_id = o.id
          where o.customer_id = $1 and o.status = 'approved' and s.outstanding > 0
          order by o.business_date, o.id`,
        [partyId]
      );
      const bal = await maybeOne<{ balance: string }>(c, 'select balance from party_receivables where party_id = $1', [partyId]);
      const unallocated = await one<{ s: string }>(
        c,
        `select coalesce(sum(r.amount - coalesce((select sum(x.amount) from receipt_allocations x where x.receipt_id = r.id and x.reversed_at is null),0)),0) as s
           from receipts r where r.party_id = $1 and r.status = 'posted'`,
        [partyId]
      );
      return { ogs, balance: bal?.balance ?? '0.00', unallocatedReceipts: unallocated.s };
    });
  });

  app.get('/receipts/check-instrument', { preHandler: requirePerm('receipt.create') }, async (req) => {
    const q = z.object({ no: z.string().trim().min(1), bank: z.string().optional() }).parse(req.query);
    return app.read(req, async (c) => {
      const rows = await many(
        c,
        `select r.receipt_no, r.business_date, r.status, r.drawer_bank, p.name_en as party_name, r.amount
           from receipts r join parties p on p.id = r.party_id
          where r.instrument_no = $1 and r.mode = 'cheque' order by r.business_date desc`,
        [q.no]
      );
      return { used: rows.length > 0, matches: rows };
    });
  });

  app.post('/receipts', { preHandler: requirePerm('receipt.create') }, async (req) => {
    const b = ReceiptInput.parse(req.body);
    if (b.mode !== 'cash' && !b.instrumentNo) throw rule('Enter the cheque or transaction reference');
    if (b.mode === 'cheque' && !b.drawerBank) throw rule('Enter the bank the cheque is drawn on');
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'receipts.create', async (c) => {
      const party = await maybeOne<{ name_en: string; kind: string; rep_user_id: number | null }>(
        c,
        'select name_en, kind, rep_user_id from parties where id = $1',
        [b.partyId]
      );
      if (!party) throw notFound('Party');
      const acct = await maybeOne<{ control: string | null; name: string }>(c, 'select control, name from accounts where id = $1', [b.accountId]);
      if (!acct || !['cash', 'bank'].includes(acct.control ?? '')) throw rule('Choose a cash or bank account to receive into');
      if (b.mode === 'cash' && acct.control !== 'cash') throw rule('Cash must be received into a cash account');
      if (b.mode !== 'cash' && acct.control !== 'bank') throw rule('Cheques and transfers must be received into a bank account');

      const fid = await firmId(c, config.FIRM_CODE);
      const receiptNo = (await one<{ n: string }>(c, "select next_doc_no('RV', $1) as n", [date])).n;
      const entry = await postEntry(c, {
        firmId: fid,
        businessDate: date,
        narration: `Receipt ${receiptNo} from ${party.name_en}${b.instrumentNo ? ` · ${b.mode.replace('_', ' ')} ${b.instrumentNo}` : ' · cash'}`,
        sourceType: 'receipt',
        sourceId: receiptNo,
        createdBy: req.user!.id,
        lines: [
          { accountId: b.accountId, debit: b.amount, memo: receiptNo },
          { accountId: await accountId(c, ACC.receivables), credit: b.amount, partyId: b.partyId, memo: receiptNo }
        ]
      });
      const r = await one<{ id: string }>(
        c,
        `insert into receipts(receipt_no, business_date, party_id, mode, account_id, instrument_no, drawer_bank, amount, journal_entry_id, note, created_by, rep_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [receiptNo, date, b.partyId, b.mode, b.accountId, b.instrumentNo ?? null, b.drawerBank ?? null, b.amount, entry.id, b.note ?? null, req.user!.id, party.rep_user_id]
      );
      const allocated = await allocate(c, r.id, b.partyId, toPaisa(b.amount), b.allocations, req.user!.id);
      const advance = toPaisa(b.amount) - allocated;
      await audit(c, req.user!.id, 'create', 'receipt', receiptNo, { party: b.partyId, amount: b.amount, mode: b.mode, allocations: b.allocations });
      for (const a of b.allocations) {
        await audit(c, req.user!.id, 'allocate', 'og', a.ogId, { receiptNo, amount: a.amount });
      }
      return { id: r.id, receiptNo, entryNo: entry.entryNo, allocated: fromPaisa(allocated), advance: fromPaisa(advance) };
    });
  });

  // Allocate an unallocated remainder (an advance) to OGs later.
  app.post('/receipts/:id/allocations', { preHandler: requirePerm('receipt.create') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const { allocations } = z.object({ allocations: z.array(Allocation).min(1) }).parse(req.body);
    return app.mutate(req, 'receipts.allocate', async (c) => {
      const r = await maybeOne<{ party_id: number; amount: string; status: string; receipt_no: string }>(
        c,
        'select party_id, amount, status, receipt_no from receipts where id = $1 for update',
        [id]
      );
      if (!r) throw notFound('Receipt');
      if (r.status !== 'posted') throw rule('This receipt was returned');
      const used = await one<{ s: string }>(c, 'select coalesce(sum(amount),0) as s from receipt_allocations where receipt_id = $1 and reversed_at is null', [id]);
      const available = toPaisa(r.amount) - toPaisa(used.s);
      const total = await allocate(c, id, r.party_id, available, allocations, req.user!.id);
      for (const a of allocations) await audit(c, req.user!.id, 'allocate', 'og', a.ogId, { receiptNo: r.receipt_no, amount: a.amount });
      return { id, allocated: fromPaisa(total), remaining: fromPaisa(available - total) };
    });
  });

  // A returned cheque reverses the receipt and its allocations; the OGs become unpaid again.
  app.post('/receipts/:id/return', { preHandler: requirePerm('cheque.return') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const b = z
      .object({ businessDate: DateStr.optional(), reason: z.string().trim().min(5), bankCharges: AmountOrZero.default('0.00') })
      .parse(req.body);
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'receipts.return', async (c) => {
      const r = await maybeOne<{ mode: string; status: string; receipt_no: string; journal_entry_id: string; party_id: number; account_id: number; instrument_no: string; amount: string }>(
        c,
        'select mode, status, receipt_no, journal_entry_id, party_id, account_id, instrument_no, amount from receipts where id = $1 for update',
        [id]
      );
      if (!r) throw notFound('Receipt');
      if (r.mode !== 'cheque') throw rule('Only cheque receipts can be returned');
      if (r.status !== 'posted') throw rule('This cheque has already been returned');
      const rev = await one<{ id: string }>(c, 'select reverse_entry($1, $2, $3, $4) as id', [
        r.journal_entry_id,
        req.user!.id,
        `Cheque ${r.instrument_no} returned: ${b.reason}`,
        date
      ]);
      let chargesEntry: string | null = null;
      if (toPaisa(b.bankCharges) > 0n) {
        // The bank debits its charge; it is passed on to the customer.
        const fid = await firmId(c, config.FIRM_CODE);
        const e = await postEntry(c, {
          firmId: fid,
          businessDate: date,
          narration: `Bank charges on returned cheque ${r.instrument_no}`,
          sourceType: 'cheque_return_charges',
          sourceId: r.receipt_no,
          createdBy: req.user!.id,
          lines: [
            { accountId: await accountId(c, ACC.receivables), debit: b.bankCharges, partyId: r.party_id, memo: `Cheque ${r.instrument_no} return charges` },
            { accountId: r.account_id, credit: b.bankCharges, memo: `Cheque ${r.instrument_no} return charges` }
          ]
        });
        chargesEntry = e.id;
      }
      const ret = await one<{ id: string; return_no: string }>(
        c,
        `insert into cheque_returns(return_no, receipt_id, business_date, reason, bank_charges, journal_entry_id, created_by)
         values (next_doc_no('CR', $1), $2, $1, $3, $4, $5, $6) returning id, return_no`,
        [date, id, b.reason, b.bankCharges, rev.id, req.user!.id]
      );
      const affected = await many<{ og_id: string; amount: string }>(
        c,
        `update receipt_allocations set reversed_at = now(), reversed_by_return_id = $2
          where receipt_id = $1 and reversed_at is null returning og_id, amount`,
        [id, ret.id]
      );
      await c.query("update receipts set status = 'returned' where id = $1", [id]);
      await audit(c, req.user!.id, 'cheque_return', 'receipt', r.receipt_no, { reason: b.reason, bankCharges: b.bankCharges, returnNo: ret.return_no });
      for (const a of affected) await audit(c, req.user!.id, 'allocation_reversed', 'og', a.og_id, { receiptNo: r.receipt_no, returnNo: ret.return_no, amount: a.amount });
      return { returnNo: ret.return_no, reversalEntryId: rev.id, chargesEntryId: chargesEntry, ogsAffected: affected.map((a) => a.og_id) };
    });
  });
}
