import type { FastifyInstance } from 'fastify';
import { requirePerm } from '../auth.js';
import { many, one } from '../db.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: requirePerm('dashboard.read') }, async (req) =>
    app.read(req, async (c) => {
      const today = app.today();
      const money = await one<{ cash: string; bank: string }>(
        c,
        `select coalesce(sum(balance) filter (where control = 'cash'),0) as cash,
                coalesce(sum(balance) filter (where control = 'bank'),0) as bank
           from account_balances where control in ('cash','bank')`
      );
      const recv = await one<{ receivable: string; advances: string; customers_owing: string }>(
        c,
        `select coalesce(sum(balance) filter (where balance > 0),0) as receivable,
                coalesce(-sum(balance) filter (where balance < 0),0) as advances,
                count(*) filter (where balance > 0) as customers_owing
           from party_receivables`
      );
      const overdue = await one<{ amount: string; count: string }>(
        c,
        `select coalesce(sum(outstanding),0) as amount, count(*) as count from og_status s join ogs o on o.id = s.og_id
          where o.status = 'approved' and s.payment = 'Overdue'`
      );
      const ageing = await many(
        c,
        `select bucket, coalesce(sum(outstanding),0) as amount, count(*) as count from (
           select s.outstanding,
                  case when $1::date - o.business_date <= 15 then '0-15'
                       when $1::date - o.business_date <= 30 then '16-30'
                       when $1::date - o.business_date <= 60 then '31-60'
                       else '60+' end as bucket
             from ogs o join og_status s on s.og_id = o.id
            where o.status = 'approved' and s.outstanding > 0 and s.dispatched_bags > 0) x
         group by bucket order by min(case bucket when '0-15' then 1 when '16-30' then 2 when '31-60' then 3 else 4 end)`,
        [today]
      );
      const stock = await one<{ bags: string }>(c, 'select coalesce(sum(bags),0) as bags from stock_on_hand');
      const unpurchased = await one<{ bags: string; ogs: string }>(
        c,
        `with oh as (select product_id, branch_id, bags from stock_on_hand),
              cm as (select product_id, branch_id, sum(bags) as bags from stock_committed group by product_id, branch_id)
         select coalesce(sum(greatest(cm.bags - coalesce(oh.bags,0), 0)),0) as bags,
                (select count(*) from ogs o join og_status s on s.og_id = o.id
                  where o.status = 'approved' and o.unpurchased_bags > 0 and s.fulfilment <> 'Dispatched') as ogs
           from cm left join oh on oh.product_id = cm.product_id and oh.branch_id = cm.branch_id`
      );
      const mtd = await one<{ bags: string; value: string }>(
        c,
        `select coalesce(sum((select sum(bags) from dispatch_lines dl where dl.dispatch_id = d.id)),0) as bags,
                coalesce(sum(d.goods_value + d.freight_value - d.discount_value),0) as value
           from dispatches d where date_trunc('month', d.business_date) = date_trunc('month', $1::date)`,
        [today]
      );
      const daily = await many(
        c,
        `select g::date as date, coalesce((select sum(-m.bags) from stock_movements m where m.kind = 'dispatch' and m.business_date = g::date),0) as bags
           from generate_series($1::date - 29, $1::date, interval '1 day') g order by g`,
        [today]
      );
      const pending = await one<{ ogs: string; journals: string; adjustments: string; reversals: string }>(
        c,
        `select (select count(*) from ogs where status = 'submitted') as ogs,
                (select count(*) from journal_entries where status = 'pending_approval') as journals,
                (select count(*) from stock_adjustments where status = 'pending') as adjustments,
                (select count(*) from reversal_requests where status = 'pending') as reversals`
      );
      const returned = await many(
        c,
        `select cr.return_no, cr.business_date, cr.reason, r.instrument_no, r.amount, p.name_en as party_name, p.id as party_id
           from cheque_returns cr join receipts r on r.id = cr.receipt_id join parties p on p.id = r.party_id
          where cr.business_date >= $1::date - 14 order by cr.business_date desc limit 10`,
        [today]
      );
      const inactive = await many(
        c,
        `select p.id, p.name_en, p.city, max(o.business_date) as last_order, $1::date - max(o.business_date) as days
           from parties p join ogs o on o.customer_id = p.id and o.status = 'approved'
          where p.kind = 'customer' and p.active
          group by p.id having $1::date - max(o.business_date) >= 45
          order by days desc limit 20`,
        [today]
      );
      const openDays = await many(
        c,
        `select distinct e.business_date from journal_entries e
          where e.status = 'posted' and e.business_date < $1
            and not exists (select 1 from business_days b where b.business_date = e.business_date and b.status = 'locked')
          order by e.business_date limit 10`,
        [today]
      );
      return {
        asOf: today,
        cash: money.cash,
        bank: money.bank,
        receivable: recv.receivable,
        advances: recv.advances,
        customersOwing: Number(recv.customers_owing),
        overdue: { amount: overdue.amount, count: Number(overdue.count) },
        ageing,
        stockBags: Number(stock.bags),
        unpurchased: { bags: Number(unpurchased.bags), ogs: Number(unpurchased.ogs) },
        salesMtd: { bags: Number(mtd.bags), value: mtd.value },
        daily: daily.map((d) => ({ date: d.date, bags: Number(d.bags) })),
        pendingApprovals: {
          ogs: Number(pending.ogs),
          journals: Number(pending.journals),
          adjustments: Number(pending.adjustments),
          reversals: Number(pending.reversals)
        },
        alerts: { returnedCheques: returned, inactiveCustomers: inactive, unlockedDays: openDays.map((d) => d.business_date) },
        // Margin and financing figures arrive with the finance and procurement modules.
        margin: null
      };
    })
  );
}
