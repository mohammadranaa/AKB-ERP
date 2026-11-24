import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, rule } from '../lib/errors.js';
import { Amount, AmountOrZero, fromPaisa, toPaisa } from '../lib/money.js';
import { ACC, accountId, firmId, postEntry } from '../services/posting.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Payment modes used with the companies and banks (finance questionnaire, Nov 2026). */
export const MODES = ['cash', 'cheque', 'online', 'bg_adj', 'dd', 'cds', 'cpr', 'dcf', 'dcf_adj'] as const;
const NEEDS_REFERENCE = new Set(['cheque', 'online', 'dd', 'cds', 'cpr']);

const Attachment = z.object({
  mime: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  data: z.string().min(100).max(4_300_000) // base64, about 3 MB
});

const VoucherLine = z.object({
  accountId: z.number().int(),
  amount: Amount,
  partyId: z.number().int().nullish(),
  branchId: z.number().int().nullish(),
  memo: z.string().trim().max(200).nullish()
});

const VoucherInput = z.object({
  kind: z.enum(['payment', 'receipt']),
  businessDate: DateStr.optional(),
  moneyAccountId: z.number().int(),
  mode: z.enum(MODES),
  referenceNo: z.string().trim().max(60).nullish(),
  /** Paid to / received from. Payable and receivable lines default to this party. */
  partyId: z.number().int().nullish(),
  narration: z.string().trim().min(3).max(500),
  lines: z.array(VoucherLine).min(1).max(50),
  /** Payments to a company can be allocated to its orders (an advance if the order is not yet invoiced). */
  allocations: z.array(z.object({ companyOrderId: z.number().int(), amount: Amount })).max(50).default([]),
  attachment: Attachment.nullish()
});

const OpeningInput = z.object({
  businessDate: DateStr,
  narration: z.string().trim().min(3).max(500),
  lines: z
    .array(
      z.object({
        accountId: z.number().int(),
        partyId: z.number().int().nullish(),
        branchId: z.number().int().nullish(),
        debit: AmountOrZero.default('0.00'),
        credit: AmountOrZero.default('0.00'),
        memo: z.string().trim().max(200).nullish()
      })
    )
    .min(1)
    .max(500),
  /** Put any difference to Opening equity (3300) instead of refusing an unbalanced voucher. */
  balanceToEquity: z.boolean().default(false)
});

/** Decode an upload and confirm the bytes really are the type claimed. */
export function decodeAttachment(a: z.infer<typeof Attachment>): Buffer {
  const buf = Buffer.from(a.data, 'base64');
  if (buf.length === 0 || buf.length > 3 * 1024 * 1024) throw rule('The proof file must be under 3 MB');
  const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
  const pdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const ok =
    (a.mime === 'image/jpeg' && jpeg) || (a.mime === 'image/png' && png) || (a.mime === 'image/webp' && webp) || (a.mime === 'application/pdf' && pdf);
  if (!ok) throw rule('The proof file is not a valid image or PDF');
  return buf;
}

async function saveAttachment(c: Db, voucherId: string, a: z.infer<typeof Attachment>, userId: number) {
  const buf = decodeAttachment(a);
  const r = await one<{ id: string }>(
    c,
    `insert into voucher_attachments(voucher_id, mime, bytes, size, sha256, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [voucherId, a.mime, buf, buf.length, createHash('sha256').update(buf).digest('hex'), userId]
  );
  return r.id;
}

interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: string;
  control: string | null;
  postable: boolean;
  active: boolean;
  parent_code: string | null;
}

async function loadAccount(c: Db, id: number): Promise<AccountRow> {
  const a = await maybeOne<AccountRow>(
    c,
    `select a.id, a.code, a.name, a.type, a.control, a.postable, a.active, p.code as parent_code
       from accounts a left join accounts p on p.id = a.parent_id where a.id = $1`,
    [id]
  );
  if (!a) throw notFound('Account');
  if (!a.postable || !a.active) throw rule(`${a.code} ${a.name} is not open for entries`);
  return a;
}

async function allocateToOrders(
  c: Db,
  voucherId: string,
  supplierId: number | null,
  available: bigint,
  allocs: { companyOrderId: number; amount: string }[],
  userId: number
) {
  if (allocs.length === 0) return;
  if (!supplierId) throw rule('Choose the company paid before allocating to its orders');
  let total = 0n;
  const seen = new Set<number>();
  for (const a of allocs) {
    if (seen.has(a.companyOrderId)) throw rule('An order appears twice in the allocations');
    seen.add(a.companyOrderId);
    total += toPaisa(a.amount);
  }
  if (total > available) throw rule('Allocations are more than the payment');
  for (const a of allocs) {
    await c.query(
      'insert into company_payment_allocations(voucher_id, company_order_id, amount, created_by) values ($1,$2,$3,$4)',
      [voucherId, a.companyOrderId, a.amount, userId]
    );
  }
}

export async function voucherRoutes(app: FastifyInstance) {
  const { config } = app.deps;
  app.get('/vouchers', { preHandler: requirePerm('voucher.create', 'ledger.read') }, async (req) => {
    const q = z
      .object({ kind: z.enum(['payment', 'receipt']).optional(), from: DateStr.optional(), to: DateStr.optional(), partyId: z.coerce.number().int().optional() })
      .parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `select v.id, v.kind, v.business_date, v.mode, v.reference_no, v.narration, v.amount, v.party_id,
                p.name_en as party_name, a.code as money_account_code, a.name as money_account_name,
                e.id as entry_id, e.entry_no, e.reversed_by is not null as reversed, u.full_name as created_by_name,
                (select count(*) from voucher_attachments x where x.voucher_id = v.id)::int as attachments,
                (select coalesce(sum(amount),0) from company_payment_allocations x where x.voucher_id = v.id) as allocated
           from cash_vouchers v join accounts a on a.id = v.money_account_id join journal_entries e on e.id = v.journal_entry_id
           left join parties p on p.id = v.party_id join users u on u.id = v.created_by
          where ($1::text is null or v.kind = $1) and ($2::date is null or v.business_date >= $2)
            and ($3::date is null or v.business_date <= $3) and ($4::int is null or v.party_id = $4)
          order by v.business_date desc, v.id desc limit 500`,
        [q.kind ?? null, q.from ?? null, q.to ?? null, q.partyId ?? null]
      )
    );
  });

  app.get('/vouchers/:id', { preHandler: requirePerm('voucher.create', 'ledger.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.read(req, async (c) => {
      const v = await maybeOne(
        c,
        `select v.*, p.name_en as party_name, p.kind as party_kind, a.code as money_account_code, a.name as money_account_name,
                e.entry_no, e.reversed_by is not null as reversed, rb.entry_no as reversed_by_no, u.full_name as created_by_name
           from cash_vouchers v join accounts a on a.id = v.money_account_id join journal_entries e on e.id = v.journal_entry_id
           left join journal_entries rb on rb.id = e.reversed_by
           left join parties p on p.id = v.party_id join users u on u.id = v.created_by where v.id = $1`,
        [id]
      );
      if (!v) throw notFound('Voucher');
      const lines = await many(
        c,
        `select l.line_no, l.debit, l.credit, l.memo, a.id as account_id, a.code as account_code, a.name as account_name,
                p.name_en as party_name, b.code as branch_code
           from journal_lines l join accounts a on a.id = l.account_id left join parties p on p.id = l.party_id
           left join branches b on b.id = l.branch_id where l.entry_id = $1 order by l.line_no`,
        [v.journal_entry_id]
      );
      const attachments = await many(
        c, 'select id, mime, size, created_at from voucher_attachments where voucher_id = $1 order by id', [id]);
      const allocations = await many(
        c,
        `select x.id, x.amount, o.id as company_order_id, o.order_no, o.company_order_no
           from company_payment_allocations x join company_orders o on o.id = x.company_order_id where x.voucher_id = $1 order by x.id`,
        [id]
      );
      return { ...v, lines, attachments, allocations };
    });
  });

  app.get('/vouchers/:id/attachments/:attId', { preHandler: requirePerm('voucher.create', 'ledger.read') }, async (req, reply) => {
    const { id, attId } = z.object({ id: z.coerce.number().int(), attId: z.coerce.number().int() }).parse(req.params);
    const f = await app.read(req, (c) =>
      maybeOne<{ mime: string; bytes: Buffer }>(c, 'select mime, bytes from voucher_attachments where id = $1 and voucher_id = $2', [attId, id])
    );
    if (!f) throw notFound('Attachment');
    return reply
      .header('content-type', f.mime)
      .header('content-disposition', 'inline')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=86400')
      .send(f.bytes);
  });

  // CPV / CRV. Posted at once: a payment credits the cash/bank account and debits the lines;
  // a receipt debits the cash/bank account and credits the lines.
  app.post('/vouchers', { preHandler: requirePerm('voucher.create'), bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const b = VoucherInput.parse(req.body);
    const date = b.businessDate ?? app.today();
    if (NEEDS_REFERENCE.has(b.mode) && !b.referenceNo) throw rule('Enter the cheque, transaction or instrument number');
    if (b.kind === 'receipt' && b.allocations.length) throw rule('Only payments to companies are allocated to orders');
    return app.mutate(req, 'vouchers.create', async (c) => {
      const money = await loadAccount(c, b.moneyAccountId);
      const isFacility = money.type === 'liability' && money.parent_code === '2200';
      if (!(money.control === 'cash' || money.control === 'bank' || isFacility)) {
        throw rule('Pay from or into a cash account, a bank account or a bank facility (DCF)');
      }
      if ((b.mode === 'cash') !== (money.control === 'cash')) {
        throw rule(b.mode === 'cash' ? 'A cash voucher must use a cash account' : 'A cash account can only be used with the cash mode');
      }
      let party: { id: number; kind: string; name_en: string } | null = null;
      if (b.partyId) {
        party = await maybeOne(c, 'select id, kind, name_en from parties where id = $1', [b.partyId]);
        if (!party) throw notFound('Party');
      }
      let total = 0n;
      const lines = [];
      for (const l of b.lines) {
        const a = await loadAccount(c, l.accountId);
        if (a.id === money.id) throw rule('A line cannot use the same account the money comes from or goes to');
        let partyId = l.partyId ?? null;
        if (a.control === 'receivable' || a.control === 'payable') {
          partyId = partyId ?? party?.id ?? null;
          if (!partyId) throw rule(`${a.code} ${a.name} needs a party on the line`);
          if (b.kind === 'receipt' && a.control === 'receivable') {
            const k = await one<{ kind: string }>(c, 'select kind from parties where id = $1', [partyId]);
            if (k.kind === 'customer') throw rule('Money from customers is recorded on the Receipts screen, so it can be matched to their OGs');
          }
        } else if (partyId) {
          throw rule(`${a.code} ${a.name} does not keep balances by party; leave the party empty on that line`);
        }
        total += toPaisa(l.amount);
        lines.push({
          accountId: a.id,
          partyId,
          branchId: l.branchId ?? null,
          memo: l.memo ?? null,
          [b.kind === 'payment' ? 'debit' : 'credit']: l.amount
        });
      }
      const amount = fromPaisa(total);
      const fid = await firmId(c, config.FIRM_CODE);
      const ref = b.referenceNo ? ` (${b.mode.toUpperCase()} ${b.referenceNo})` : '';
      const entry = await postEntry(c, {
        firmId: fid,
        businessDate: date,
        narration: `${b.narration}${ref}`,
        sourceType: b.kind === 'payment' ? 'payment_voucher' : 'receipt_voucher',
        createdBy: req.user!.id,
        lines: [
          ...lines,
          { accountId: money.id, [b.kind === 'payment' ? 'credit' : 'debit']: amount, memo: party ? party.name_en : null }
        ]
      });
      const v = await one<{ id: string }>(
        c,
        `insert into cash_vouchers(kind, business_date, money_account_id, mode, reference_no, party_id, narration, amount, journal_entry_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [b.kind, date, money.id, b.mode, b.referenceNo ?? null, party?.id ?? null, b.narration, amount, entry.id, req.user!.id]
      );
      if (b.allocations.length) {
        if (party?.kind !== 'supplier') throw rule('Only payments to a company can be allocated to company orders');
        await allocateToOrders(c, v.id, party.id, total, b.allocations, req.user!.id);
      }
      if (b.attachment) await saveAttachment(c, v.id, b.attachment, req.user!.id);
      await audit(c, req.user!.id, 'create', b.kind === 'payment' ? 'payment_voucher' : 'receipt_voucher', v.id, {
        entryNo: entry.entryNo, amount, mode: b.mode, referenceNo: b.referenceNo, partyId: party?.id, allocations: b.allocations,
        attachment: !!b.attachment
      });
      return { id: v.id, entryNo: entry.entryNo, amount };
    });
  });

  // Proof added after the voucher (the IBFT screenshot often arrives later).
  app.post('/vouchers/:id/attachments', { preHandler: requirePerm('voucher.create'), bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const a = Attachment.parse(req.body);
    return app.mutate(req, 'vouchers.attach', async (c) => {
      const v = await maybeOne(c, 'select id from cash_vouchers where id = $1', [id]);
      if (!v) throw notFound('Voucher');
      const attId = await saveAttachment(c, String(id), a, req.user!.id);
      await audit(c, req.user!.id, 'attach', 'voucher', id, { mime: a.mime });
      return { id: attId };
    });
  });

  // Allocate (more of) an earlier payment to company orders.
  app.post('/vouchers/:id/allocations', { preHandler: requirePerm('voucher.create') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { allocations } = z
      .object({ allocations: z.array(z.object({ companyOrderId: z.number().int(), amount: Amount })).min(1).max(50) })
      .parse(req.body);
    return app.mutate(req, 'vouchers.allocate', async (c) => {
      const v = await maybeOne<{ kind: string; party_id: number | null; amount: string }>(c, 'select * from cash_vouchers where id = $1', [id]);
      if (!v) throw notFound('Voucher');
      if (v.kind !== 'payment') throw rule('Only payments to companies are allocated to orders');
      const used = await one<{ s: string }>(c, 'select coalesce(sum(amount),0) as s from company_payment_allocations where voucher_id = $1', [id]);
      await allocateToOrders(c, String(id), v.party_id, toPaisa(v.amount) - toPaisa(used.s), allocations, req.user!.id);
      await audit(c, req.user!.id, 'allocate', 'payment_voucher', id, { allocations });
      return { id };
    });
  });

  // Opening balances (OPV). Waits for a second person to approve, on the Approvals screen.
  app.post('/vouchers/opening', { preHandler: requirePerm('opening.create') }, async (req) => {
    const b = OpeningInput.parse(req.body);
    return app.mutate(req, 'opening.create', async (c) => {
      let d = 0n;
      let cr = 0n;
      const lines = [];
      for (const l of b.lines) {
        const ld = toPaisa(l.debit);
        const lc = toPaisa(l.credit);
        if ((ld > 0n) === (lc > 0n)) throw rule('Each line needs either a debit or a credit, not both');
        const a = await loadAccount(c, l.accountId);
        if ((a.control === 'receivable' || a.control === 'payable') && !l.partyId) {
          throw rule(`${a.code} ${a.name} needs a party on each line`);
        }
        d += ld;
        cr += lc;
        lines.push({ accountId: a.id, partyId: l.partyId ?? null, branchId: l.branchId ?? null, debit: l.debit, credit: l.credit, memo: l.memo ?? null });
      }
      if (d !== cr) {
        if (!b.balanceToEquity) {
          throw rule(`Debits ${fromPaisa(d)} and credits ${fromPaisa(cr)} differ by ${fromPaisa(d > cr ? d - cr : cr - d)}`);
        }
        const eq = await accountId(c, ACC.openingEquity);
        lines.push(
          d > cr
            ? { accountId: eq, partyId: null, branchId: null, debit: '0.00', credit: fromPaisa(d - cr), memo: 'Balancing figure' }
            : { accountId: eq, partyId: null, branchId: null, debit: fromPaisa(cr - d), credit: '0.00', memo: 'Balancing figure' }
        );
      }
      const fid = await firmId(c, config.FIRM_CODE);
      const e = await postEntry(c, {
        firmId: fid,
        businessDate: b.businessDate,
        narration: b.narration,
        sourceType: 'opening',
        createdBy: req.user!.id,
        status: 'pending_approval',
        lines
      });
      await audit(c, req.user!.id, 'submit', 'opening_voucher', e.id, { date: b.businessDate, lines: lines.length });
      return { id: e.id, status: 'pending_approval' };
    });
  });
}
