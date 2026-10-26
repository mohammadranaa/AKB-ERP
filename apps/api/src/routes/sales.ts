import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, rule } from '../lib/errors.js';
import { AmountOrZero, Amount, fromPaisa, toPaisa, formatPkr } from '../lib/money.js';
import { ACC, accountId, firmId, postEntry, type PostingLine } from '../services/posting.js';
import { customerExposure } from './masters.js';
import { recordMovement } from './stock.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const OgInput = z.object({
  businessDate: DateStr.optional(),
  customerId: z.number().int(),
  branchId: z.number().int(),
  terms: z.enum(['cbd', 'credit', 'loan']),
  advancePct: z.number().min(0).max(100).default(0),
  creditDays: z.number().int().min(0).max(365).optional(),
  freightBy: z.enum(['customer', 'akb']).default('customer'),
  freightPerBag: AmountOrZero.default('0.00'),
  discount: AmountOrZero.default('0.00'),
  note: z.string().max(500).nullish(),
  lines: z
    .array(z.object({ productId: z.number().int(), bags: z.number().int().positive(), rate: Amount }))
    .min(1)
    .max(50)
});
type OgInput = z.infer<typeof OgInput>;

interface Checks {
  totalValue: string;
  bags: number;
  reasons: string[];
  needsApproval: boolean;
  unpurchasedBags: number;
  lines: { productId: number; bags: number; rate: string; floorPrice: string | null; belowFloor: boolean; available: number; unpurchased: number }[];
  credit: { limit: string; balance: string; undispatched: string; after: string; overBy: string } | null;
}

/** Credit-limit, floor-price and stock checks for an OG, excluding the OG itself when it is already saved. */
async function computeChecks(c: Db, o: OgInput, excludeOgId: string | null): Promise<Checks> {
  const customer = await maybeOne<{ id: number; kind: string; credit_limit: string; active: boolean }>(
    c,
    'select id, kind, credit_limit, active from parties where id = $1',
    [o.customerId]
  );
  if (!customer || customer.kind !== 'customer') throw notFound('Customer');
  if (!customer.active) throw rule('This customer is inactive');

  let goods = 0n;
  let bags = 0;
  const reasons: string[] = [];
  // Stock check per product (several lines can be the same product).
  const wanted = new Map<number, number>();
  for (const l of o.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.bags);
  const avail = new Map<number, number>();
  for (const pid of wanted.keys()) {
    const r = await one<{ available: string }>(
      c,
      `select (coalesce((select bags from stock_on_hand where product_id = $1 and branch_id = $2),0)
             - coalesce((select sum(sc.bags) from stock_committed sc where sc.product_id = $1 and sc.branch_id = $2
                          and sc.og_line_id not in (select id from og_lines where og_id = coalesce($3::bigint, -1))),0)) as available`,
      [pid, o.branchId, excludeOgId]
    );
    avail.set(pid, Number(r.available));
  }
  const left = new Map(avail);
  const lines: Checks['lines'] = [];
  for (const l of o.lines) {
    const p = await maybeOne<{ floor_price: string | null; name_en: string; active: boolean }>(
      c,
      'select floor_price, name_en, active from products where id = $1',
      [l.productId]
    );
    if (!p) throw notFound('Product');
    if (!p.active) throw rule(`${p.name_en} is inactive`);
    goods += toPaisa(l.rate) * BigInt(l.bags);
    bags += l.bags;
    const below = p.floor_price !== null && toPaisa(l.rate) < toPaisa(p.floor_price);
    if (below) reasons.push(`${p.name_en} at Rs ${formatPkr(l.rate)} is below the floor price of Rs ${formatPkr(p.floor_price!)}`);
    const a = Math.max(0, left.get(l.productId) ?? 0);
    const unp = Math.max(0, l.bags - a);
    left.set(l.productId, (left.get(l.productId) ?? 0) - l.bags);
    lines.push({ productId: l.productId, bags: l.bags, rate: l.rate, floorPrice: p.floor_price, belowFloor: below, available: avail.get(l.productId) ?? 0, unpurchased: unp });
  }
  const freight = o.freightBy === 'customer' ? toPaisa(o.freightPerBag) * BigInt(bags) : 0n;
  const total = goods + freight - toPaisa(o.discount);
  if (total <= 0n) throw rule('The OG total must be greater than zero');

  let credit: Checks['credit'] = null;
  if (o.terms !== 'cbd') {
    const ex = await customerExposure(c, o.customerId);
    // A draft or submitted OG is not approved yet, so it is never already inside the exposure figure.
    const after = toPaisa(ex.exposure) + total;
    const limit = toPaisa(ex.credit_limit);
    const over = after - limit;
    credit = {
      limit: ex.credit_limit,
      balance: ex.balance,
      undispatched: ex.undispatched,
      after: fromPaisa(after),
      overBy: fromPaisa(over > 0n ? over : 0n)
    };
    if (over > 0n) reasons.push(`Credit limit exceeded by Rs ${formatPkr(over)}`);
  }
  const unpurchasedBags = lines.reduce((s, l) => s + l.unpurchased, 0);
  return { totalValue: fromPaisa(total), bags, reasons, needsApproval: reasons.length > 0, unpurchasedBags, lines, credit };
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const OG_LIST_SQL = `
  select o.id, o.og_no, o.business_date, o.status, o.terms, o.advance_pct, o.credit_days, o.due_date, o.unpurchased_bags,
         o.approval_reasons, o.branch_id, b.code as branch_code, o.customer_id, p.name_en as customer_name, p.name_ur as customer_name_ur,
         p.city as customer_city, s.bags, s.dispatched_bags, s.total_value, s.paid, s.outstanding, s.fulfilment, s.payment,
         (select string_agg(distinct pr.name_en, ', ') from og_lines l join products pr on pr.id = l.product_id where l.og_id = o.id) as products,
         exists (select 1 from receipt_allocations a where a.og_id = o.id and a.reversed_at is not null) as has_returned_cheque,
         cu.full_name as created_by_name, o.created_by, o.created_at
    from ogs o
    join parties p on p.id = o.customer_id
    join branches b on b.id = o.branch_id
    join og_status s on s.og_id = o.id
    join users cu on cu.id = o.created_by`;

function maskOg<T extends Record<string, unknown>>(row: T, showMoney: boolean): T {
  if (showMoney) return row;
  const r: Record<string, unknown> = { ...row };
  for (const k of ['total_value', 'paid', 'outstanding', 'rate', 'amount', 'credit', 'goods_value', 'freight_value', 'discount_value', 'discount', 'freight_per_bag']) delete r[k];
  return r as T;
}

export async function salesRoutes(app: FastifyInstance) {
  const { config } = app.deps;
  const canRead = requirePerm('og.read', 'og.read.own');

  app.get('/ogs', { preHandler: canRead }, async (req) => {
    const q = z
      .object({
        view: z.enum(['all', 'awaiting', 'unpaid', 'unpurchased', 'held']).default('all'),
        branchId: z.coerce.number().int().optional(),
        customerId: z.coerce.number().int().optional()
      })
      .parse(req.query);
    const showMoney = can(req.user, 'money.read');
    return app.read(req, async (c) => {
      const rows = await many(
        c,
        `${OG_LIST_SQL}
          where ($1::int is null or o.branch_id = $1) and ($2::int is null or o.customer_id = $2)
            and case $3
              when 'awaiting' then o.status = 'submitted'
              when 'unpaid' then o.status = 'approved' and s.payment in ('Unpaid','Partly paid','Overdue')
              when 'unpurchased' then o.status = 'approved' and o.unpurchased_bags > 0 and s.fulfilment <> 'Dispatched'
              when 'held' then o.status = 'approved' and o.terms = 'cbd' and s.payment <> 'Paid'
              else true end
          order by o.business_date desc, o.id desc limit 500`,
        [q.branchId ?? null, q.customerId ?? null, q.view]
      );
      return rows.map((r) => maskOg(r, showMoney));
    });
  });

  app.get('/ogs/:id', { preHandler: canRead }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const showMoney = can(req.user, 'money.read');
    return app.read(req, async (c) => {
      const og = await maybeOne(
        c,
        `${OG_LIST_SQL.replace('cu.full_name as created_by_name', `cu.full_name as created_by_name, du.full_name as decided_by_name, o.decided_at, o.decision_comment,
           o.freight_by, o.freight_per_bag, o.discount, o.note, o.submitted_at, rep.full_name as rep_name`)}
           left join users du on du.id = o.decided_by
           left join users rep on rep.id = o.rep_user_id
          where o.id = $1`,
        [id]
      );
      if (!og) throw notFound('OG');
      const lines = await many(
        c,
        `select l.id, l.line_no, l.product_id, pr.name_en, pr.name_ur, pr.manufacturer, l.bags, l.rate, l.bags * l.rate as amount,
                l.floor_price, ld.dispatched
           from og_lines l join products pr on pr.id = l.product_id join og_line_dispatched ld on ld.og_line_id = l.id
          where l.og_id = $1 order by l.line_no`,
        [id]
      );
      const dispatches = await many(
        c,
        `select d.id, d.dispatch_no, d.business_date, d.truck_no, d.driver_name, d.bilty_no, d.gate_pass_no, d.freight_per_bag,
                t.name_en as transporter_name, u.full_name as created_by_name, d.created_at,
                d.goods_value + d.freight_value - d.discount_value as amount,
                (select sum(bags) from dispatch_lines dl where dl.dispatch_id = d.id)::bigint as bags
           from dispatches d left join parties t on t.id = d.transporter_id join users u on u.id = d.created_by
          where d.og_id = $1 order by d.business_date, d.id`,
        [id]
      );
      const allocations = showMoney
        ? await many(
            c,
            `select a.id, a.amount, a.created_at, a.reversed_at, r.receipt_no, r.business_date, r.mode, r.instrument_no,
                    ma.name as account_name, u.full_name as created_by_name, cr.return_no, cr.reason as return_reason
               from receipt_allocations a join receipts r on r.id = a.receipt_id
               join accounts ma on ma.id = r.account_id join users u on u.id = a.created_by
               left join cheque_returns cr on cr.id = a.reversed_by_return_id
              where a.og_id = $1 order by a.created_at`,
            [id]
          )
        : [];
      const activity = await many(
        c,
        `select l.at, l.action, l.detail, u.full_name as user_name from audit_log l left join users u on u.id = l.user_id
          where l.entity = 'og' and l.entity_id = $1 order by l.at desc`,
        [String(id)]
      );
      return {
        ...maskOg(og, showMoney),
        lines: lines.map((l) => maskOg(l, showMoney)),
        dispatches: dispatches.map((d) => maskOg(d, showMoney)),
        allocations,
        activity: showMoney ? activity : activity.map((a) => ({ ...a, detail: null }))
      };
    });
  });

  // Live checks for the New OG form, without saving anything.
  app.post('/ogs/preview', { preHandler: requirePerm('og.create') }, async (req) => {
    const b = OgInput.parse(req.body);
    return app.read(req, (c) => computeChecks(c, b, null));
  });

  async function saveOg(c: Db, b: OgInput, userId: number, existingId: string | null) {
    const date = b.businessDate ?? app.today();
    const cust = await one<{ rep_user_id: number | null; credit_days: number }>(
      c,
      'select rep_user_id, credit_days from parties where id = $1',
      [b.customerId]
    );
    const creditDays = b.terms === 'cbd' ? 0 : (b.creditDays ?? cust.credit_days);
    let id = existingId;
    if (!id) {
      const r = await one<{ id: string }>(
        c,
        `insert into ogs(business_date, customer_id, branch_id, terms, advance_pct, credit_days, freight_by, freight_per_bag, discount, note, created_by, rep_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [date, b.customerId, b.branchId, b.terms, b.advancePct, creditDays, b.freightBy, b.freightPerBag, b.discount, b.note ?? null, userId, cust.rep_user_id]
      );
      id = r.id;
    } else {
      await c.query(
        `update ogs set business_date=$2, customer_id=$3, branch_id=$4, terms=$5, advance_pct=$6, credit_days=$7, freight_by=$8,
                freight_per_bag=$9, discount=$10, note=$11, rep_user_id=$12 where id=$1`,
        [id, date, b.customerId, b.branchId, b.terms, b.advancePct, creditDays, b.freightBy, b.freightPerBag, b.discount, b.note ?? null, cust.rep_user_id]
      );
      await c.query('delete from og_lines where og_id = $1', [id]);
    }
    let n = 1;
    for (const l of b.lines) {
      await c.query(
        `insert into og_lines(og_id, line_no, product_id, bags, rate, floor_price)
         values ($1,$2,$3,$4,$5,(select floor_price from products where id = $3))`,
        [id, n++, l.productId, l.bags, l.rate]
      );
    }
    return { id, date, creditDays };
  }

  async function submit(c: Db, id: string, b: OgInput, userId: number, date: string, creditDays: number) {
    const checks = await computeChecks(c, b, id);
    const ogNo = (await one<{ n: string }>(c, "select next_doc_no('OG', $1) as n", [date])).n;
    const autoApprove = !checks.needsApproval;
    await c.query(
      `update ogs set og_no=$2, status=$3, submitted_at=now(), approval_reasons=$4, unpurchased_bags=$5,
              due_date=$6, decided_at = case when $3 = 'approved' then now() else null end,
              decision_comment = case when $3 = 'approved' then 'Within limits: approved automatically' else null end
        where id=$1`,
      [id, ogNo, autoApprove ? 'approved' : 'submitted', checks.reasons, checks.unpurchasedBags,
        b.terms === 'cbd' ? null : addDays(date, creditDays)]
    );
    await audit(c, userId, 'submit', 'og', id, { ogNo, total: checks.totalValue, reasons: checks.reasons, unpurchased: checks.unpurchasedBags });
    if (autoApprove) await audit(c, null, 'auto_approve', 'og', id, { ogNo });
    return { id, ogNo, status: autoApprove ? 'approved' : 'submitted', checks };
  }

  app.post('/ogs', { preHandler: requirePerm('og.create') }, async (req) => {
    const b = OgInput.extend({ submit: z.boolean().default(true) }).parse(req.body);
    return app.mutate(req, 'ogs.create', async (c) => {
      // Run the checks first so a bad customer or product fails before anything is written.
      await computeChecks(c, b, null);
      const saved = await saveOg(c, b, req.user!.id, null);
      await audit(c, req.user!.id, 'create', 'og', saved.id, { customerId: b.customerId, lines: b.lines.length });
      if (!b.submit) return { id: saved.id, status: 'draft' };
      return submit(c, saved.id, b, req.user!.id, saved.date, saved.creditDays);
    });
  });

  app.put('/ogs/:id', { preHandler: requirePerm('og.create') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const b = OgInput.extend({ submit: z.boolean().default(false) }).parse(req.body);
    return app.mutate(req, 'ogs.update', async (c) => {
      const og = await maybeOne<{ status: string }>(c, 'select status from ogs where id = $1 for update', [id]);
      if (!og) throw notFound('OG');
      if (og.status !== 'draft') throw rule('Only draft OGs can be edited');
      const saved = await saveOg(c, b, req.user!.id, id);
      await audit(c, req.user!.id, 'update', 'og', id);
      if (!b.submit) return { id, status: 'draft' };
      return submit(c, id, b, req.user!.id, saved.date, saved.creditDays);
    });
  });

  app.post('/ogs/:id/decide', { preHandler: requirePerm('og.approve') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const b = z.object({ approve: z.boolean(), comment: z.string().trim().min(1, 'A comment is required') }).parse(req.body);
    return app.mutate(req, 'ogs.decide', async (c) => {
      const og = await maybeOne<{ status: string; created_by: number; og_no: string }>(
        c,
        'select status, created_by, og_no from ogs where id = $1 for update',
        [id]
      );
      if (!og) throw notFound('OG');
      if (og.status !== 'submitted') throw rule('This OG is not waiting for approval');
      if (og.created_by === req.user!.id) throw forbidden('You cannot approve an OG you created');
      await c.query("update ogs set status=$2, decided_by=$3, decided_at=now(), decision_comment=$4 where id=$1", [
        id,
        b.approve ? 'approved' : 'rejected',
        req.user!.id,
        b.comment
      ]);
      await audit(c, req.user!.id, b.approve ? 'approve' : 'reject', 'og', id, { ogNo: og.og_no, comment: b.comment });
      return { id, status: b.approve ? 'approved' : 'rejected' };
    });
  });

  app.post('/ogs/:id/cancel', { preHandler: requirePerm('og.cancel') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    return app.mutate(req, 'ogs.cancel', async (c) => {
      const og = await maybeOne<{ status: string; og_no: string }>(c, 'select status, og_no from ogs where id = $1 for update', [id]);
      if (!og) throw notFound('OG');
      if (!['draft', 'submitted', 'approved'].includes(og.status)) throw rule('This OG is already closed');
      const d = await one<{ n: string }>(c, 'select count(*) as n from dispatches where og_id = $1', [id]);
      if (Number(d.n) > 0) throw rule('This OG has dispatches and cannot be cancelled. Record a sales return instead.');
      const a = await one<{ n: string }>(c, 'select count(*) as n from receipt_allocations where og_id = $1 and reversed_at is null', [id]);
      if (Number(a.n) > 0) throw rule('Payments are allocated to this OG. Move them to another OG first.');
      await c.query("update ogs set status='cancelled', decided_by=$2, decided_at=now(), decision_comment=$3 where id=$1", [id, req.user!.id, reason]);
      await audit(c, req.user!.id, 'cancel', 'og', id, { ogNo: og.og_no, reason });
      return { id, status: 'cancelled' };
    });
  });

  // ---------------- Dispatch ----------------
  app.get('/dispatch-queue', { preHandler: requirePerm('dispatch.create', 'og.read') }, async (req) =>
    app.read(req, async (c) => {
      const rows = await many(
        c,
        `${OG_LIST_SQL} where o.status = 'approved' and s.dispatched_bags < s.bags
          order by o.branch_id, o.business_date, o.id`
      );
      return rows.map((r) => ({
        ...maskOg(r, can(req.user, 'money.read')),
        held: r.terms === 'cbd' && r.payment !== 'Paid'
      }));
    })
  );

  const DispatchInput = z.object({
    businessDate: DateStr.optional(),
    truckNo: z.string().trim().min(3).max(30),
    driverName: z.string().trim().max(100).nullish(),
    biltyNo: z.string().trim().max(40).nullish(),
    gatePassNo: z.string().trim().min(1).max(40).optional(),
    transporterId: z.number().int().nullish(),
    freightPerBag: AmountOrZero.default('0.00'),
    loadingCharges: AmountOrZero.default('0.00'),
    lines: z.array(z.object({ ogLineId: z.number().int(), bags: z.number().int().positive() })).min(1)
  });

  app.post('/ogs/:id/dispatches', { preHandler: requirePerm('dispatch.create') }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const b = DispatchInput.parse(req.body);
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'dispatch.create', async (c) => {
      const og = await maybeOne<{
        status: string; terms: string; og_no: string; branch_id: number; customer_id: number; freight_by: string;
        freight_per_bag: string; discount: string; customer_name: string;
      }>(
        c,
        `select o.status, o.terms, o.og_no, o.branch_id, o.customer_id, o.freight_by, o.freight_per_bag, o.discount, p.name_en as customer_name
           from ogs o join parties p on p.id = o.customer_id where o.id = $1 for update of o`,
        [id]
      );
      if (!og) throw notFound('OG');
      if (og.status !== 'approved') throw rule('Only approved OGs can be dispatched');
      if (req.user!.branchIds && !req.user!.branchIds.includes(og.branch_id)) throw forbidden('You are not assigned to this branch');
      const st = await one<{ paid: string; total_value: string; bags: string; dispatched_bags: string }>(
        c,
        'select paid, total_value, bags, dispatched_bags from og_status where og_id = $1',
        [id]
      );
      if (og.terms === 'cbd' && toPaisa(st.paid) < toPaisa(st.total_value)) {
        throw rule(`Cash before delivery: Rs ${formatPkr(st.total_value)} must be received before dispatch (received Rs ${formatPkr(st.paid)})`);
      }
      const ogLines = await many<{ id: string; product_id: number; bags: number; rate: string; dispatched: string }>(
        c,
        `select l.id, l.product_id, l.bags, l.rate, ld.dispatched from og_lines l join og_line_dispatched ld on ld.og_line_id = l.id
          where l.og_id = $1`,
        [id]
      );
      let goods = 0n;
      let bagsNow = 0;
      for (const dl of b.lines) {
        const ol = ogLines.find((x) => Number(x.id) === dl.ogLineId);
        if (!ol) throw rule('A dispatch line does not belong to this OG');
        const pending = ol.bags - Number(ol.dispatched);
        if (dl.bags > pending) throw rule(`Only ${pending} bags are still to be dispatched on this line`);
        goods += toPaisa(ol.rate) * BigInt(dl.bags);
        bagsNow += dl.bags;
      }
      const totalBags = Number(st.bags);
      const dispatchedBefore = Number(st.dispatched_bags);
      const completes = dispatchedBefore + bagsNow === totalBags;
      const freight = og.freight_by === 'customer' ? toPaisa(og.freight_per_bag) * BigInt(bagsNow) : 0n;
      const discountTotal = toPaisa(og.discount);
      let discount: bigint;
      if (completes) {
        const applied = await one<{ s: string }>(c, 'select coalesce(sum(discount_value),0) as s from dispatches where og_id = $1', [id]);
        discount = discountTotal - toPaisa(applied.s);
      } else {
        discount = (discountTotal * BigInt(bagsNow)) / BigInt(totalBags);
      }
      const net = goods + freight - discount;

      const fid = await firmId(c, config.FIRM_CODE);
      const dispatchNo = (await one<{ n: string }>(c, "select next_doc_no('DSP', $1) as n", [date])).n;
      const gatePass = b.gatePassNo ?? (await one<{ n: string }>(c, "select next_doc_no('GP', $1) as n", [date])).n;
      const transporterCost = toPaisa(b.freightPerBag) * BigInt(bagsNow) + toPaisa(b.loadingCharges);
      const entryLines: PostingLine[] = [
        { accountId: await accountId(c, ACC.receivables), debit: fromPaisa(net), partyId: og.customer_id, branchId: og.branch_id, memo: `${og.og_no} · ${bagsNow} bags` },
        { accountId: await accountId(c, ACC.sales), credit: fromPaisa(goods), branchId: og.branch_id },
        ...(freight > 0n ? [{ accountId: await accountId(c, ACC.freightRecovered), credit: fromPaisa(freight), branchId: og.branch_id }] : []),
        ...(discount > 0n ? [{ accountId: await accountId(c, ACC.discounts), debit: fromPaisa(discount), branchId: og.branch_id }] : [])
      ];
      if (b.transporterId && transporterCost > 0n) {
        entryLines.push(
          { accountId: await accountId(c, ACC.freightExpense), debit: fromPaisa(transporterCost), branchId: og.branch_id, memo: `Freight ${dispatchNo}` },
          { accountId: await accountId(c, ACC.payables), credit: fromPaisa(transporterCost), partyId: b.transporterId, branchId: og.branch_id, memo: `Freight ${dispatchNo}` } 
        );
      }
      const entry = await postEntry(c, {
        firmId: fid,
        businessDate: date,
        narration: `Dispatch ${dispatchNo} against ${og.og_no} to ${og.customer_name}`,
        sourceType: 'dispatch',
        sourceId: dispatchNo,
        createdBy: req.user!.id,
        lines: entryLines
      });
      const d = await one<{ id: string }>(
        c,
        `insert into dispatches(dispatch_no, og_id, business_date, branch_id, truck_no, driver_name, bilty_no, gate_pass_no, transporter_id,
                                freight_per_bag, loading_charges, goods_value, freight_value, discount_value, journal_entry_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
        [dispatchNo, id, date, og.branch_id, b.truckNo, b.driverName ?? null, b.biltyNo ?? null, gatePass, b.transporterId ?? null,
          b.freightPerBag, b.loadingCharges, fromPaisa(goods), fromPaisa(freight), fromPaisa(discount), entry.id, req.user!.id]
      );
      for (const dl of b.lines) {
        const ol = ogLines.find((x) => Number(x.id) === dl.ogLineId)!;
        await c.query('insert into dispatch_lines(dispatch_id, og_line_id, product_id, bags) values ($1,$2,$3,$4)', [d.id, dl.ogLineId, ol.product_id, dl.bags]);
        await recordMovement(c, { date, kind: 'dispatch', productId: ol.product_id, branchId: og.branch_id, bags: -dl.bags, refType: 'dispatch', refId: dispatchNo, note: og.og_no, userId: req.user!.id });
      }
      await audit(c, req.user!.id, 'dispatch', 'og', id, { dispatchNo, bags: bagsNow, truck: b.truckNo, gatePass, entryNo: entry.entryNo });
      return { id: d.id, dispatchNo, gatePassNo: gatePass, entryNo: entry.entryNo, amount: fromPaisa(net) };
    });
  });

  app.get('/dispatches/:id', { preHandler: requirePerm('dispatch.create', 'og.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.read(req, async (c) => {
      const d = await maybeOne(
        c,
        `select d.*, o.og_no, p.name_en as customer_name, p.name_ur as customer_name_ur, p.city as customer_city,
                b.code as branch_code, b.name_en as branch_name, t.name_en as transporter_name, u.full_name as created_by_name
           from dispatches d join ogs o on o.id = d.og_id join parties p on p.id = o.customer_id
           join branches b on b.id = d.branch_id left join parties t on t.id = d.transporter_id join users u on u.id = d.created_by
          where d.id = $1`,
        [id]
      );
      if (!d) throw notFound('Dispatch');
      const lines = await many(
        c,
        `select dl.bags, pr.name_en, pr.name_ur, pr.bag_kg from dispatch_lines dl join products pr on pr.id = dl.product_id where dl.dispatch_id = $1`,
        [id]
      );
      return { ...maskOg(d, can(req.user, 'money.read')), lines };
    });
  });
}
