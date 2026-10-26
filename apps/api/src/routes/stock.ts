import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, rule } from '../lib/errors.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function move(
  c: Db,
  m: { date: string; kind: string; productId: number; branchId: number; bags: number; refType: string; refId: string; note?: string | null; userId: number }
) {
  await c.query(
    `insert into stock_movements(business_date, kind, product_id, branch_id, bags, ref_type, ref_id, note, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [m.date, m.kind, m.productId, m.branchId, m.bags, m.refType, m.refId, m.note ?? null, m.userId]
  );
}
export { move as recordMovement };

function assertBranch(user: { branchIds: number[] | null }, branchId: number) {
  if (user.branchIds && !user.branchIds.includes(branchId)) throw forbidden('You are not assigned to this branch');
}

export async function stockRoutes(app: FastifyInstance) {
  // Product × branch matrix. Every figure is computed from movements and OGs.
  app.get('/matrix', { preHandler: requirePerm('stock.read') }, async (req) =>
    app.read(req, async (c) => {
      const cells = await many(
        c,
        `with oh as (select product_id, branch_id, bags from stock_on_hand),
              cm as (select product_id, branch_id, sum(bags)::bigint as bags from stock_committed group by product_id, branch_id)
         select p.id as product_id, b.id as branch_id,
                coalesce(oh.bags,0)::bigint as on_hand,
                coalesce(cm.bags,0)::bigint as committed,
                (coalesce(oh.bags,0) - coalesce(cm.bags,0))::bigint as available,
                greatest(coalesce(cm.bags,0) - coalesce(oh.bags,0), 0)::bigint as unpurchased
           from products p cross join branches b
           left join oh on oh.product_id = p.id and oh.branch_id = b.id
           left join cm on cm.product_id = p.id and cm.branch_id = b.id
          where p.active and b.active and b.kind = 'godown'
          order by p.manufacturer, p.name_en, b.code`
      );
      const products = await many(c, 'select id, code, name_en, name_ur, manufacturer, bag_kg from products where active order by manufacturer, name_en');
      const branches = await many(c, "select id, code, name_en, name_ur from branches where active and kind = 'godown' order by code");
      return { products, branches, cells };
    })
  );

  app.get('/movements', { preHandler: requirePerm('stock.read') }, async (req) => {
    const q = z.object({ productId: z.coerce.number().int(), branchId: z.coerce.number().int() }).parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `select m.id, m.business_date, m.kind, m.bags, m.ref_type, m.ref_id, m.note, m.created_at, u.full_name as created_by_name,
                sum(m.bags) over (order by m.business_date, m.id) as running
           from stock_movements m join users u on u.id = m.created_by
          where m.product_id = $1 and m.branch_id = $2
          order by m.business_date, m.id`,
        [q.productId, q.branchId]
      )
    );
  });

  // ---------------- Goods receipts ----------------
  const GR = z.object({
    businessDate: DateStr.optional(),
    branchId: z.number().int(),
    supplierId: z.number().int().nullish(),
    companyOrderRef: z.string().trim().max(60).nullish(),
    truckNo: z.string().trim().max(30).nullish(),
    note: z.string().max(500).nullish(),
    lines: z
      .array(
        z.object({
          productId: z.number().int(),
          bagsReceived: z.number().int().positive(),
          bagsShort: z.number().int().min(0).default(0),
          bagsDamaged: z.number().int().min(0).default(0)
        })
      )
      .min(1)
  });

  app.post('/goods-receipts', { preHandler: requirePerm('stock.receive') }, async (req) => {
    const b = GR.parse(req.body);
    assertBranch(req.user!, b.branchId);
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'goods-receipts.create', async (c) => {
      const gr = await one<{ id: string; gr_no: string }>(
        c,
        `insert into goods_receipts(gr_no, business_date, branch_id, supplier_id, company_order_ref, truck_no, note, created_by)
         values (next_doc_no('GR',$1),$1,$2,$3,$4,$5,$6,$7) returning id, gr_no`,
        [date, b.branchId, b.supplierId ?? null, b.companyOrderRef ?? null, b.truckNo ?? null, b.note ?? null, req.user!.id]
      );
      for (const l of b.lines) {
        if (l.bagsDamaged > l.bagsReceived) throw rule('Damaged bags cannot exceed bags received');
        await c.query(
          'insert into goods_receipt_lines(gr_id, product_id, bags_received, bags_short, bags_damaged) values ($1,$2,$3,$4,$5)',
          [gr.id, l.productId, l.bagsReceived, l.bagsShort, l.bagsDamaged]
        );
        await move(c, { date, kind: 'receipt', productId: l.productId, branchId: b.branchId, bags: l.bagsReceived, refType: 'goods_receipt', refId: gr.gr_no, note: b.companyOrderRef ?? null, userId: req.user!.id });
        if (l.bagsDamaged > 0) {
          // Damaged bags are received, then held back as an adjustment request for approval.
          await c.query(
            `insert into stock_adjustments(adj_no, business_date, branch_id, product_id, bags, reason, requested_by)
             values (next_doc_no('ADJ',$1),$1,$2,$3,$4,$5,$6)`,
            [date, b.branchId, l.productId, -l.bagsDamaged, `Damaged on arrival (${gr.gr_no})`, req.user!.id]
          );
        }
      }
      await audit(c, req.user!.id, 'create', 'goods_receipt', gr.gr_no, b);
      return { id: gr.id, grNo: gr.gr_no };
    });
  });

  app.get('/goods-receipts', { preHandler: requirePerm('stock.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select g.*, b.code as branch_code, p.name_en as supplier_name, u.full_name as created_by_name,
                (select sum(bags_received) from goods_receipt_lines l where l.gr_id = g.id)::bigint as bags
           from goods_receipts g join branches b on b.id = g.branch_id
           left join parties p on p.id = g.supplier_id join users u on u.id = g.created_by
          order by g.business_date desc, g.id desc limit 300`
      )
    )
  );

  // ---------------- Transfers ----------------
  const Transfer = z.object({
    businessDate: DateStr.optional(),
    fromBranchId: z.number().int(),
    toBranchId: z.number().int(),
    truckNo: z.string().trim().max(30).nullish(),
    lines: z.array(z.object({ productId: z.number().int(), bags: z.number().int().positive() })).min(1)
  });

  app.post('/transfers', { preHandler: requirePerm('stock.transfer') }, async (req) => {
    const b = Transfer.parse(req.body);
    assertBranch(req.user!, b.fromBranchId);
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'transfers.create', async (c) => {
      const t = await one<{ id: string; transfer_no: string }>(
        c,
        `insert into stock_transfers(transfer_no, business_date, from_branch_id, to_branch_id, truck_no, created_by)
         values (next_doc_no('TRF',$1),$1,$2,$3,$4,$5) returning id, transfer_no`,
        [date, b.fromBranchId, b.toBranchId, b.truckNo ?? null, req.user!.id]
      );
      for (const l of b.lines) {
        await c.query('insert into stock_transfer_lines(transfer_id, product_id, bags) values ($1,$2,$3)', [t.id, l.productId, l.bags]);
        await move(c, { date, kind: 'transfer_out', productId: l.productId, branchId: b.fromBranchId, bags: -l.bags, refType: 'transfer', refId: t.transfer_no, userId: req.user!.id });
      }
      await audit(c, req.user!.id, 'send', 'transfer', t.transfer_no, b);
      return { id: t.id, transferNo: t.transfer_no };
    });
  });

  app.post('/transfers/:id/receive', { preHandler: requirePerm('stock.transfer') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { businessDate } = z.object({ businessDate: DateStr.optional() }).parse(req.body ?? {});
    const date = businessDate ?? app.today();
    return app.mutate(req, 'transfers.receive', async (c) => {
      const t = await maybeOne<{ transfer_no: string; to_branch_id: number; status: string }>(
        c,
        'select transfer_no, to_branch_id, status from stock_transfers where id = $1 for update',
        [id]
      );
      if (!t) throw notFound('Transfer');
      assertBranch(req.user!, t.to_branch_id);
      if (t.status !== 'in_transit') throw rule('This transfer has already been received');
      const lines = await many<{ product_id: number; bags: number }>(c, 'select product_id, bags from stock_transfer_lines where transfer_id = $1', [id]);
      for (const l of lines) {
        await move(c, { date, kind: 'transfer_in', productId: l.product_id, branchId: t.to_branch_id, bags: l.bags, refType: 'transfer', refId: t.transfer_no, userId: req.user!.id });
      }
      await c.query("update stock_transfers set status='received', received_by=$2, received_at=now(), received_date=$3 where id=$1", [id, req.user!.id, date]);
      await audit(c, req.user!.id, 'receive', 'transfer', t.transfer_no);
      return { id, status: 'received' };
    });
  });

  app.get('/transfers', { preHandler: requirePerm('stock.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select t.*, fb.code as from_code, tb.code as to_code,
                (select sum(bags) from stock_transfer_lines l where l.transfer_id = t.id)::bigint as bags
           from stock_transfers t join branches fb on fb.id = t.from_branch_id join branches tb on tb.id = t.to_branch_id
          order by t.business_date desc, t.id desc limit 300`
      )
    )
  );

  // ---------------- Adjustments (always need a second person) ----------------
  app.post('/adjustments', { preHandler: requirePerm('stock.adjust.request') }, async (req) => {
    const b = z
      .object({
        businessDate: DateStr.optional(),
        branchId: z.number().int(),
        productId: z.number().int(),
        bags: z.number().int().refine((n) => n !== 0, 'Bags cannot be zero'),
        reason: z.string().trim().min(5)
      })
      .parse(req.body);
    assertBranch(req.user!, b.branchId);
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'adjustments.request', async (c) => {
      const r = await one<{ id: string; adj_no: string }>(
        c,
        `insert into stock_adjustments(adj_no, business_date, branch_id, product_id, bags, reason, requested_by)
         values (next_doc_no('ADJ',$1),$1,$2,$3,$4,$5,$6) returning id, adj_no`,
        [date, b.branchId, b.productId, b.bags, b.reason, req.user!.id]
      );
      await audit(c, req.user!.id, 'request', 'stock_adjustment', r.adj_no, b);
      return { id: r.id, adjNo: r.adj_no };
    });
  });

  app.post('/adjustments/:id/decide', { preHandler: requirePerm('stock.adjust.approve') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z.object({ approve: z.boolean(), note: z.string().trim().min(1, 'A comment is required') }).parse(req.body);
    return app.mutate(req, 'adjustments.decide', async (c) => {
      const a = await maybeOne<{ adj_no: string; status: string; branch_id: number; product_id: number; bags: number }>(
        c,
        'select adj_no, status, branch_id, product_id, bags from stock_adjustments where id = $1 for update',
        [id]
      );
      if (!a) throw notFound('Adjustment');
      if (a.status !== 'pending') throw rule('This adjustment has already been decided');
      await c.query('update stock_adjustments set status=$2, decided_by=$3, decided_at=now(), decision_note=$4 where id=$1', [
        id,
        b.approve ? 'approved' : 'rejected',
        req.user!.id,
        b.note
      ]);
      if (b.approve) {
        await move(c, { date: app.today(), kind: 'adjustment', productId: a.product_id, branchId: a.branch_id, bags: a.bags, refType: 'adjustment', refId: a.adj_no, note: b.note, userId: req.user!.id });
      }
      await audit(c, req.user!.id, b.approve ? 'approve' : 'reject', 'stock_adjustment', a.adj_no, { note: b.note });
      return { id, status: b.approve ? 'approved' : 'rejected' };
    });
  });
}
