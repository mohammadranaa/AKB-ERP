import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import { many, maybeOne, one } from '../db.js';
import { audit } from '../lib/audit.js';
import { notFound, rule } from '../lib/errors.js';
import { Amount, AmountOrZero, fromPaisa, toPaisa } from '../lib/money.js';
import { ACC, accountId, firmId, postEntry } from '../services/posting.js';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const CreditDays = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(90), z.literal(180)]);

const DealerCodeInput = z.object({
  supplierId: z.number().int(),
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(120),
  district: z.string().trim().max(60).nullish(),
  active: z.boolean().default(true)
});

const OrderInput = z.object({
  orderDate: DateStr.optional(),
  companyOrderNo: z.string().trim().max(40).nullish(),
  dealerCodeId: z.number().int(),
  productId: z.number().int(),
  locationId: z.number().int(),
  bags: z.number().int().positive().max(1_000_000),
  rate: Amount,
  bgChargePerBag: AmountOrZero.default('0.00'),
  freightBy: z.enum(['company', 'akb']).default('company'),
  freightPerBag: AmountOrZero.default('0.00'),
  creditDays: CreditDays.default(0),
  note: z.string().trim().max(500).nullish()
});

const OrderUpdate = OrderInput.omit({ orderDate: true, dealerCodeId: true, productId: true });

const InvoiceInput = z.object({
  invoiceNo: z.string().trim().min(1).max(40),
  invoiceDate: DateStr.optional(),
  bags: z.number().int().positive(),
  /** Defaults to bags x (rate + BG charge). Enter the company's figure when it differs. */
  amount: Amount.optional()
});

/** Due date as finance works it out today: invoice date + credit days - 1 (same day when there is no credit). */
export function dueDate(invoiceDate: string, creditDays: number): string {
  const d = new Date(`${invoiceDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(creditDays - 1, 0));
  return d.toISOString().slice(0, 10);
}

const ORDER_LIST_SQL = `
  select o.id, o.order_no, o.company_order_no, o.order_date, o.status, o.bags, o.rate, o.bg_charge_per_bag,
         o.freight_by, o.freight_per_bag, o.credit_days, o.note, o.cancel_reason, o.created_at,
         o.supplier_id, s.name_en as supplier_name, s.code as supplier_code,
         o.dealer_code_id, dc.code as dealer_code, dc.title as dealer_title, dc.district,
         o.product_id, p.code as product_code, p.name_en as product_name,
         o.location_id, b.code as location_code, b.name_en as location_name, b.kind as location_kind,
         st.order_value, st.invoiced_bags, st.invoiced_amount, st.received_bags, st.paid, st.payable, st.due_date,
         u.full_name as created_by_name
    from company_orders o
    join company_order_status st on st.company_order_id = o.id
    join parties s on s.id = o.supplier_id
    join dealer_codes dc on dc.id = o.dealer_code_id
    join products p on p.id = o.product_id
    join branches b on b.id = o.location_id
    join users u on u.id = o.created_by`;

export async function purchaseRoutes(app: FastifyInstance) {
  const { config } = app.deps;
  // ---------------- Dealer codes ----------------
  app.get('/dealer-codes', { preHandler: requirePerm('purchase.read', 'masters.read') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select dc.*, s.name_en as supplier_name, s.code as supplier_code,
                (select count(*) from company_orders o where o.dealer_code_id = dc.id)::int as orders
           from dealer_codes dc join parties s on s.id = dc.supplier_id
          order by s.name_en, dc.code`
      )
    )
  );

  app.post('/dealer-codes', { preHandler: requirePerm('purchase.create', 'masters.write') }, async (req) => {
    const b = DealerCodeInput.parse(req.body);
    return app.mutate(req, 'dealer-codes.create', async (c) => {
      const dup = await maybeOne(c, 'select 1 from dealer_codes where supplier_id = $1 and code = $2', [b.supplierId, b.code]);
      if (dup) throw rule(`Dealer code ${b.code} already exists for this company`);
      const fid = await firmId(c, config.FIRM_CODE);
      const r = await one<{ id: number }>(
        c,
        `insert into dealer_codes(firm_id, supplier_id, code, title, district, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [fid, b.supplierId, b.code, b.title, b.district ?? null, b.active, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'dealer_code', r.id, b);
      return { id: r.id };
    });
  });

  app.put('/dealer-codes/:id', { preHandler: requirePerm('purchase.create', 'masters.write') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = DealerCodeInput.parse(req.body);
    return app.mutate(req, 'dealer-codes.update', async (c) => {
      const before = await maybeOne<{ supplier_id: number; code: string }>(c, 'select * from dealer_codes where id = $1', [id]);
      if (!before) throw notFound('Dealer code');
      const used = await maybeOne(c, 'select 1 from company_orders where dealer_code_id = $1 limit 1', [id]);
      if (used && (before.supplier_id !== b.supplierId || before.code !== b.code)) {
        throw rule('This dealer code has orders, so its company and code cannot change. Add a new code instead.');
      }
      await c.query('update dealer_codes set supplier_id=$2, code=$3, title=$4, district=$5, active=$6 where id=$1', [
        id, b.supplierId, b.code, b.title, b.district ?? null, b.active
      ]);
      await audit(c, req.user!.id, 'update', 'dealer_code', id, { before, after: b });
      return { id };
    });
  });

  // ---------------- Company orders ----------------
  app.get('/orders', { preHandler: requirePerm('purchase.read') }, async (req) => {
    const q = z
      .object({
        status: z.enum(['open', 'closed', 'cancelled']).optional(),
        supplierId: z.coerce.number().int().optional(),
        from: DateStr.optional(),
        to: DateStr.optional()
      })
      .parse(req.query);
    return app.read(req, (c) =>
      many(
        c,
        `${ORDER_LIST_SQL}
          where ($1::text is null or o.status = $1) and ($2::int is null or o.supplier_id = $2)
            and ($3::date is null or o.order_date >= $3) and ($4::date is null or o.order_date <= $4)
          order by o.order_date desc, o.id desc limit 500`,
        [q.status ?? null, q.supplierId ?? null, q.from ?? null, q.to ?? null]
      )
    );
  });

  app.get('/orders/:id', { preHandler: requirePerm('purchase.read') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.read(req, async (c) => {
      const o = await maybeOne(c, `${ORDER_LIST_SQL} where o.id = $1`, [id]);
      if (!o) throw notFound('Company order');
      const invoices = await many(
        c,
        `select i.id, i.invoice_no, i.invoice_date, i.bags, i.amount, i.due_date, i.journal_entry_id, e.entry_no,
                e.reversed_by is not null as reversed, u.full_name as created_by_name
           from company_invoices i join journal_entries e on e.id = i.journal_entry_id join users u on u.id = i.created_by
          where i.company_order_id = $1 order by i.invoice_date, i.id`,
        [id]
      );
      const receipts = await many(
        c,
        `select g.id, g.gr_no, g.business_date, g.truck_no, b.code as branch_code,
                (select sum(bags_received) from goods_receipt_lines l where l.gr_id = g.id)::int as bags,
                (select sum(bags_short) from goods_receipt_lines l where l.gr_id = g.id)::int as short,
                (select sum(bags_damaged) from goods_receipt_lines l where l.gr_id = g.id)::int as damaged
           from goods_receipts g join branches b on b.id = g.branch_id
          where g.company_order_id = $1 order by g.business_date, g.id`,
        [id]
      );
      const payments = await many(
        c,
        `select a.id, a.amount, v.id as voucher_id, v.business_date, v.mode, v.reference_no, e.entry_no,
                e.reversed_by is not null as reversed
           from company_payment_allocations a join cash_vouchers v on v.id = a.voucher_id
           join journal_entries e on e.id = v.journal_entry_id
          where a.company_order_id = $1 order by v.business_date, a.id`,
        [id]
      );
      return { ...o, invoices, receipts, payments };
    });
  });

  app.post('/orders', { preHandler: requirePerm('purchase.create') }, async (req) => {
    const b = OrderInput.parse(req.body);
    const date = b.orderDate ?? app.today();
    return app.mutate(req, 'company-orders.create', async (c) => {
      const dc = await maybeOne<{ supplier_id: number; active: boolean; code: string }>(
        c, 'select supplier_id, active, code from dealer_codes where id = $1', [b.dealerCodeId]);
      if (!dc) throw notFound('Dealer code');
      if (!dc.active) throw rule(`Dealer code ${dc.code} is inactive`);
      const r = await one<{ id: string; order_no: string }>(
        c,
        `insert into company_orders(order_no, company_order_no, order_date, firm_id, dealer_code_id, supplier_id, product_id,
                                    location_id, bags, rate, bg_charge_per_bag, freight_by, freight_per_bag, credit_days, note, created_by)
         select next_doc_no('PO',$1), $2, $1, dc.firm_id, dc.id, dc.supplier_id, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           from dealer_codes dc where dc.id = $3
         returning id, order_no`,
        [date, b.companyOrderNo || null, b.dealerCodeId, b.productId, b.locationId, b.bags, b.rate, b.bgChargePerBag,
          b.freightBy, b.freightPerBag, b.creditDays, b.note ?? null, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'company_order', r.order_no, b);
      return { id: r.id, orderNo: r.order_no };
    });
  });

  app.put('/orders/:id', { preHandler: requirePerm('purchase.create') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = OrderUpdate.parse(req.body);
    return app.mutate(req, 'company-orders.update', async (c) => {
      const before = await maybeOne<{ order_no: string; rate: string; bg_charge_per_bag: string }>(
        c, 'select * from company_orders where id = $1 for update', [id]);
      if (!before) throw notFound('Company order');
      const inv = await one<{ n: number }>(c, 'select count(*)::int as n from live_company_invoices where company_order_id = $1', [id]);
      if (inv.n > 0 && (toPaisa(before.rate) !== toPaisa(b.rate) || toPaisa(before.bg_charge_per_bag) !== toPaisa(b.bgChargePerBag))) {
        throw rule('The company has invoiced this order, so the rate and BG charge can no longer change');
      }
      await c.query(
        `update company_orders set company_order_no=$2, location_id=$3, bags=$4, rate=$5, bg_charge_per_bag=$6,
                freight_by=$7, freight_per_bag=$8, credit_days=$9, note=$10 where id=$1`,
        [id, b.companyOrderNo || null, b.locationId, b.bags, b.rate, b.bgChargePerBag, b.freightBy, b.freightPerBag, b.creditDays, b.note ?? null]
      );
      await audit(c, req.user!.id, 'update', 'company_order', before.order_no, { before, after: b });
      return { id };
    });
  });

  app.post('/orders/:id/close', { preHandler: requirePerm('purchase.create') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return app.mutate(req, 'company-orders.close', async (c) => {
      const o = await maybeOne<{ order_no: string; status: string }>(c, 'select order_no, status from company_orders where id = $1 for update', [id]);
      if (!o) throw notFound('Company order');
      if (o.status !== 'open') throw rule(`Order ${o.order_no} is already ${o.status}`);
      await c.query("update company_orders set status = 'closed' where id = $1", [id]);
      await audit(c, req.user!.id, 'close', 'company_order', o.order_no, {});
      return { id, status: 'closed' };
    });
  });

  app.post('/orders/:id/cancel', { preHandler: requirePerm('purchase.create') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(5, 'Give a reason') }).parse(req.body);
    return app.mutate(req, 'company-orders.cancel', async (c) => {
      const o = await maybeOne<{ order_no: string; status: string }>(c, 'select order_no, status from company_orders where id = $1 for update', [id]);
      if (!o) throw notFound('Company order');
      if (o.status !== 'open') throw rule(`Order ${o.order_no} is already ${o.status}`);
      const st = await one<{ invoiced_bags: number; received_bags: number; paid: string }>(
        c, 'select invoiced_bags, received_bags, paid from company_order_status where company_order_id = $1', [id]);
      if (st.invoiced_bags > 0 || st.received_bags > 0 || toPaisa(st.paid) !== 0n) {
        throw rule('This order already has invoices, goods received or payments. Close it instead of cancelling.');
      }
      await c.query("update company_orders set status = 'cancelled', cancel_reason = $2 where id = $1", [id, reason]);
      await audit(c, req.user!.id, 'cancel', 'company_order', o.order_no, { reason });
      return { id, status: 'cancelled' };
    });
  });

  // The company's invoice: posts a PV (Dr Purchases at the order's location / Cr Trade payables, the company).
  app.post('/orders/:id/invoices', { preHandler: requirePerm('purchase.create') }, async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    const b = InvoiceInput.parse(req.body);
    const date = b.invoiceDate ?? app.today();
    return app.mutate(req, 'company-invoices.create', async (c) => {
      const o = await maybeOne<{
        order_no: string; company_order_no: string | null; firm_id: number; supplier_id: number; location_id: number;
        rate: string; bg_charge_per_bag: string; credit_days: number; status: string; product_code: string;
      }>(
        c,
        `select o.*, p.code as product_code from company_orders o join products p on p.id = o.product_id where o.id = $1`,
        [id]
      );
      if (!o) throw notFound('Company order');
      if (o.status !== 'open') throw rule(`Order ${o.order_no} is ${o.status}`);
      const dup = await maybeOne(c, 'select 1 from company_invoices where company_order_id = $1 and invoice_no = $2', [id, b.invoiceNo]);
      if (dup) throw rule(`Invoice ${b.invoiceNo} is already recorded on this order`);
      const amount = b.amount ?? fromPaisa(BigInt(b.bags) * (toPaisa(o.rate) + toPaisa(o.bg_charge_per_bag)));
      const due = dueDate(date, o.credit_days);
      const co = o.company_order_no ? `, CO ${o.company_order_no}` : '';
      const entry = await postEntry(c, {
        firmId: o.firm_id,
        businessDate: date,
        narration: `Company invoice ${b.invoiceNo}: ${b.bags} bags ${o.product_code} on ${o.order_no}${co}`,
        sourceType: 'company_invoice',
        sourceId: o.order_no,
        createdBy: req.user!.id,
        lines: [
          { accountId: await accountId(c, ACC.purchases), debit: amount, branchId: o.location_id, memo: `${o.order_no} inv ${b.invoiceNo}` },
          { accountId: await accountId(c, ACC.payables), credit: amount, partyId: o.supplier_id, memo: `${o.order_no} inv ${b.invoiceNo}, due ${due}` }
        ]
      });
      const r = await one<{ id: string }>(
        c,
        `insert into company_invoices(company_order_id, invoice_no, invoice_date, bags, amount, due_date, journal_entry_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [id, b.invoiceNo, date, b.bags, amount, due, entry.id, req.user!.id]
      );
      await audit(c, req.user!.id, 'create', 'company_invoice', r.id, { order: o.order_no, ...b, amount, due, entryNo: entry.entryNo });
      return { id: r.id, entryNo: entry.entryNo, amount, dueDate: due };
    });
  });

  // For the goods-receipt screen: open orders and what is left to receive, without money.
  app.get('/open-for-receipt', { preHandler: requirePerm('stock.receive') }, async (req) =>
    app.read(req, (c) =>
      many(
        c,
        `select o.id, o.order_no, o.company_order_no, o.order_date, o.supplier_id, s.name_en as supplier_name,
                o.product_id, p.code as product_code, p.name_en as product_name, o.location_id, b.code as location_code,
                o.bags, st.received_bags, o.bags - st.received_bags as bags_left
           from company_orders o join company_order_status st on st.company_order_id = o.id
           join parties s on s.id = o.supplier_id join products p on p.id = o.product_id join branches b on b.id = o.location_id
          where o.status = 'open' and st.received_bags < o.bags
          order by o.order_date, o.id`
      )
    )
  );

  // What AKB owes each company, and what is due soon. Negative = advance paid.
  app.get('/payables', { preHandler: requirePerm('purchase.read') }, async (req) => {
    const q = z.object({ asOf: DateStr.optional() }).parse(req.query);
    const asOf = q.asOf ?? app.today();
    return app.read(req, async (c) => {
      const rows = await many<{ balance: string; overdue: string; due_7d: string }>(
        c,
        `with bal as (
           select pl.party_id, sum(pl.credit - pl.debit) as balance
             from posted_lines pl join accounts a on a.id = pl.account_id
            where a.control = 'payable' and pl.business_date <= $1 group by pl.party_id),
         due as (
           select o.supplier_id,
                  sum(case when i.due_date >= $1 then i.amount else 0 end) as not_due,
                  sum(case when i.due_date > $1::date + 7 then i.amount else 0 end) as later
             from live_company_invoices i join company_orders o on o.id = i.company_order_id group by o.supplier_id),
         x as (
           -- Payments clear the oldest invoices first, so what is unpaid is the newest.
           select p.id as supplier_id, p.code, p.name_en, coalesce(bal.balance, 0) as balance,
                  greatest(least(coalesce(bal.balance, 0), coalesce(due.not_due, 0)), 0) as unpaid_not_due,
                  coalesce(due.later, 0) as later
             from parties p left join bal on bal.party_id = p.id left join due on due.supplier_id = p.id
            where p.kind = 'supplier' and (bal.balance is not null or due.supplier_id is not null))
         select supplier_id, code, name_en, balance,
                greatest(balance - unpaid_not_due, 0) as overdue,
                unpaid_not_due - least(unpaid_not_due, later) as due_7d
           from x
          order by balance desc`,
        [asOf]
      );
      let total = 0n;
      let overdue = 0n;
      let due7 = 0n;
      for (const r of rows) {
        total += toPaisa(r.balance);
        overdue += toPaisa(r.overdue);
        due7 += toPaisa(r.due_7d);
      }
      return { asOf, rows, totals: { balance: fromPaisa(total), overdue: fromPaisa(overdue), due7d: fromPaisa(due7) } };
    });
  });
}
