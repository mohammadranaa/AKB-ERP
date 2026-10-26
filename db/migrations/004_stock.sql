-- 004_stock: stock is never typed in. It is the sum of movements, and movements are append-only.

create table stock_movements (
  id             bigserial primary key,
  business_date  date not null,
  kind           text not null check (kind in ('opening','receipt','dispatch','transfer_out','transfer_in','adjustment')),
  product_id     int not null references products(id),
  branch_id      int not null references branches(id),
  bags           int not null check (bags <> 0),
  ref_type       text not null,
  ref_id         text not null,
  note           text,
  created_by     int not null references users(id),
  created_at     timestamptz not null default now(),
  check (
    (kind in ('opening','receipt','transfer_in') and bags > 0) or
    (kind in ('dispatch','transfer_out') and bags < 0) or
    (kind = 'adjustment')
  )
);
create index sm_product_branch_idx on stock_movements(product_id, branch_id);
create index sm_ref_idx on stock_movements(ref_type, ref_id);

create or replace function sm_before_insert() returns trigger language plpgsql as $$
declare
  on_hand bigint;
begin
  perform assert_day_open(new.business_date);
  -- Serialise movements for one product at one branch so the balance check is reliable.
  perform pg_advisory_xact_lock(new.product_id, new.branch_id);
  if new.bags < 0 then
    select coalesce(sum(bags),0) into on_hand from stock_movements
      where product_id = new.product_id and branch_id = new.branch_id;
    if on_hand + new.bags < 0 then
      raise exception 'Not enough stock: % bags on hand, % requested', on_hand, -new.bags
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger sm_before_insert before insert on stock_movements
  for each row execute function sm_before_insert();
create trigger sm_no_change before update or delete on stock_movements
  for each row execute function forbid_change();

create view stock_on_hand as
  select product_id, branch_id, sum(bags)::bigint as bags
    from stock_movements group by product_id, branch_id;

-- ---------------------------------------------------------------------------
create table goods_receipts (
  id             bigserial primary key,
  gr_no          text not null unique,
  business_date  date not null,
  branch_id      int not null references branches(id),
  supplier_id    int references parties(id),
  company_order_ref text,          -- the company's CO number until the finance module links orders
  truck_no       text,
  note           text,
  created_by     int not null references users(id),
  created_at     timestamptz not null default now()
);

create table goods_receipt_lines (
  id             bigserial primary key,
  gr_id          bigint not null references goods_receipts(id),
  product_id     int not null references products(id),
  bags_received  int not null check (bags_received > 0),
  bags_short     int not null default 0 check (bags_short >= 0),
  bags_damaged   int not null default 0 check (bags_damaged >= 0)
);

create table stock_transfers (
  id             bigserial primary key,
  transfer_no    text not null unique,
  business_date  date not null,
  from_branch_id int not null references branches(id),
  to_branch_id   int not null references branches(id),
  truck_no       text,
  status         text not null default 'in_transit' check (status in ('in_transit','received')),
  created_by     int not null references users(id),
  created_at     timestamptz not null default now(),
  received_by    int references users(id),
  received_at    timestamptz,
  received_date  date,
  check (from_branch_id <> to_branch_id)
);

create table stock_transfer_lines (
  id           bigserial primary key,
  transfer_id  bigint not null references stock_transfers(id),
  product_id   int not null references products(id),
  bags         int not null check (bags > 0)
);

create table stock_adjustments (
  id             bigserial primary key,
  adj_no         text not null unique,
  business_date  date not null,
  branch_id      int not null references branches(id),
  product_id     int not null references products(id),
  bags           int not null check (bags <> 0),
  reason         text not null,
  status         text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by   int not null references users(id),
  requested_at   timestamptz not null default now(),
  decided_by     int references users(id),
  decided_at     timestamptz,
  decision_note  text
);
