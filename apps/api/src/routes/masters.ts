import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { AmountOrZero } from '../lib/money.js';

const PartyKind = z.enum(['customer', 'supplier', 'transporter', 'tenant', 'employee', 'other']);

const PartyInput = z.object({
  code: z.string().trim().min(1).max(30),
  kind: PartyKind,
  nameEn: z.string().trim().min(1).max(200),
  nameUr: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(50).nullish(),
  taxNo: z.string().trim().max(50).nullish(),
  filer: z.boolean().nullish(),
  creditLimit: AmountOrZero.default('0.00'),
  creditDays: z.number().int().min(0).max(365).default(30),
  repUserId: z.number().int().nullish(),
  active: z.boolean().default(true)
});

const ProductInput = z.object({
  code: z.string().trim().min(1).max(30),
  nameEn: z.string().trim().min(1).max(200),
  nameUr: z.string().trim().max(200).nullish(),
  manufacturer: z.string().trim().min(1).max(100),
  nutrient: z.string().trim().max(30).nullish(),
  bagKg: z.number().positive().max(1000).default(50),
  floorPrice: z.union([z.string(), z.number()]).nullish(),
  active: z.boolean().default(true)
});

export async function mastersRoutes(app: FastifyInstance) {
  // ---------------- Parties ----------------
  app.get('/parties', { preHandler: requirePerm('masters.read') }, async (req) => {
    const q = z
      .object({ kind: PartyKind.optional(), q: z.string().max(100).optional(), active: z.enum(['true', 'false']).optional() })
      .parse(req.query);
    const showMoney = can(req.user, 'money.read');
    return app.read(req, async (c) => {
      const rows = await many(
        c,
        `select p.id, p.code, p.kind, p.name_en, p.name_ur, p.city, p.phone, p.credit_limit, p.credit_days,
                p.rep_user_id, u.full_name as rep_name, p.active,
                coalesce(r.balance, 0) as balance,
                (select max(o.business_date) from ogs o where o.customer_id = p.id and o.status = 'approved') as last_order_date
           from parties p
           left join users u on u.id = p.rep_user_id
           left join party_receivables r on r.party_id = p.id
          where ($1::text is null or p.kind = $1)
            and ($2::text is null or lower(p.name_en) like '%' || lower($2) || '%' or lower(p.code) like lower($2) || '%' or p.name_ur like '%' || $2 || '%')
            and ($3::boolean is null or p.active = $3)
          order by p.name_en
          limit 500`,
        [q.kind ?? null, q.q ?? null, q.active ? q.active === 'true' : null]
      );
      return rows.map((r) => (showMoney ? r : { ...r, credit_limit: undefined, balance: undefined }));
    });
  });

  app.get('/parties/:id', { preHandler: requirePerm('masters.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const showMoney = can(req.user, 'money.read');
    return app.read(req, async (c) => {
      const p = await maybeOne(
        c,
        `select p.*, u.full_name as rep_name, coalesce(r.balance,0) as balance
           from parties p left join users u on u.id = p.rep_user_id
           left join party_receivables r on r.party_id = p.id where p.id = $1`,
        [id]
      );
      if (!p) throw notFound('Party');
      if (!showMoney) return { ...p, credit_limit: undefined, balance: undefined };
      const exposure = await customerExposure(c, id);
      return { ...p, exposure };
    });
  });

  // Customer statement: every receivable movement with a running balance.
  app.get('/parties/:id/statement', { preHandler: requirePerm('masters.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
    return app.read(req, async (c) => {
      const p = await maybeOne(c, 'select id, code, name_en, name_ur, city from parties where id = $1', [id]);
      if (!p) throw notFound('Party');
      if (!can(req.user, 'money.read')) return { party: p, opening: null, lines: [] };
      const from = q.from ?? '1900-01-01';
      const to = q.to ?? '2999-12-31';
      const opening = await one<{ balance: string }>(
        c,
        `select coalesce(sum(pl.debit - pl.credit),0) as balance from posted_lines pl join accounts a on a.id = pl.account_id
          where a.control = 'receivable' and pl.party_id = $1 and pl.business_date < $2`,
        [id, from]
      );
      const lines = await many(
        c,
        `select pl.business_date, pl.entry_no, pl.narration, pl.memo, pl.source_type, pl.source_id, pl.debit, pl.credit,
                $3::numeric + sum(pl.debit - pl.credit) over (order by pl.business_date, pl.entry_id, pl.line_no) as running
           from posted_lines pl join accounts a on a.id = pl.account_id
          where a.control = 'receivable' and pl.party_id = $1 and pl.business_date between $2 and $4
          order by pl.business_date, pl.entry_id, pl.line_no`,
        [id, from, opening.balance, to]
      );
      return { party: p, from, to, opening: opening.balance, lines };
    });
  });

  app.post('/parties', { preHandler: requirePerm('masters.write') }, async (req) => {
    const b = PartyInput.parse(req.body);
    return app.mutate(req, 'parties.create', async (c) => {
      const r = await one<{ id: number }>(
        c,
        `insert into parties(code, kind, name_en, name_ur, city, phone, tax_no, filer, credit_limit, credit_days, rep_user_id, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [b.code, b.kind, b.nameEn, b.nameUr ?? null, b.city ?? null, b.phone ?? null, b.taxNo ?? null, b.filer ?? null,
          b.creditLimit, b.creditDays, b.repUserId ?? null, b.active, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'party', r.id, { code: b.code, kind: b.kind, creditLimit: b.creditLimit });
      return { id: r.id };
    });
  });

  app.put('/parties/:id', { preHandler: requirePerm('masters.write') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = PartyInput.parse(req.body);
    return app.mutate(req, 'parties.update', async (c) => {
      const before = await maybeOne(c, 'select * from parties where id = $1', [id]);
      if (!before) throw notFound('Party');
      await c.query(
        `update parties set code=$2, kind=$3, name_en=$4, name_ur=$5, city=$6, phone=$7, tax_no=$8, filer=$9,
                credit_limit=$10, credit_days=$11, rep_user_id=$12, active=$13 where id=$1`,
        [id, b.code, b.kind, b.nameEn, b.nameUr ?? null, b.city ?? null, b.phone ?? null, b.taxNo ?? null, b.filer ?? null,
          b.creditLimit, b.creditDays, b.repUserId ?? null, b.active]
      );
      await audit(c, req.user!.id, 'update', 'party', id, { before, after: b });
      return { id };
    });
  });

  // ---------------- Products ----------------
  app.get('/products', { preHandler: requirePerm('masters.read') }, async (req) => {
    const showMoney = can(req.user, 'money.read');
    return app.read(req, async (c) => {
      const rows = await many(c, 'select * from products order by manufacturer, name_en');
      return rows.map((r) => (showMoney ? r : { ...r, floor_price: undefined }));
    });
  });

  app.post('/products', { preHandler: requirePerm('masters.write') }, async (req) => {
    const b = ProductInput.parse(req.body);
    return app.mutate(req, 'products.create', async (c) => {
      const r = await one<{ id: number }>(
        c,
        `insert into products(code, name_en, name_ur, manufacturer, nutrient, bag_kg, floor_price, active)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [b.code, b.nameEn, b.nameUr ?? null, b.manufacturer, b.nutrient ?? null, b.bagKg, b.floorPrice ?? null, b.active]
      );
      await audit(c, req.user!.id, 'create', 'product', r.id, b);
      return { id: r.id };
    });
  });

  app.put('/products/:id', { preHandler: requirePerm('masters.write') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = ProductInput.parse(req.body);
    return app.mutate(req, 'products.update', async (c) => {
      const before = await maybeOne(c, 'select * from products where id = $1', [id]);
      if (!before) throw notFound('Product');
      await c.query(
        `update products set code=$2, name_en=$3, name_ur=$4, manufacturer=$5, nutrient=$6, bag_kg=$7, floor_price=$8, active=$9 where id=$1`,
        [id, b.code, b.nameEn, b.nameUr ?? null, b.manufacturer, b.nutrient ?? null, b.bagKg, b.floorPrice ?? null, b.active]
      );
      await audit(c, req.user!.id, 'update', 'product', id, { before, after: b });
      return { id };
    });
  });

  // ---------------- Reference lists ----------------
  app.get('/branches', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) => many(c, 'select * from branches order by code'))
  );

  app.get('/accounts', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select a.*, b.bank_name, b.account_no, b.account_title
           from accounts a left join bank_accounts b on b.account_id = a.id order by a.code`
      )
    )
  );

  app.get('/cost-centres', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) => many(c, 'select * from cost_centres order by id'))
  );

  // Cash and bank accounts a receipt can be paid into.
  app.get('/money-accounts', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select a.id, a.code, a.name, a.control, b.bank_name, b.account_no
           from accounts a left join bank_accounts b on b.account_id = a.id
          where a.control in ('cash','bank') and a.active and a.postable order by a.control desc, a.code`
      )
    )
  );

  app.get('/users/reps', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) =>
      many(c, "select id, full_name from users where role_code = 'sales' and active order by full_name")
    )
  );
}

/**
 * What a customer owes plus what is already approved but not yet dispatched.
 * Receipts allocated to undispatched OGs are credited to the receivable, so they reduce this too.
 */
export async function customerExposure(c: import('../db.js').Db, partyId: number) {
  return one<{ balance: string; undispatched: string; exposure: string; credit_limit: string; available: string }>(
    c,
    `with u as (
       select coalesce(sum(t.total_value - coalesce(dv.dispatched_value,0)),0) as undispatched
         from ogs o
         join og_totals t on t.og_id = o.id
         left join (select og_id, sum(goods_value + freight_value - discount_value) as dispatched_value
                      from dispatches group by og_id) dv on dv.og_id = o.id
        where o.customer_id = $1 and o.status = 'approved'
     )
     select coalesce(r.balance,0) as balance, u.undispatched,
            coalesce(r.balance,0) + u.undispatched as exposure,
            p.credit_limit,
            p.credit_limit - (coalesce(r.balance,0) + u.undispatched) as available
       from parties p cross join u
       left join party_receivables r on r.party_id = p.id
      where p.id = $1`,
    [partyId]
  );
}
