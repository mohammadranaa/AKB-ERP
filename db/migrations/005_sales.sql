-- 005_sales: orders generated (OGs), dispatches, receipts and their allocation, cheque returns.
-- Payment status is never stored: it is derived from allocations (see og_status view).

create table ogs (
  id                bigserial primary key,
  og_no             text unique,                -- assigned on submit
  business_date     date not null,
  customer_id       int not null references parties(id),
  branch_id         int not null references branches(id),
  terms             text not null check (terms in ('cbd','credit','loan')),
  advance_pct       numeric(5,2) not null default 0 check (advance_pct between 0 and 100),
  credit_days       int not null default 0 check (credit_days >= 0),
  freight_by        text not null default 'customer' check (freight_by in ('customer','akb')),
  freight_per_bag   numeric(18,2) not null default 0 check (freight_per_bag >= 0),
  discount          numeric(18,2) not null default 0 check (discount >= 0),
  status            text not null default 'draft' check (status in ('draft','submitted','approved','rejected','cancelled')),
  approval_reasons  text[] not null default '{}',
  unpurchased_bags  int not null default 0 check (unpurchased_bags >= 0),
  due_date          date,
  note              text,
  created_by        int not null references users(id),
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  decided_by        int references users(id),
  decided_at        timestamptz,
  decision_comment  text,
  rep_user_id       int references users(id)       -- copied from the customer for row-level security
);
create index ogs_customer_idx on ogs(customer_id);
create index ogs_status_idx on ogs(status);

create table og_lines (
  id            bigserial primary key,
  og_id         bigint not null references ogs(id),
  line_no       int not null,
  product_id    int not null references products(id),
  bags          int not null check (bags > 0),
  rate          numeric(18,2) not null check (rate > 0),
  floor_price   numeric(18,2),
  unique (og_id, line_no)
);

-- An OG's lines are fixed once it leaves draft.
create or replace function og_lines_guard() returns trigger language plpgsql as $$
declare st text;
begin
  select status into st from ogs where id = coalesce(new.og_id, old.og_id);
  if st <> 'draft' then
    raise exception 'Lines of a submitted OG cannot be changed' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger og_lines_guard before insert or update or delete on og_lines
  for each row execute function og_lines_guard();

-- ---------------------------------------------------------------------------
create table dispatches (
  id               bigserial primary key,
  dispatch_no      text not null unique,
  og_id            bigint not null references ogs(id),
  business_date    date not null,
  branch_id        int not null references branches(id),
  truck_no         text not null,
  driver_name      text,
  bilty_no         text,
  gate_pass_no     text not null unique,
  transporter_id   int references parties(id),
  freight_per_bag  numeric(18,2) not null default 0 check (freight_per_bag >= 0),
  loading_charges  numeric(18,2) not null default 0 check (loading_charges >= 0),
  goods_value      numeric(18,2) not null default 0,
  freight_value    numeric(18,2) not null default 0,   -- freight charged to the customer
  discount_value   numeric(18,2) not null default 0,   -- share of the OG discount
  journal_entry_id bigint references journal_entries(id),
  created_by       int not null references users(id),
  created_at       timestamptz not null default now()
);

create table dispatch_lines (
  id            bigserial primary key,
  dispatch_id   bigint not null references dispatches(id),
  og_line_id    bigint not null references og_lines(id),
  product_id    int not null references products(id),
  bags          int not null check (bags > 0)
);
create trigger dispatch_lines_no_change before update or delete on dispatch_lines
  for each row execute function forbid_change();
create trigger dispatches_no_change before update or delete on dispatches
  for each row execute function forbid_change();

-- ---------------------------------------------------------------------------
create table receipts (
  id               bigserial primary key,
  receipt_no       text not null unique,
  business_date    date not null,
  party_id         int not null references parties(id),
  mode             text not null check (mode in ('cash','bank_transfer','cheque','online')),
  account_id       int not null references accounts(id),   -- cash or bank ledger account
  instrument_no    text,
  drawer_bank      text,
  amount           numeric(18,2) not null check (amount > 0),
  status           text not null default 'posted' check (status in ('posted','returned')),
  journal_entry_id bigint not null references journal_entries(id),
  note             text,
  created_by       int not null references users(id),
  created_at       timestamptz not null default now(),
  rep_user_id      int references users(id),
  check (mode = 'cash' or instrument_no is not null)
);
create unique index receipts_cheque_unique on receipts (lower(coalesce(drawer_bank,'')), instrument_no)
  where mode = 'cheque';

create table receipt_allocations (
  id            bigserial primary key,
  receipt_id    bigint not null references receipts(id),
  og_id         bigint not null references ogs(id),
  amount        numeric(18,2) not null check (amount > 0),
  created_by    int not null references users(id),
  created_at    timestamptz not null default now(),
  reversed_at   timestamptz,
  reversed_by_return_id bigint
);
create index ra_og_idx on receipt_allocations(og_id);

create table cheque_returns (
  id               bigserial primary key,
  return_no        text not null unique,
  receipt_id       bigint not null unique references receipts(id),
  business_date    date not null,
  reason           text not null,
  bank_charges     numeric(18,2) not null default 0 check (bank_charges >= 0),
  journal_entry_id bigint not null references journal_entries(id),
  created_by       int not null references users(id),
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Derived OG figures. Value = goods + freight charged to customer − discount.
create view og_totals as
  select o.id as og_id,
         coalesce(sum(l.bags),0)::bigint as bags,
         coalesce(sum(l.bags * l.rate),0) as goods_value,
         case when o.freight_by = 'customer' then coalesce(sum(l.bags),0) * o.freight_per_bag else 0 end as freight_value,
         coalesce(sum(l.bags * l.rate),0)
           + case when o.freight_by = 'customer' then coalesce(sum(l.bags),0) * o.freight_per_bag else 0 end
           - o.discount as total_value
    from ogs o left join og_lines l on l.og_id = o.id
   group by o.id;

create view og_dispatched as
  select o.id as og_id, coalesce(sum(dl.bags),0)::bigint as bags
    from ogs o
    left join og_lines ol on ol.og_id = o.id
    left join dispatch_lines dl on dl.og_line_id = ol.id
   group by o.id;

create view og_line_dispatched as
  select ol.id as og_line_id, ol.og_id, ol.bags, coalesce(sum(dl.bags),0)::bigint as dispatched
    from og_lines ol left join dispatch_lines dl on dl.og_line_id = ol.id
   group by ol.id;

create view og_paid as
  select o.id as og_id, coalesce(sum(a.amount) filter (where a.reversed_at is null),0) as paid
    from ogs o left join receipt_allocations a on a.og_id = o.id
   group by o.id;

create view og_status as
  select o.id as og_id,
         t.bags, t.total_value, d.bags as dispatched_bags, p.paid,
         t.total_value - p.paid as outstanding,
         case
           when o.status in ('draft','submitted','rejected','cancelled') then initcap(o.status)
           when d.bags = 0 then 'Approved'
           when d.bags < t.bags then 'Partly dispatched'
           else 'Dispatched'
         end as fulfilment,
         case
           when p.paid >= t.total_value and t.total_value > 0 then 'Paid'
           when o.due_date is not null and o.due_date < current_date and o.status = 'approved' then 'Overdue'
           when p.paid > 0 then 'Partly paid'
           else 'Unpaid'
         end as payment
    from ogs o
    join og_totals t on t.og_id = o.id
    join og_dispatched d on d.og_id = o.id
    join og_paid p on p.og_id = o.id;

-- Committed stock: approved OG bags not yet dispatched, per product and branch.
create view stock_committed as
  select o.branch_id, ld.og_line_id, l.product_id, (ld.bags - ld.dispatched)::bigint as bags
    from og_line_dispatched ld
    join og_lines l on l.id = ld.og_line_id
    join ogs o on o.id = ld.og_id
   where o.status = 'approved' and ld.bags > ld.dispatched;
