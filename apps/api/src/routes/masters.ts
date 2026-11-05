import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, rule } from '../lib/errors.js';
import { firmId } from '../services/posting.js';
import { AmountOrZero } from '../lib/money.js';

const PartyKind = z.enum(['customer', 'supplier', 'transporter', 'tenant', 'employee', 'other']);

// Codes are assigned by the system (C0001, S0001 ...). The sales rep is set automatically:
// a customer added by a sales rep belongs to that rep.
const PartyInput = z.object({
  kind: PartyKind,
  nameEn: z.string().trim().min(1).max(200),
  nameUr: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(50).nullish(),
  taxNo: z.string().trim().max(50).nullish(),
  filer: z.boolean().nullish(),
  creditLimit: AmountOrZero.default('0.00'),
  creditDays: z.number().int().min(0).max(365).default(30),
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

  app.post('/parties', { preHandler: requirePerm('masters.write', 'customer.create') }, async (req) => {
    const b = PartyInput.parse(req.body);
    if (!can(req.user, 'masters.write') && b.kind !== 'customer') throw forbidden('You can add customers only');
    const rep = req.user!.role === 'sales' && b.kind === 'customer' ? req.user!.id : null;
    return app.mutate(req, 'parties.create', async (c) => {
      const dup = await maybeOne<{ code: string }>(
        c,
        "select code from parties where kind = $1 and lower(name_en) = lower($2) and coalesce(lower(city),'') = coalesce(lower($3),'')",
        [b.kind, b.nameEn, b.city ?? null]
      );
      if (dup) throw rule(`${b.nameEn}${b.city ? `, ${b.city}` : ''} already exists (${dup.code})`);
      const r = await one<{ id: number; code: string }>(
        c,
        `insert into parties(kind, name_en, name_ur, city, phone, tax_no, filer, credit_limit, credit_days, rep_user_id, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, code`,
        [b.kind, b.nameEn, b.nameUr ?? null, b.city ?? null, b.phone ?? null, b.taxNo ?? null, b.filer ?? null,
          b.creditLimit, b.creditDays, rep, b.active, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'party', r.id, { code: r.code, kind: b.kind, creditLimit: b.creditLimit, rep });
      return { id: r.id, code: r.code };
    });
  });

  app.put('/parties/:id', { preHandler: requirePerm('masters.write') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = PartyInput.parse(req.body);
    return app.mutate(req, 'parties.update', async (c) => {
      const before = await maybeOne(c, 'select * from parties where id = $1', [id]);
      if (!before) throw notFound('Party');
      // The code and sales rep never change here.
      await c.query(
        `update parties set kind=$2, name_en=$3, name_ur=$4, city=$5, phone=$6, tax_no=$7, filer=$8,
                credit_limit=$9, credit_days=$10, active=$11 where id=$1`,
        [id, b.kind, b.nameEn, b.nameUr ?? null, b.city ?? null, b.phone ?? null, b.taxNo ?? null, b.filer ?? null,
          b.creditLimit, b.creditDays, b.active]
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
  // Stock locations: AKB stores, company warehouses/plants, customer warehouses (amanat), trading dealers.
  app.get('/branches', { preHandler: requirePerm('masters.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select b.*, p.name_en as party_name, p.code as party_code
           from branches b left join parties p on p.id = b.party_id
          order by case b.kind when 'godown' then 1 when 'office' then 2 when 'sale_point' then 3
                               when 'company_site' then 4 when 'amanat' then 5 else 6 end, b.code`
      )
    )
  );

  const LocationInput = z.object({
    kind: z.enum(['godown', 'company_site', 'amanat', 'dealer']),
    nameEn: z.string().trim().min(2).max(200).optional(),
    nameUr: z.string().trim().max(200).nullish(),
    city: z.string().trim().max(100).nullish(),
    partyId: z.number().int().nullish()
  });

  app.post('/locations', { preHandler: requirePerm('locations.manage', 'masters.write') }, async (req) => {
    const b = LocationInput.parse(req.body);
    if (b.kind === 'godown' && !can(req.user, 'masters.write')) throw forbidden('Only an administrator can add an AKB store');
    if ((b.kind === 'amanat' || b.kind === 'dealer') && !b.partyId) {
      throw rule(b.kind === 'amanat' ? 'Choose the customer whose warehouse this is' : 'Choose the dealer AKB buys from');
    }
    return app.mutate(req, 'locations.create', async (c) => {
      let party: { name_en: string; kind: string; city: string | null } | null = null;
      if (b.partyId) {
        party = await maybeOne(c, 'select name_en, kind, city from parties where id = $1', [b.partyId]);
        if (!party) throw notFound('Party');
        if (b.kind === 'amanat' && party.kind !== 'customer') throw rule('An amanat warehouse must belong to a customer');
      }
      const name =
        b.nameEn ??
        (b.kind === 'amanat' ? `${party!.name_en} warehouse (amanat)` : b.kind === 'dealer' ? `${party!.name_en} (trading)` : null);
      if (!name) throw rule('Enter a name for the location');
      const dup = await maybeOne<{ code: string }>(
        c,
        'select code from branches where kind = $1 and lower(name_en) = lower($2) and party_id is not distinct from $3',
        [b.kind, name, b.partyId ?? null]
      );
      if (dup) throw rule(`${name} already exists (${dup.code})`);
      const r = await one<{ id: number; code: string }>(
        c,
        `insert into branches(firm_id, kind, name_en, name_ur, city, party_id, owned, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, code`,
        [await firmId(c, app.deps.config.FIRM_CODE), b.kind, name, b.nameUr ?? null, b.city ?? party?.city ?? null, b.partyId ?? null,
          b.kind === 'godown' ? null : false, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'location', r.id, { code: r.code, kind: b.kind, name, partyId: b.partyId ?? null });
      return { id: r.id, code: r.code, name };
    });
  });

  app.put('/locations/:id', { preHandler: requirePerm('masters.write') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = z
      .object({ nameEn: z.string().trim().min(2).max(200), nameUr: z.string().trim().max(200).nullish(), city: z.string().trim().max(100).nullish(), active: z.boolean() })
      .parse(req.body);
    return app.mutate(req, 'locations.update', async (c) => {
      const before = await maybeOne(c, 'select * from branches where id = $1', [id]);
      if (!before) throw notFound('Location');
      await c.query('update branches set name_en=$2, name_ur=$3, city=$4, active=$5 where id=$1', [id, b.nameEn, b.nameUr ?? null, b.city ?? null, b.active]);
      await audit(c, req.user!.id, 'update', 'location', id, { before, after: b });
      return { id };
    });
  });

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
