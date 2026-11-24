-- 011_purchases_vouchers: the parts of EduSoft the team uses every day (Nov 2026).
--  * Voucher numbers by type, as in EduSoft: SV sales (dispatch), CRV receipts, CPV payments,
--    PV purchases (company invoices), OPV opening balances, JV everything else.
--  * Cash/bank payment and receipt vouchers, with the payment modes used for companies
--    (online/IBFT, BG ADJ, DD, CDS, CPR, DCF, DCF ADJ) and a proof file (IBFT screenshot).
--  * Opening balances, entered as an opening voucher that needs a second person's approval.
--  * Dealer codes (EduSoft "agencies"): AKB's code with each company, per district.
--  * Company orders (EduSoft "purchase orders"), the company's invoices against them, the goods
--    received against them, and payments to the company allocated to them.
--  * Sale points (EduSoft "sale point information"), linked to customers.

-- ---------------------------------------------------------------------------
-- Voucher numbering by type.
create or replace function voucher_prefix(p_source text) returns text language sql immutable as $$
  select case p_source
           when 'dispatch'        then 'SV'
           when 'receipt'         then 'CRV'
           when 'receipt_voucher' then 'CRV'
           when 'payment_voucher' then 'CPV'
           when 'company_invoice' then 'PV'
           when 'opening'         then 'OPV'
           else 'JV' end
$$;

create or replace function je_before_insert() returns trigger language plpgsql as $$
begin
  if new.reversed_by is not null then
    raise exception 'A new entry cannot already be reversed' using errcode = 'P0001';
  end if;
  if new.status = 'posted' then
    perform assert_day_open(new.business_date);
    new.posted_at := now();
    new.posted_txid := txid_current();
    new.entry_no := next_doc_no(voucher_prefix(new.source_type), new.business_date);
  else
    new.entry_no := null;
    new.posted_at := null;
    new.posted_txid := null;
  end if;
  return new;
end $$;

create or replace function je_before_update() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    if old.reversed_by is null and new.reversed_by is not null
       and (to_jsonb(new) - 'reversed_by') = (to_jsonb(old) - 'reversed_by') then
      return new;
    end if;
    raise exception 'Posted journal entry % cannot be changed; reverse it instead', old.entry_no
      using errcode = 'P0001';
  end if;
  if new.status = 'posted' then
    if old.status = 'pending_approval' and new.approved_by is not distinct from old.created_by then
      raise exception 'The person who created an entry cannot approve it' using errcode = 'P0001';
    end if;
    perform assert_day_open(new.business_date);
    new.posted_at := now();
    new.posted_txid := txid_current();
    new.entry_no := next_doc_no(voucher_prefix(new.source_type), new.business_date);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Chart of accounts: purchases are expensed as bought (EduSoft's "voucher posted through purchase").
-- To confirm with finance whether stock should instead be carried at cost (see the meeting questions).
insert into accounts(code, name, type, parent_id, postable)
  select '5050', 'Purchases', 'expense', id, true from accounts where code = '5000';

-- 008 inserted Main cash in the same statement as its group, so its parent was not found; put it
-- (and the import suspense account) where they belong in the tree.
update accounts set parent_id = (select id from accounts where code = '1100') where code = '1101' and parent_id is null;
update accounts set parent_id = (select id from accounts where code = '1000') where code = '9999' and parent_id is null;

-- New accounts must sit under a group of the same type.
create or replace function accounts_check() returns trigger language plpgsql as $$
declare p record;
begin
  if new.code !~ '^[0-9A-Z][0-9A-Z-]{1,19}$' then
    raise exception 'Account codes use digits, capital letters and dashes (2 to 20 characters)' using errcode = 'P0001';
  end if;
  if new.parent_id is not null then
    select type, postable into p from accounts where id = new.parent_id;
    if p.type <> new.type then
      raise exception 'An account must be the same type as the group it sits under' using errcode = 'P0001';
    end if;
    if p.postable then
      raise exception 'Accounts can only be added under a group (a heading account), not under an account that takes entries'
        using errcode = 'P0001';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.postable is distinct from old.postable
     and exists (select 1 from journal_lines where account_id = old.id) then
    raise exception 'An account that has entries cannot be turned into a group' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger accounts_check before insert or update of code, parent_id, type, postable on accounts
  for each row execute function accounts_check();

-- ---------------------------------------------------------------------------
-- Cash/bank vouchers. The voucher number is the journal entry's (CPV-2627-00001, CRV-...).
create table cash_vouchers (
  id               bigserial primary key,
  kind             text not null check (kind in ('payment','receipt')),
  business_date    date not null,
  money_account_id int  not null references accounts(id),
  mode             text not null check (mode in ('cash','cheque','online','bg_adj','dd','cds','cpr','dcf','dcf_adj')),
  reference_no     text,
  party_id         int references parties(id),
  narration        text not null,
  amount           numeric(18,2) not null check (amount > 0),
  journal_entry_id bigint not null unique references journal_entries(id),
  created_by       int not null references users(id),
  created_at       timestamptz not null default now()
);
create index cash_vouchers_date_idx on cash_vouchers(business_date);
create trigger cash_vouchers_no_change before update or delete on cash_vouchers
  for each row execute function forbid_change();

-- Proof of payment (IBFT screenshot, deposit slip): images or a PDF, at most 3 MB.
create table voucher_attachments (
  id          bigserial primary key,
  voucher_id  bigint not null references cash_vouchers(id),
  mime        text not null check (mime in ('image/jpeg','image/png','image/webp','application/pdf')),
  bytes       bytea not null,
  size        int not null check (size > 0 and size <= 3145728),
  sha256      text not null,
  created_by  int not null references users(id),
  created_at  timestamptz not null default now()
);
create index voucher_attachments_voucher_idx on voucher_attachments(voucher_id);
create trigger voucher_attachments_no_change before update or delete on voucher_attachments
  for each row execute function forbid_change();

-- ---------------------------------------------------------------------------
-- Dealer codes: AKB's account number with a company for a district (EduSoft "agency",
-- e.g. FFC SWL CC# 2130004749). Each company order is placed under one.
create table dealer_codes (
  id          serial primary key,
  firm_id     int  not null references firms(id),
  supplier_id int  not null references parties(id),
  code        text not null,
  title       text not null,
  district    text,
  active      boolean not null default true,
  created_by  int references users(id),
  created_at  timestamptz not null default now(),
  unique (supplier_id, code)
);

create or replace function assert_party_kind(p_party int, p_kind text, p_what text) returns void language plpgsql as $$
begin
  if not exists (select 1 from parties where id = p_party and kind = p_kind) then
    raise exception '% must be a % in the party list', p_what, p_kind using errcode = 'P0001';
  end if;
end $$;

create or replace function dealer_codes_check() returns trigger language plpgsql as $$
begin
  perform assert_party_kind(new.supplier_id, 'supplier', 'The company');
  return new;
end $$;
create trigger dealer_codes_check before insert or update on dealer_codes
  for each row execute function dealer_codes_check();

-- ---------------------------------------------------------------------------
-- Company orders (EduSoft "purchase orders"). One product per order, as booked with the company.
-- The rate includes all taxes; BG charges are added per bag when the order is on a BG.
create table company_orders (
  id                bigserial primary key,
  order_no          text not null unique,          -- PO-2627-00001, gapless
  company_order_no  text,                          -- the company's CO number (may arrive later)
  order_date        date not null,
  firm_id           int  not null references firms(id),
  dealer_code_id    int  not null references dealer_codes(id),
  supplier_id       int  not null references parties(id),
  product_id        int  not null references products(id),
  location_id       int  not null references branches(id),  -- where the bags will be held: an AKB store or maal at the plant
  bags              int  not null check (bags > 0),
  rate              numeric(18,2) not null check (rate > 0),
  bg_charge_per_bag numeric(18,2) not null default 0 check (bg_charge_per_bag >= 0),
  freight_by        text not null default 'company' check (freight_by in ('company','akb')),
  freight_per_bag   numeric(18,2) not null default 0 check (freight_per_bag >= 0),
  credit_days       int  not null default 0 check (credit_days in (0,30,60,90,180)),
  status            text not null default 'open' check (status in ('open','closed','cancelled')),
  note              text,
  cancel_reason     text,
  created_by        int  not null references users(id),
  created_at        timestamptz not null default now()
);
create unique index company_orders_co_no_idx on company_orders(supplier_id, company_order_no) where company_order_no is not null;
create index company_orders_date_idx on company_orders(order_date);

create or replace function company_orders_check() returns trigger language plpgsql as $$
declare dc record; loc text;
begin
  select supplier_id, firm_id into dc from dealer_codes where id = new.dealer_code_id;
  if dc.supplier_id <> new.supplier_id then
    raise exception 'The dealer code belongs to a different company' using errcode = 'P0001';
  end if;
  new.firm_id := dc.firm_id;
  select kind into loc from branches where id = new.location_id;
  if loc not in ('godown','office','sale_point','company_site','amanat') then
    raise exception 'Company orders are held at an AKB store, a company plant or a customer warehouse' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'open' then
      raise exception 'Company order % is % and cannot be changed', old.order_no, old.status using errcode = 'P0001';
    end if;
    if new.order_no <> old.order_no or new.supplier_id <> old.supplier_id or new.product_id <> old.product_id then
      raise exception 'The order number, company and product of an order cannot be changed' using errcode = 'P0001';
    end if;
    if new.bags < coalesce((select sum(bags) from live_company_invoices where company_order_id = old.id), 0) then
      raise exception 'Bags cannot be less than already invoiced' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- The company's invoices against an order (EduSoft "purchase invoice"). Each posts a PV:
--   Dr Purchases (at the order's location)  /  Cr Trade payables (the company)
-- Due date = invoice date + credit days - 1, as finance calculates it today.
create table company_invoices (
  id               bigserial primary key,
  company_order_id bigint not null references company_orders(id),
  invoice_no       text not null,
  invoice_date     date not null,
  bags             int  not null check (bags > 0),
  amount           numeric(18,2) not null check (amount > 0),
  due_date         date not null,
  journal_entry_id bigint not null unique references journal_entries(id),
  created_by       int  not null references users(id),
  created_at       timestamptz not null default now(),
  unique (company_order_id, invoice_no)
);
create trigger company_invoices_no_change before update or delete on company_invoices
  for each row execute function forbid_change();

-- An invoice or payment is corrected by reversing its voucher; a reversed one no longer counts.
create view live_company_invoices as
  select i.* from company_invoices i join journal_entries e on e.id = i.journal_entry_id
   where e.reversed_by is null;

create trigger company_orders_check before insert or update on company_orders
  for each row execute function company_orders_check();

create or replace function company_invoices_check() returns trigger language plpgsql as $$
declare o record; done int;
begin
  select * into o from company_orders where id = new.company_order_id for update;
  if o.status <> 'open' then
    raise exception 'Company order % is %', o.order_no, o.status using errcode = 'P0001';
  end if;
  select coalesce(sum(bags), 0) into done from live_company_invoices where company_order_id = o.id;
  if done + new.bags > o.bags then
    raise exception 'Only % bags of % are left to invoice', o.bags - done, o.order_no using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger company_invoices_check before insert on company_invoices
  for each row execute function company_invoices_check();

-- Payments to a company, allocated to its orders (a payment can be made before the invoice: an advance).
create table company_payment_allocations (
  id               bigserial primary key,
  voucher_id       bigint not null references cash_vouchers(id),
  company_order_id bigint not null references company_orders(id),
  amount           numeric(18,2) not null check (amount > 0),
  created_by       int not null references users(id),
  created_at       timestamptz not null default now(),
  unique (voucher_id, company_order_id)
);
create trigger company_payment_allocations_no_change before update or delete on company_payment_allocations
  for each row execute function forbid_change();

create view live_company_payment_allocations as
  select a.* from company_payment_allocations a
    join cash_vouchers v on v.id = a.voucher_id join journal_entries e on e.id = v.journal_entry_id
   where e.reversed_by is null;

create or replace function company_payment_allocations_check() returns trigger language plpgsql as $$
declare v record; o record;
begin
  -- One allocation at a time per payment, so two at once cannot both fit under the amount.
  perform pg_advisory_xact_lock(11001, new.voucher_id::int);
  select * into v from cash_vouchers where id = new.voucher_id;
  select * into o from company_orders where id = new.company_order_id;
  if exists (select 1 from journal_entries where id = v.journal_entry_id and reversed_by is not null) then
    raise exception 'This payment has been reversed' using errcode = 'P0001';
  end if;
  if v.kind <> 'payment' or v.party_id is distinct from o.supplier_id then
    raise exception 'A payment can only be allocated to orders of the company it paid' using errcode = 'P0001';
  end if;
  if o.status = 'cancelled' then
    raise exception 'Company order % is cancelled', o.order_no using errcode = 'P0001';
  end if;
  if (select coalesce(sum(amount), 0) from company_payment_allocations where voucher_id = v.id) + new.amount > v.amount then
    raise exception 'Allocations are more than the payment' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger company_payment_allocations_check before insert on company_payment_allocations
  for each row execute function company_payment_allocations_check();

-- Goods received against a company order: the order's product, and no more bags than ordered.
alter table goods_receipts add column company_order_id bigint references company_orders(id);

create or replace function goods_receipts_order_check() returns trigger language plpgsql as $$
declare o record;
begin
  if new.company_order_id is null then return new; end if;
  select * into o from company_orders where id = new.company_order_id;
  if o.status <> 'open' then
    raise exception 'Company order % is %', o.order_no, o.status using errcode = 'P0001';
  end if;
  new.supplier_id := o.supplier_id;
  return new;
end $$;
create trigger goods_receipts_order_check before insert on goods_receipts
  for each row execute function goods_receipts_order_check();

create or replace function goods_receipt_lines_order_check() returns trigger language plpgsql as $$
declare o record; got int;
begin
  select co.* into o from goods_receipts g join company_orders co on co.id = g.company_order_id where g.id = new.gr_id;
  if not found then return new; end if;
  perform pg_advisory_xact_lock(11002, o.id::int);
  if new.product_id <> o.product_id then
    raise exception 'Company order % is for a different product', o.order_no using errcode = 'P0001';
  end if;
  select coalesce(sum(l.bags_received), 0) into got
    from goods_receipt_lines l join goods_receipts g on g.id = l.gr_id where g.company_order_id = o.id;
  if got + new.bags_received > o.bags then
    raise exception 'Only % bags of % are left to receive', o.bags - got, o.order_no using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger goods_receipt_lines_order_check before insert on goods_receipt_lines
  for each row execute function goods_receipt_lines_order_check();

-- Where each order stands. Value = bags x (rate + BG charge). Payable = invoiced - paid (negative = advance).
create or replace view company_order_status as
  select o.id as company_order_id,
         o.bags,
         o.bags * (o.rate + o.bg_charge_per_bag) as order_value,
         coalesce(i.bags, 0)::int as invoiced_bags,
         coalesce(i.amount, 0) as invoiced_amount,
         coalesce(g.bags, 0)::int as received_bags,
         coalesce(p.amount, 0) as paid,
         coalesce(i.amount, 0) - coalesce(p.amount, 0) as payable,
         case when coalesce(i.amount, 0) - coalesce(p.amount, 0) > 0 then i.first_due end as due_date
    from company_orders o
    left join (select company_order_id, sum(bags) as bags, sum(amount) as amount, min(due_date) as first_due
                 from live_company_invoices group by company_order_id) i on i.company_order_id = o.id
    left join (select gr.company_order_id, sum(l.bags_received) as bags
                 from goods_receipts gr join goods_receipt_lines l on l.gr_id = gr.id
                where gr.company_order_id is not null group by gr.company_order_id) g on g.company_order_id = o.id
    left join (select company_order_id, sum(amount) as amount from live_company_payment_allocations group by company_order_id) p
      on p.company_order_id = o.id;

-- ---------------------------------------------------------------------------
-- Sale points (EduSoft "sale point information"): the areas customers are grouped into,
-- each with its district, tehsil and sales rep.
create table sale_points (
  id          serial primary key,
  code        text unique,
  name_en     text not null,
  name_ur     text,
  district    text,
  tehsil      text,
  rep_user_id int references users(id),
  active      boolean not null default true,
  created_by  int references users(id),
  created_at  timestamptz not null default now()
);
create or replace function sale_points_assign_code() returns trigger language plpgsql as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := next_code('SP', 3);
  else
    perform bump_code_counter('SP', new.code);
  end if;
  return new;
end $$;
create trigger sale_points_assign_code before insert on sale_points
  for each row execute function sale_points_assign_code();

alter table parties add column sale_point_id int references sale_points(id);

-- ---------------------------------------------------------------------------
-- Permissions
insert into permissions(code, description) values
  ('accounts.manage',  'Add and edit ledger accounts in the chart of accounts'),
  ('voucher.create',   'Record cash and bank payment and receipt vouchers'),
  ('opening.create',   'Enter opening balances (a second person approves them)'),
  ('purchase.read',    'View company orders, company invoices and payments to companies'),
  ('purchase.create',  'Book company orders and record company invoices');

insert into role_permissions(role_code, permission_code) values
  ('owner','accounts.manage'), ('owner','voucher.create'), ('owner','opening.create'), ('owner','purchase.read'), ('owner','purchase.create'),
  ('accounts','accounts.manage'), ('accounts','voucher.create'), ('accounts','opening.create'), ('accounts','purchase.read'), ('accounts','purchase.create'),
  ('finance','voucher.create'), ('finance','purchase.read'),
  ('procurement','purchase.read'), ('procurement','purchase.create'),
  ('auditor','purchase.read');

grant select, insert on cash_vouchers, voucher_attachments, dealer_codes, company_orders, company_invoices,
  company_payment_allocations, sale_points to akb_app;
grant update on dealer_codes, company_orders, sale_points to akb_app;
grant select on company_order_status, live_company_invoices, live_company_payment_allocations to akb_app;
grant usage, select on sequence cash_vouchers_id_seq, voucher_attachments_id_seq, dealer_codes_id_seq, company_orders_id_seq,
  company_invoices_id_seq, company_payment_allocations_id_seq, sale_points_id_seq to akb_app;
