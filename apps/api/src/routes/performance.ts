import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, requirePerm } from '../auth.js';
import type { Db } from '../db.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, rule } from '../lib/errors.js';
import { AmountOrZero } from '../lib/money.js';

const Month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** First and last day of a month, the last capped at today (a month still running is month-to-date). */
function period(month: string, today: string) {
  const from = `${month}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  const last = end.toISOString().slice(0, 10);
  return { from, to: last < today ? last : today, monthEnd: last };
}

/**
 * One row per sales rep (and one for sales with no rep). Sales are credited to the rep on the OG,
 * which is copied from the customer when the OG is made; collections to the rep on the receipt.
 */
async function teamRows(c: Db, from: string, to: string, onlyRep: number | null) {
  return many(
    c,
    `with reps as (
       select u.id, u.full_name, u.active from users u
        where u.role_code = 'sales' and ($3::int is null or u.id = $3)
       union all
       select null::int, 'No sales rep (office)', true where $3::int is null),
     booked as (
       select o.rep_user_id as rep, count(*)::int as ogs, coalesce(sum(t.bags), 0)::int as bags, coalesce(sum(t.total_value), 0) as value,
              count(distinct o.customer_id)::int as buyers
         from ogs o join og_totals t on t.og_id = o.id
        where o.status = 'approved' and o.business_date between $1 and $2 group by o.rep_user_id),
     waiting as (
       select o.rep_user_id as rep, count(*)::int as n from ogs o where o.status = 'submitted' group by o.rep_user_id),
     sold as (
       select o.rep_user_id as rep, coalesce(sum(dl.bags), 0)::int as bags
         from dispatches d join ogs o on o.id = d.og_id join dispatch_lines dl on dl.dispatch_id = d.id
        where d.business_date between $1 and $2 group by o.rep_user_id),
     sold_value as (
       select o.rep_user_id as rep, coalesce(sum(d.goods_value + d.freight_value - d.discount_value), 0) as value
         from dispatches d join ogs o on o.id = d.og_id
        where d.business_date between $1 and $2 group by o.rep_user_id),
     collected as (
       select r.rep_user_id as rep, coalesce(sum(r.amount), 0) as amount, count(*)::int as n
         from receipts r where r.status = 'posted' and r.business_date between $1 and $2 group by r.rep_user_id),
     owed as (
       select p.rep_user_id as rep, coalesce(sum(b.balance) filter (where b.balance > 0), 0) as amount
         from parties p join party_receivables b on b.party_id = p.id where p.kind = 'customer' group by p.rep_user_id),
     overdue as (
       select o.rep_user_id as rep, coalesce(sum(s.outstanding), 0) as amount, count(*)::int as n
         from ogs o join og_status s on s.og_id = o.id
        where o.status = 'approved' and s.payment = 'Overdue' group by o.rep_user_id),
     customers as (
       select p.rep_user_id as rep, count(*) filter (where p.active)::int as active,
              count(*) filter (where (p.created_at at time zone 'Asia/Karachi')::date between $1 and $2)::int as new
         from parties p where p.kind = 'customer' group by p.rep_user_id),
     tgt as (
       select rep_user_id as rep, target_bags, target_sales, target_collection
         from sales_targets where month = date_trunc('month', $1::date)::date)
     select r.id as rep_user_id, r.full_name, r.active,
            coalesce(bk.ogs, 0) as ogs_booked, coalesce(bk.bags, 0) as bags_booked, coalesce(bk.value, 0) as value_booked,
            coalesce(bk.buyers, 0) as buying_customers, coalesce(w.n, 0) as ogs_waiting,
            coalesce(s.bags, 0) as bags_sold, coalesce(sv.value, 0) as sales_value,
            coalesce(cl.amount, 0) as collected, coalesce(cl.n, 0) as receipts,
            coalesce(ow.amount, 0) as receivable, coalesce(od.amount, 0) as overdue, coalesce(od.n, 0) as overdue_ogs,
            coalesce(cu.active, 0) as customers, coalesce(cu.new, 0) as new_customers,
            t.target_bags, t.target_sales, t.target_collection
       from reps r
       left join booked bk on bk.rep is not distinct from r.id
       left join waiting w on w.rep is not distinct from r.id
       left join sold s on s.rep is not distinct from r.id
       left join sold_value sv on sv.rep is not distinct from r.id
       left join collected cl on cl.rep is not distinct from r.id
       left join owed ow on ow.rep is not distinct from r.id
       left join overdue od on od.rep is not distinct from r.id
       left join customers cu on cu.rep is not distinct from r.id
       left join tgt t on t.rep = r.id
      order by r.id is null, coalesce(sv.value, 0) desc, r.full_name`,
    [from, to, onlyRep]
  );
}

/** A sales rep sees only their own figures; team.read sees everyone. */
function repScope(req: FastifyRequest, repId: number | null): number | null {
  if (can(req.user, 'team.read')) return repId;
  if (req.user!.role === 'sales') {
    if (repId !== null && repId !== req.user!.id) throw forbidden('You can see your own figures only');
    return req.user!.id;
  }
  throw forbidden();
}

export async function performanceRoutes(app: FastifyInstance) {
  app.get('/team', { preHandler: requirePerm('team.read', 'og.read.own') }, async (req) => {
    const q = z.object({ month: Month.optional() }).parse(req.query);
    const today = app.today();
    const month = q.month ?? today.slice(0, 7);
    const p = period(month, today);
    if (p.from > today) throw rule('That month has not started yet');
    const only = repScope(req, null);
    return app.read(req, async (c) => ({ month, ...p, rows: await teamRows(c, p.from, p.to, only) }));
  });

  // "none" = sales with no rep (office sales).
  app.get('/reps/:id', { preHandler: requirePerm('team.read', 'og.read.own') }, async (req) => {
    const { id } = z.object({ id: z.union([z.literal('none'), z.coerce.number().int()]) }).parse(req.params);
    const q = z.object({ month: Month.optional() }).parse(req.query);
    const today = app.today();
    const month = q.month ?? today.slice(0, 7);
    const p = period(month, today);
    const repId = id === 'none' ? null : id;
    if (repId === null && !can(req.user, 'team.read')) throw forbidden();
    repScope(req, repId);
    return app.read(req, async (c) => {
      let rep: { id: number | null; full_name: string; active: boolean } = { id: null, full_name: 'No sales rep (office)', active: true };
      if (repId !== null) {
        const u = await maybeOne<{ id: number; full_name: string; active: boolean }>(
          c, "select id, full_name, active from users where id = $1 and role_code = 'sales'", [repId]);
        if (!u) throw notFound('Sales rep');
        rep = u;
      }
      const rows = await teamRows(c, p.from, p.to, repId);
      const summary = rows.find((r) => (r.rep_user_id ?? null) === repId) ?? null;
      const byProduct = await many(
        c,
        `select pr.id, pr.code, pr.name_en, sum(dl.bags)::int as bags,
                sum(dl.bags * ol.rate) as goods_value
           from dispatches d join ogs o on o.id = d.og_id join dispatch_lines dl on dl.dispatch_id = d.id
           join og_lines ol on ol.id = dl.og_line_id join products pr on pr.id = dl.product_id
          where d.business_date between $1 and $2 and o.rep_user_id is not distinct from $3
          group by pr.id order by bags desc`,
        [p.from, p.to, repId]
      );
      const byCustomer = await many(
        c,
        `with s as (
           select o.customer_id, sum(dl.bags)::int as bags from dispatches d join ogs o on o.id = d.og_id
             join dispatch_lines dl on dl.dispatch_id = d.id
            where d.business_date between $1 and $2 and o.rep_user_id is not distinct from $3 group by o.customer_id),
         sv as (
           select o.customer_id, sum(d.goods_value + d.freight_value - d.discount_value) as value from dispatches d join ogs o on o.id = d.og_id
            where d.business_date between $1 and $2 and o.rep_user_id is not distinct from $3 group by o.customer_id),
         cl as (
           select r.party_id, sum(r.amount) as amount from receipts r
            where r.status = 'posted' and r.business_date between $1 and $2 and r.rep_user_id is not distinct from $3 group by r.party_id),
         od as (
           select o.customer_id, sum(s.outstanding) as amount from ogs o join og_status s on s.og_id = o.id
            where o.status = 'approved' and s.payment = 'Overdue' and o.rep_user_id is not distinct from $3 group by o.customer_id),
         lo as (
           select customer_id, max(business_date) as last_order from ogs where status = 'approved' group by customer_id)
         select p.id, p.code, p.name_en, p.city, sp.name_en as sale_point, p.active,
                coalesce(s.bags, 0) as bags, coalesce(sv.value, 0) as sales_value, coalesce(cl.amount, 0) as collected,
                coalesce(b.balance, 0) as balance, coalesce(od.amount, 0) as overdue, lo.last_order,
                (p.created_at at time zone 'Asia/Karachi')::date between $1 and $2 as is_new
           from parties p
           left join sale_points sp on sp.id = p.sale_point_id
           left join s on s.customer_id = p.id left join sv on sv.customer_id = p.id left join cl on cl.party_id = p.id
           left join od on od.customer_id = p.id left join lo on lo.customer_id = p.id
           left join party_receivables b on b.party_id = p.id
          where p.kind = 'customer' and (p.rep_user_id is not distinct from $3 or s.bags is not null or cl.amount is not null)
          order by coalesce(sv.value, 0) desc, coalesce(b.balance, 0) desc, p.name_en`,
        [p.from, p.to, repId]
      );
      const ogs = await many(
        c,
        `select o.id, o.og_no, o.business_date, o.status, p.name_en as customer_name, t.bags, t.total_value,
                s.fulfilment, s.payment, s.outstanding, o.due_date
           from ogs o join parties p on p.id = o.customer_id join og_totals t on t.og_id = o.id join og_status s on s.og_id = o.id
          where o.business_date between $1 and $2 and o.rep_user_id is not distinct from $3 and o.status in ('submitted','approved','rejected')
          order by o.business_date desc, o.id desc limit 300`,
        [p.from, p.to, repId]
      );
      const trend = await many(
        c,
        `with m as (select generate_series(date_trunc('month', $1::date) - interval '5 months', date_trunc('month', $1::date), interval '1 month')::date as month)
         select to_char(m.month, 'YYYY-MM') as month,
                coalesce((select sum(dl.bags) from dispatches d join ogs o on o.id = d.og_id join dispatch_lines dl on dl.dispatch_id = d.id
                           where date_trunc('month', d.business_date) = m.month and o.rep_user_id is not distinct from $2), 0)::int as bags,
                coalesce((select sum(d.goods_value + d.freight_value - d.discount_value) from dispatches d join ogs o on o.id = d.og_id
                           where date_trunc('month', d.business_date) = m.month and o.rep_user_id is not distinct from $2), 0) as sales_value,
                coalesce((select sum(r.amount) from receipts r
                           where r.status = 'posted' and date_trunc('month', r.business_date) = m.month and r.rep_user_id is not distinct from $2), 0) as collected,
                t.target_bags, t.target_sales, t.target_collection
           from m left join sales_targets t on t.month = m.month and t.rep_user_id = $2
          order by m.month`,
        [p.from, repId]
      );
      return { month, ...p, rep, summary, byProduct, byCustomer, ogs, trend };
    });
  });

  // ---------------- Targets ----------------
  app.get('/targets', { preHandler: requirePerm('team.read', 'targets.manage') }, async (req) => {
    const q = z.object({ month: Month.optional() }).parse(req.query);
    const month = q.month ?? app.today().slice(0, 7);
    return app.read(req, (c) =>
      many(
        c,
        `select u.id as rep_user_id, u.full_name, u.active, t.target_bags, t.target_sales, t.target_collection, t.note,
                t.set_at, s.full_name as set_by_name
           from users u left join sales_targets t on t.rep_user_id = u.id and t.month = $1::date
           left join users s on s.id = t.set_by
          where u.role_code = 'sales' and (u.active or t.id is not null) order by u.full_name`,
        [`${month}-01`]
      )
    );
  });

  app.put('/targets', { preHandler: requirePerm('targets.manage') }, async (req) => {
    const b = z
      .object({
        repUserId: z.number().int(),
        month: Month,
        targetBags: z.number().int().min(0).max(10_000_000),
        targetSales: AmountOrZero,
        targetCollection: AmountOrZero,
        note: z.string().trim().max(300).nullish()
      })
      .parse(req.body);
    return app.mutate(req, 'targets.set', async (c) => {
      const before = await maybeOne(c, 'select * from sales_targets where rep_user_id = $1 and month = $2::date', [b.repUserId, `${b.month}-01`]);
      const r = await one<{ id: number }>(
        c,
        `insert into sales_targets(rep_user_id, month, target_bags, target_sales, target_collection, note, set_by)
         values ($1, $2::date, $3, $4, $5, $6, $7)
         on conflict (rep_user_id, month) do update set target_bags = excluded.target_bags, target_sales = excluded.target_sales,
           target_collection = excluded.target_collection, note = excluded.note, set_by = excluded.set_by, set_at = now()
         returning id`,
        [b.repUserId, `${b.month}-01`, b.targetBags, b.targetSales, b.targetCollection, b.note ?? null, req.user!.id]
      );
      await audit(c, req.user!.id, before ? 'update' : 'create', 'sales_target', r.id, { before, after: b });
      return { id: r.id };
    });
  });

  // ---------------- Employee activity ----------------
  // What each person has done in the system, from the audit log. Sign-ins are counted separately from work.
  app.get('/activity', { preHandler: requirePerm('team.read') }, async (req) => {
    const q = z.object({ from: DateStr.optional(), to: DateStr.optional() }).parse(req.query);
    const today = app.today();
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? today;
    return app.read(req, async (c) => {
      const rows = await many(
        c,
        `with a as (
           select l.user_id, l.entity, l.action, (l.at at time zone 'Asia/Karachi')::date as day
             from audit_log l
            where (l.at at time zone 'Asia/Karachi')::date between $1 and $2 and l.user_id is not null)
         select u.id, u.full_name, u.role_code, u.active,
                (select max(s.last_seen_at) from sessions s where s.user_id = u.id) as last_seen,
                (select count(*) from a where a.user_id = u.id and a.entity = 'user' and a.action = 'login')::int as sign_ins,
                (select count(distinct a.day) from a where a.user_id = u.id and a.entity <> 'user')::int as days_worked,
                (select count(*) from a where a.user_id = u.id and a.entity <> 'user')::int as actions,
                coalesce((select jsonb_object_agg(k, n) from (
                   select a.entity || '.' || a.action as k, count(*)::int as n from a
                    where a.user_id = u.id and a.entity <> 'user' group by 1) x), '{}'::jsonb) as by_action
           from users u
          where u.active or exists (select 1 from a where a.user_id = u.id)
          order by actions desc, u.full_name`,
        [from, to]
      );
      return { from, to, rows };
    });
  });

  app.get('/activity/:userId', { preHandler: requirePerm('team.read') }, async (req) => {
    const { userId } = z.object({ userId: z.coerce.number().int() }).parse(req.params);
    const q = z.object({ from: DateStr.optional(), to: DateStr.optional() }).parse(req.query);
    const today = app.today();
    const from = q.from ?? `${today.slice(0, 7)}-01`;
    const to = q.to ?? today;
    return app.read(req, async (c) => {
      const u = await maybeOne(c, 'select id, full_name, role_code, active from users where id = $1', [userId]);
      if (!u) throw notFound('User');
      const days = await many(
        c,
        `select (l.at at time zone 'Asia/Karachi')::date as day, count(*)::int as actions,
                min(l.at) as first_at, max(l.at) as last_at
           from audit_log l where l.user_id = $1 and l.entity <> 'user'
            and (l.at at time zone 'Asia/Karachi')::date between $2 and $3
          group by 1 order by 1 desc`,
        [userId, from, to]
      );
      const entries = await many(
        c,
        `select l.id, l.at, l.action, l.entity, l.entity_id from audit_log l
          where l.user_id = $1 and (l.at at time zone 'Asia/Karachi')::date between $2 and $3
            and not (l.entity = 'user' and l.action in ('login_failed'))
          order by l.id desc limit 500`,
        [userId, from, to]
      );
      return { user: u, from, to, days, entries };
    });
  });
}
