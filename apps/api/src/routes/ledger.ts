import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, rule } from '../lib/errors.js';
import { AmountOrZero, fromPaisa, toPaisa } from '../lib/money.js';
import { firmId, postEntry } from '../services/posting.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const ManualJournal = z.object({
  businessDate: DateStr.optional(),
  narration: z.string().trim().min(3).max(500),
  lines: z
    .array(
      z.object({
        accountId: z.number().int(),
        partyId: z.number().int().nullish(),
        branchId: z.number().int().nullish(),
        costCentreId: z.number().int().nullish(),
        debit: AmountOrZero.default('0.00'),
        credit: AmountOrZero.default('0.00'),
        memo: z.string().max(300).nullish()
      })
    )
    .min(2)
    .max(200)
});

export async function ledgerRoutes(app: FastifyInstance) {
  const { config } = app.deps;

  app.get('/journals', { preHandler: requirePerm('ledger.read') }, async (req) => {
    const q = z
      .object({ from: DateStr.optional(), to: DateStr.optional(), status: z.string().optional(), source: z.string().optional() })
      .parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `select e.id, e.entry_no, e.business_date, e.narration, e.source_type, e.source_id, e.status,
                e.reversal_of, e.reversed_by, e.created_at, cu.full_name as created_by_name, au.full_name as approved_by_name,
                (select sum(debit) from journal_lines l where l.entry_id = e.id) as amount
           from journal_entries e
           join users cu on cu.id = e.created_by
           left join users au on au.id = e.approved_by
          where ($1::date is null or e.business_date >= $1) and ($2::date is null or e.business_date <= $2)
            and ($3::text is null or e.status = $3) and ($4::text is null or e.source_type = $4)
          order by e.business_date desc, e.id desc limit 500`,
        [q.from ?? null, q.to ?? null, q.status ?? null, q.source ?? null]
      )
    );
  });

  app.get('/journals/:id', { preHandler: requirePerm('ledger.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.read(req, async (c) => {
      const e = await maybeOne(
        c,
        `select e.*, cu.full_name as created_by_name, au.full_name as approved_by_name,
                r.entry_no as reversal_of_no, rb.entry_no as reversed_by_no
           from journal_entries e join users cu on cu.id = e.created_by
           left join users au on au.id = e.approved_by
           left join journal_entries r on r.id = e.reversal_of
           left join journal_entries rb on rb.id = e.reversed_by
          where e.id = $1`,
        [id]
      );
      if (!e) throw notFound('Journal entry');
      const lines = await many(
        c,
        `select l.*, a.code as account_code, a.name as account_name, p.name_en as party_name, b.code as branch_code
           from journal_lines l join accounts a on a.id = l.account_id
           left join parties p on p.id = l.party_id left join branches b on b.id = l.branch_id
          where l.entry_id = $1 order by l.line_no`,
        [id]
      );
      return { ...e, lines };
    });
  });

  // Manual journals always need a second person to approve (maker-checker).
  app.post('/journals', { preHandler: requirePerm('journal.create') }, async (req) => {
    const b = ManualJournal.parse(req.body);
    let d = 0n;
    let cr = 0n;
    for (const l of b.lines) {
      const ld = toPaisa(l.debit);
      const lc = toPaisa(l.credit);
      if ((ld > 0n) === (lc > 0n)) throw rule('Each line needs either a debit or a credit, not both');
      d += ld;
      cr += lc;
    }
    if (d !== cr) throw rule('Debits and credits must be equal');
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'journals.create', async (c) => {
      const fid = await firmId(c, config.FIRM_CODE);
      const e = await postEntry(c, {
        firmId: fid,
        businessDate: date,
        narration: b.narration,
        sourceType: 'manual',
        createdBy: req.user!.id,
        status: 'pending_approval',
        lines: b.lines
      });
      await audit(c, req.user!.id, 'submit', 'journal', e.id, { narration: b.narration, date });
      return { id: e.id, status: 'pending_approval' };
    });
  });

  app.post('/journals/:id/approve', { preHandler: requirePerm('journal.approve') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { comment } = z.object({ comment: z.string().trim().min(1, 'A comment is required') }).parse(req.body);
    return app.mutate(req, 'journals.approve', async (c) => {
      const e = await maybeOne<{ status: string }>(c, 'select status from journal_entries where id = $1 for update', [id]);
      if (!e) throw notFound('Journal entry');
      if (e.status !== 'pending_approval') throw rule('This entry is not waiting for approval');
      const r = await one<{ entry_no: string }>(
        c,
        `update journal_entries set status = 'posted', approved_by = $2, approved_at = now() where id = $1 returning entry_no`,
        [id, req.user!.id]
      );
      await audit(c, req.user!.id, 'approve', 'journal', id, { comment, entryNo: r.entry_no });
      return { id, entryNo: r.entry_no };
    });
  });

  app.post('/journals/:id/reject', { preHandler: requirePerm('journal.approve') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { comment } = z.object({ comment: z.string().trim().min(1, 'A comment is required') }).parse(req.body);
    return app.mutate(req, 'journals.reject', async (c) => {
      const e = await maybeOne<{ status: string }>(c, 'select status from journal_entries where id = $1 for update', [id]);
      if (!e) throw notFound('Journal entry');
      if (e.status !== 'pending_approval') throw rule('This entry is not waiting for approval');
      await c.query("update journal_entries set status = 'draft' where id = $1", [id]);
      await audit(c, req.user!.id, 'reject', 'journal', id, { comment });
      return { id, status: 'draft' };
    });
  });

  // Any posted entry can be reversed, but only after a second person approves the request.
  app.post('/journals/:id/reversal-requests', { preHandler: requirePerm('reversal.request') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    return app.mutate(req, 'reversal.request', async (c) => {
      const e = await maybeOne<{ status: string; reversed_by: string | null; reversal_of: string | null; source_type: string }>(
        c,
        'select status, reversed_by, reversal_of, source_type from journal_entries where id = $1',
        [id]
      );
      if (!e) throw notFound('Journal entry');
      if (e.status !== 'posted' || e.reversed_by || e.reversal_of) throw rule('This entry cannot be reversed');
      if (['receipt', 'dispatch'].includes(e.source_type)) {
        throw rule('Receipts and dispatches are corrected from their own screens so stock and allocations stay in step');
      }
      const r = await one<{ id: string }>(
        c,
        'insert into reversal_requests(entry_id, reason, requested_by) values ($1,$2,$3) returning id',
        [id, reason, req.user!.id]
      );
      await audit(c, req.user!.id, 'request_reversal', 'journal', id, { reason, requestId: r.id });
      return { requestId: r.id };
    });
  });

  app.get('/trial-balance', { preHandler: requirePerm('ledger.read') }, async (req) => {
    const q = z.object({ asOf: DateStr.optional() }).parse(req.query);
    const asOf = q.asOf ?? app.today();
    return app.read(req, async (c) => {
      const rows = await many<{ debit: string; credit: string }>(
        c,
        `select a.id, a.code, a.name, a.type,
                coalesce(sum(p.debit),0) as debit, coalesce(sum(p.credit),0) as credit,
                coalesce(sum(p.debit - p.credit),0) as balance
           from accounts a join posted_lines p on p.account_id = a.id and p.business_date <= $1
          group by a.id order by a.code`,
        [asOf]
      );
      let td = 0n;
      let tc = 0n;
      for (const r of rows) {
        td += toPaisa(r.debit);
        tc += toPaisa(r.credit);
      }
      return { asOf, rows, totals: { debit: fromPaisa(td), credit: fromPaisa(tc), balanced: td === tc } };
    });
  });

  app.get('/accounts/:id/ledger', { preHandler: requirePerm('ledger.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ from: DateStr.optional(), to: DateStr.optional(), partyId: z.coerce.number().int().optional() }).parse(req.query);
    const from = q.from ?? '1900-01-01';
    const to = q.to ?? app.today();
    return app.read(req, async (c) => {
      const account = await maybeOne(c, 'select * from accounts where id = $1', [id]);
      if (!account) throw notFound('Account');
      const opening = await one<{ balance: string }>(
        c,
        `select coalesce(sum(debit - credit),0) as balance from posted_lines
          where account_id = $1 and business_date < $2 and ($3::int is null or party_id = $3)`,
        [id, from, q.partyId ?? null]
      );
      const lines = await many(
        c,
        `select pl.business_date, pl.entry_id, pl.entry_no, pl.narration, pl.memo, pl.source_type, pl.debit, pl.credit,
                p.name_en as party_name,
                $4::numeric + sum(pl.debit - pl.credit) over (order by pl.business_date, pl.entry_id, pl.line_no) as running
           from posted_lines pl left join parties p on p.id = pl.party_id
          where pl.account_id = $1 and pl.business_date between $2 and $3 and ($5::int is null or pl.party_id = $5)
          order by pl.business_date, pl.entry_id, pl.line_no`,
        [id, from, to, opening.balance, q.partyId ?? null]
      );
      return { account, from, to, opening: opening.balance, lines };
    });
  });
}
