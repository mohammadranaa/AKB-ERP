import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, rule } from '../lib/errors.js';
import { AmountOrZero, Amount, fromPaisa, toPaisa, formatPkr } from '../lib/money.js';
import { ACC, accountId, firmId, postEntry, type PostingLine } from '../services/posting.js';
import { createHash } from 'node:crypto';
import { customerExposure } from './masters.js';
import { recordMovement } from './stock.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const OgInput = z.object({
  businessDate: DateStr.optional(),
  customerId: z.number().int(),
  /** Where the goods are collected from: an AKB store, a company warehouse/plant, a customer warehouse (amanat) or a trading dealer. */
  branchId: z.number().int(),
  /** Credit or cash (cash before delivery). */
  terms: z.enum(['cbd', 'credit']),
  creditDays: z.number().int().min(0).max(365).optional(),
  /** Pohnch: AKB delivers. X: the customer collects. */
  delivery: z.enum(['pohnch', 'x']).default('x'),
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

  const loc = await maybeOne<{ kind: string; active: boolean; code: string }>(c, 'select kind, active, code from branches where id = $1', [o.branchId]);
  if (!loc) throw notFound('Location');
  if (!loc.active) throw rule(`Location ${loc.code} is inactive`);
  // A trading source is another dealer's stock: AKB keeps no count of it.
  const tracksStock = loc.kind !== 'dealer';

  let goods = 0n;
  let bags = 0;
  const reasons: string[] = [];
  // Stock check per product (several lines can be the same product).
  const wanted = new Map<number, number>();
  for (const l of o.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.bags);
  const avail = new Map<number, number>();
  for (const pid of tracksStock ? wanted.keys() : []) {
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
    const a = tracksStock ? Math.max(0, left.get(l.productId) ?? 0) : l.bags;
    const unp = Math.max(0, l.bags - a);
    left.set(l.productId, (left.get(l.productId) ?? 0) - l.bags);
    lines.push({ productId: l.productId, bags: l.bags, rate: l.rate, floorPrice: p.floor_price, belowFloor: below, available: avail.get(l.productId) ?? 0, unpurchased: unp });
  }
  const total = goods;
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
         o.approval_reasons, o.branch_id, b.code as branch_code, b.name_en as location_name, b.kind as source_kind,
         lp.name_en as location_party_name, case when o.freight_by = 'akb' then 'pohnch' else 'x' end as delivery, o.customer_id, p.name_en as customer_name, p.name_ur as customer_name_ur,
         p.city as customer_city, s.bags, s.dispatched_bags, s.total_value, s.paid, s.outstanding, s.fulfilment, s.payment,
         (select string_agg(distinct pr.name_en, ', ') from og_lines l join products pr on pr.id = l.product_id where l.og_id = o.id) as products,
         exists (select 1 from receipt_allocations a where a.og_id = o.id and a.reversed_at is not null) as has_returned_cheque,
         cu.full_name as created_by_name, o.created_by, o.created_at
    from ogs o
    join parties p on p.id = o.customer_id
    join branches b on b.id = o.branch_id
    left join parties lp on lp.id = b.party_id
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
           o.note, o.submitted_at, rep.full_name as rep_name`)}
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
        `select d.id, d.dispatch_no, d.business_date, d.truck_no, d.driver_name, d.driver_phone, d.vehicle_details, d.bilty_no,
                d.gate_pass_no, d.freight_per_bag, d.delivery, d.freight_settlement, d.freight_value,
                t.name_en as transporter_name, u.full_name as created_by_name, d.created_at,
                d.goods_value + d.freight_value - d.discount_value as amount,
                (select count(*) from dispatch_photos ph where ph.dispatch_id = d.id)::int as photos,
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
    const freightBy = b.delivery === 'pohnch' ? 'akb' : 'customer';
    let id = existingId;
    if (!id) {
      const r = await one<{ id: string }>(
        c,
        `insert into ogs(business_date, customer_id, branch_id, terms, advance_pct, credit_days, freight_by, freight_per_bag, discount, note, created_by, rep_user_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [date, b.customerId, b.branchId, b.terms, 0, creditDays, freightBy, '0', '0', b.note ?? null, userId, cust.rep_user_id]
      );
      id = r.id;
    } else {
      await c.query(
        `update ogs set business_date=$2, customer_id=$3, branch_id=$4, terms=$5, advance_pct=$6, credit_days=$7, freight_by=$8,
                freight_per_bag=$9, discount=$10, note=$11, rep_user_id=$12 where id=$1`,
        [id, date, b.customerId, b.branchId, b.terms, 0, creditDays, freightBy, '0', '0', b.note ?? null, cust.rep_user_id]
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

  const Photo = z.object({
    mime: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    data: z.string().min(100).max(4_300_000) // base64, about 3 MB
  });

  const DispatchInput = z.object({
    businessDate: DateStr.optional(),
    truckNo: z.string().trim().min(3).max(30),
    vehicleDetails: z.string().trim().min(2, 'Enter the vehicle details (type, make or capacity)').max(200),
    driverName: z.string().trim().min(2, "Enter the driver's name").max(100),
    driverPhone: z.string().trim().regex(/^[0-9+\- ]{7,20}$/, "Enter the driver's phone number"),
    driverCnic: z.string().trim().max(20).nullish(),
    biltyNo: z.string().trim().max(40).nullish(),
    gatePassNo: z.string().trim().min(1).max(40).optional(),
    transporterId: z.number().int().nullish(),
    /** How this truck's freight is settled (see migration 010). */
    freightSettlement: z.enum(['akb_cost', 'customer_paid', 'charged_to_customer', 'none']),
    freightPerBag: AmountOrZero.default('0.00'),
    loadingCharges: AmountOrZero.default('0.00'),
    photos: z.array(Photo).min(1, 'Add at least one photo of the loading').max(3),
    lines: z.array(z.object({ ogLineId: z.number().int(), bags: z.number().int().positive() })).min(1)
  });

  /** Decode an uploaded photo and confirm the bytes really are the image type claimed. */
  function decodePhoto(p: z.infer<typeof Photo>): Buffer {
    const buf = Buffer.from(p.data, 'base64');
    if (buf.length === 0 || buf.length > 3 * 1024 * 1024) throw rule('Each photo must be under 3 MB');
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const png = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const webp = buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    const ok = (p.mime === 'image/jpeg' && jpeg) || (p.mime === 'image/png' && png) || (p.mime === 'image/webp' && webp);
    if (!ok) throw rule('A photo is not a valid image');
    return buf;
  }

  const OWN_STORES = ['godown', 'office', 'sale_point'];

  app.post('/ogs/:id/dispatches', { preHandler: requirePerm('dispatch.create'), bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
    const b = DispatchInput.parse(req.body);
    const photos = b.photos.map((p) => ({ mime: p.mime, bytes: decodePhoto(p) }));
    const date = b.businessDate ?? app.today();
    return app.mutate(req, 'dispatch.create', async (c) => {
      const og = await maybeOne<{
        status: string; terms: string; og_no: string; branch_id: number; customer_id: number; freight_by: string;
        customer_name: string; location_kind: string;
      }>(
        c,
        `select o.status, o.terms, o.og_no, o.branch_id, o.customer_id, o.freight_by, p.name_en as customer_name, b.kind as location_kind
           from ogs o join parties p on p.id = o.customer_id join branches b on b.id = o.branch_id where o.id = $1 for update of o`,
        [id]
      );
      if (!og) throw notFound('OG');
      if (og.status !== 'approved') throw rule('Only approved OGs can be dispatched');
      // Branch assignments apply to AKB's own stores; company, amanat and trading pick-ups are open to the team.
      if (OWN_STORES.includes(og.location_kind) && req.user!.branchIds && !req.user!.branchIds.includes(og.branch_id)) {
        throw forbidden('You are not assigned to this branch');
      }
      const delivery = og.freight_by === 'akb' ? 'pohnch' : 'x';
      const allowed = delivery === 'pohnch' ? ['akb_cost', 'customer_paid', 'charged_to_customer'] : ['none', 'charged_to_customer'];
      if (!allowed.includes(b.freightSettlement)) {
        throw rule(delivery === 'pohnch'
          ? 'For Pohnch, choose whether AKB pays the freight, the customer paid it, or it is added to the customer\'s account'
          : 'For X, the customer arranges transport; only choose "added to the customer\'s account" if AKB paid the freight');
      }
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

      // Freight for this truck.
      const freight = toPaisa(b.freightPerBag) * BigInt(bagsNow);
      const loading = toPaisa(b.loadingCharges);
      if (b.freightSettlement !== 'none' && b.freightSettlement !== 'akb_cost' && freight <= 0n) throw rule('Enter the freight per bag');
      if (b.freightSettlement === 'none' && freight > 0n) throw rule('No freight is recorded when the customer collects and pays for transport');
      const needsTransporter = (b.freightSettlement === 'akb_cost' && freight + loading > 0n) || b.freightSettlement === 'charged_to_customer';
      if (needsTransporter && !b.transporterId) throw rule('Choose the transporter AKB pays or owes for this freight');
      // What the customer owes for freight on this OG: added, credited (they paid the transporter for AKB), or nothing.
      const customerFreight =
        b.freightSettlement === 'charged_to_customer' ? freight : b.freightSettlement === 'customer_paid' ? -freight : 0n;

      const fid = await firmId(c, config.FIRM_CODE);
      const dispatchNo = (await one<{ n: string }>(c, "select next_doc_no('DSP', $1) as n", [date])).n;
      const gatePass = b.gatePassNo ?? (await one<{ n: string }>(c, "select next_doc_no('GP', $1) as n", [date])).n;
      const recv = await accountId(c, ACC.receivables);
      const memo = `${og.og_no} · ${bagsNow} bags`;
      const entryLines: PostingLine[] = [
        { accountId: recv, debit: fromPaisa(goods), partyId: og.customer_id, branchId: og.branch_id, memo },
        { accountId: await accountId(c, ACC.sales), credit: fromPaisa(goods), branchId: og.branch_id }
      ];
      const fMemo = `Freight ${dispatchNo}`;
      if (b.freightSettlement === 'akb_cost' && freight > 0n) {
        entryLines.push(
          { accountId: await accountId(c, ACC.freightExpense), debit: fromPaisa(freight), branchId: og.branch_id, memo: fMemo },
          { accountId: await accountId(c, ACC.payables), credit: fromPaisa(freight), partyId: b.transporterId!, branchId: og.branch_id, memo: fMemo }
        );
      } else if (b.freightSettlement === 'customer_paid') {
        // The customer paid the transporter on AKB's behalf: AKB's freight cost, and less for the customer to pay.
        entryLines.push(
          { accountId: await accountId(c, ACC.freightExpense), debit: fromPaisa(freight), branchId: og.branch_id, memo: `${fMemo} (paid by customer)` },
          { accountId: recv, credit: fromPaisa(freight), partyId: og.customer_id, branchId: og.branch_id, memo: `${fMemo} paid by customer` }
        );
      } else if (b.freightSettlement === 'charged_to_customer') {
        // AKB pays (owes) the transporter and the customer owes AKB for it.
        entryLines.push(
          { accountId: recv, debit: fromPaisa(freight), partyId: og.customer_id, branchId: og.branch_id, memo: `${fMemo} added to account` },
          { accountId: await accountId(c, ACC.payables), credit: fromPaisa(freight), partyId: b.transporterId!, branchId: og.branch_id, memo: fMemo }
        );
      }
      if (loading > 0n && b.transporterId) {
        entryLines.push(
          { accountId: await accountId(c, ACC.freightExpense), debit: fromPaisa(loading), branchId: og.branch_id, memo: `Loading ${dispatchNo}` },
          { accountId: await accountId(c, ACC.payables), credit: fromPaisa(loading), partyId: b.transporterId, branchId: og.branch_id, memo: `Loading ${dispatchNo}` }
        );
      }
      const entry = await postEntry(c, {
        firmId: fid,
        businessDate: date,
        narration: `Dispatch ${dispatchNo} against ${og.og_no} to ${og.customer_name} (${delivery === 'pohnch' ? 'Pohnch' : 'X'})`,
        sourceType: 'dispatch',
        sourceId: dispatchNo,
        createdBy: req.user!.id,
        lines: entryLines
      });
      const d = await one<{ id: string }>(
        c,
        `insert into dispatches(dispatch_no, og_id, business_date, branch_id, truck_no, vehicle_details, driver_name, driver_phone, driver_cnic,
                                bilty_no, gate_pass_no, transporter_id, delivery, freight_settlement, freight_per_bag, loading_charges,
                                goods_value, freight_value, discount_value, journal_entry_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0,$19,$20) returning id`,
        [dispatchNo, id, date, og.branch_id, b.truckNo, b.vehicleDetails, b.driverName, b.driverPhone, b.driverCnic ?? null,
          b.biltyNo ?? null, gatePass, b.transporterId ?? null, delivery, b.freightSettlement, b.freightPerBag, b.loadingCharges,
          fromPaisa(goods), fromPaisa(customerFreight), entry.id, req.user!.id]
      );
      for (const ph of photos) {
        await c.query(
          'insert into dispatch_photos(dispatch_id, mime, bytes, size, sha256, created_by) values ($1,$2,$3,$4,$5,$6)',
          [d.id, ph.mime, ph.bytes, ph.bytes.length, createHash('sha256').update(ph.bytes).digest('hex'), req.user!.id]
        );
      }
      for (const dl of b.lines) {
        const ol = ogLines.find((x) => Number(x.id) === dl.ogLineId)!;
        await c.query('insert into dispatch_lines(dispatch_id, og_line_id, product_id, bags) values ($1,$2,$3,$4)', [d.id, dl.ogLineId, ol.product_id, dl.bags]);
        // Trading pick-ups come from another dealer's stock, which AKB does not count.
        if (og.location_kind !== 'dealer') {
          await recordMovement(c, { date, kind: 'dispatch', productId: ol.product_id, branchId: og.branch_id, bags: -dl.bags, refType: 'dispatch', refId: dispatchNo, note: og.og_no, userId: req.user!.id });
        }
      }
      await audit(c, req.user!.id, 'dispatch', 'og', id, {
        dispatchNo, bags: bagsNow, truck: b.truckNo, driver: b.driverName, gatePass, entryNo: entry.entryNo,
        delivery, freightSettlement: b.freightSettlement, photos: photos.length
      });
      return { id: d.id, dispatchNo, gatePassNo: gatePass, entryNo: entry.entryNo, amount: fromPaisa(goods + customerFreight) };
    });
  });

  // Loading photos. The OG join applies row-level security (a sales rep sees only their own customers' photos).
  app.get('/dispatches/:id/photos/:photoId', { preHandler: requirePerm('dispatch.create', 'og.read', 'og.read.own') }, async (req, reply) => {
    const { id, photoId } = z.object({ id: z.coerce.number().int(), photoId: z.coerce.number().int() }).parse(req.params);
    const ph = await app.read(req, (c) =>
      maybeOne<{ mime: string; bytes: Buffer }>(
        c,
        `select p.mime, p.bytes from dispatch_photos p join dispatches d on d.id = p.dispatch_id join ogs o on o.id = d.og_id
          where p.id = $1 and p.dispatch_id = $2`,
        [photoId, id]
      )
    );
    if (!ph) throw notFound('Photo');
    return reply.header('content-type', ph.mime).header('cache-control', 'private, max-age=86400').send(ph.bytes);
  });

  app.get('/dispatches/:id', { preHandler: requirePerm('dispatch.create', 'og.read', 'og.read.own') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.read(req, async (c) => {
      const d = await maybeOne(
        c,
        `select d.*, o.og_no, p.name_en as customer_name, p.name_ur as customer_name_ur, p.city as customer_city,
                b.code as branch_code, b.name_en as branch_name, t.name_en as transporter_name, u.full_name as created_by_name
           from dispatches d join ogs o on o.id = d.og_id join parties p on p.id = o.customer_id
           left join branches b on b.id = d.branch_id left join parties t on t.id = d.transporter_id join users u on u.id = d.created_by
          where d.id = $1`,
        [id]
      );
      if (!d) throw notFound('Dispatch');
      const lines = await many(
        c,
        `select dl.bags, pr.name_en, pr.name_ur, pr.bag_kg from dispatch_lines dl join products pr on pr.id = dl.product_id where dl.dispatch_id = $1`,
        [id]
      );
      const photos = await many(c, 'select id, mime, size, created_at from dispatch_photos where dispatch_id = $1 order by id', [id]);
      return { ...maskOg(d, can(req.user, 'money.read')), lines, photos };
    });
  });
}
