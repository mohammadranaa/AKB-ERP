import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, rule } from '../lib/errors.js';

export async function approvalRoutes(app: FastifyInstance) {
  // Everything waiting for a decision that the signed-in user is allowed to make.
  app.get('/', { preHandler: requirePerm('og.approve', 'journal.approve', 'reversal.approve', 'stock.adjust.approve') }, async (req) =>
    app.read(req, async (c) => {
      const u = req.user!;
      const ogs = can(u, 'og.approve')
        ? await many(
            c,
            `select o.id, o.og_no, o.business_date, o.approval_reasons, o.submitted_at, p.name_en as customer_name, p.city,
                    s.total_value, s.bags, cu.full_name as requested_by, o.created_by
               from ogs o join parties p on p.id = o.customer_id join og_status s on s.og_id = o.id join users cu on cu.id = o.created_by
              where o.status = 'submitted' order by o.submitted_at`
          )
        : [];
      const journals = can(u, 'journal.approve')
        ? await many(
            c,
            `select e.id, e.business_date, e.narration, e.created_at, cu.full_name as requested_by, e.created_by,
                    (select sum(debit) from journal_lines l where l.entry_id = e.id) as amount
               from journal_entries e join users cu on cu.id = e.created_by
              where e.status = 'pending_approval' order by e.created_at`
          )
        : [];
      const reversals = can(u, 'reversal.approve')
        ? await many(
            c,
            `select r.id, r.reason, r.requested_at, cu.full_name as requested_by, r.requested_by as requested_by_id,
                    e.id as entry_id, e.entry_no, e.narration, e.business_date,
                    (select sum(debit) from journal_lines l where l.entry_id = e.id) as amount
               from reversal_requests r join journal_entries e on e.id = r.entry_id join users cu on cu.id = r.requested_by
              where r.status = 'pending' order by r.requested_at`
          )
        : [];
      const adjustments = can(u, 'stock.adjust.approve')
        ? await many(
            c,
            `select a.id, a.adj_no, a.business_date, a.bags, a.reason, a.requested_at, a.requested_by as requested_by_id,
                    cu.full_name as requested_by, b.code as branch_code, pr.name_en as product_name
               from stock_adjustments a join users cu on cu.id = a.requested_by join branches b on b.id = a.branch_id
               join products pr on pr.id = a.product_id
              where a.status = 'pending' order by a.requested_at`
          )
        : [];
      return { ogs, journals, reversals, adjustments };
    })
  );

  app.post('/reversals/:id/decide', { preHandler: requirePerm('reversal.approve') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ approve: z.boolean(), note: z.string().trim().min(1, 'A comment is required') }).parse(req.body);
    return app.mutate(req, 'reversals.decide', async (c) => {
      const r = await maybeOne<{ entry_id: string; status: string; reason: string }>(
        c,
        'select entry_id, status, reason from reversal_requests where id = $1 for update',
        [id]
      );
      if (!r) throw notFound('Reversal request');
      if (r.status !== 'pending') throw rule('This request has already been decided');
      let reversalId: string | null = null;
      if (b.approve) {
        reversalId = (await one<{ id: string }>(c, 'select reverse_entry($1, $2, $3, $4) as id', [r.entry_id, req.user!.id, r.reason, app.today()])).id;
      }
      await c.query(
        'update reversal_requests set status=$2, decided_by=$3, decided_at=now(), decision_note=$4, reversal_entry_id=$5 where id=$1',
        [id, b.approve ? 'approved' : 'rejected', req.user!.id, b.note, reversalId]
      );
      await audit(c, req.user!.id, b.approve ? 'approve' : 'reject', 'reversal_request', id, { entryId: r.entry_id, reversalId, note: b.note });
      return { id, status: b.approve ? 'approved' : 'rejected', reversalEntryId: reversalId };
    });
  });
}
