-- 010_sources_delivery: changes agreed with the client after the questionnaire (Nov 2026).
--  * Stock locations beyond AKB's own stores: company warehouses/plants, customer warehouses
--    holding AKB stock (amanat), and dealers AKB buys from to sell on (trading, no stock kept).
--  * Codes for parties and new locations are assigned by the system.
--  * OG terms are only credit or cash; no discounts on OGs; freight is settled per dispatch.
--  * Dispatches record vehicle and driver details and photos of the loading.

-- ---------------------------------------------------------------------------
-- System-assigned codes (C0008, AM001 ...). One counter row per prefix.
create table code_counters (
  prefix text primary key,
  last   int  not null
);

create or replace function next_code(p_prefix text, p_width int) returns text language plpgsql as $$
declare n int;
begin
  insert into code_counters(prefix, last) values (p_prefix, 1)
    on conflict (prefix) do update set last = code_counters.last + 1
    returning last into n;
  return p_prefix || case when length(n::text) >= p_width then n::text else lpad(n::text, p_width, '0') end;
end $$;

create or replace function party_code_prefix(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'customer' then 'C' when 'supplier' then 'S' when 'transporter' then 'T'
                     when 'tenant' then 'R' when 'employee' then 'E' else 'O' end
$$;

-- Start each counter after the highest code already in use.
insert into code_counters(prefix, last)
  select pfx, max(coalesce(substring(code from '^' || pfx || '(\d+)$')::int, 0))
    from (select party_code_prefix(kind) as pfx, code from parties) x
   group by pfx;

-- A code given explicitly (imports, demo data) moves the counter past it, so automatic codes never collide.
create or replace function bump_code_counter(p_prefix text, p_code text) returns void language plpgsql as $$
declare n int;
begin
  n := substring(p_code from '^' || p_prefix || '(\d+)$')::int;
  if n is not null then
    insert into code_counters(prefix, last) values (p_prefix, n)
      on conflict (prefix) do update set last = greatest(code_counters.last, excluded.last);
  end if;
end $$;

create or replace function parties_assign_code() returns trigger language plpgsql as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := next_code(party_code_prefix(new.kind), 4);
  else
    perform bump_code_counter(party_code_prefix(new.kind), new.code);
  end if;
  return new;
end $$;
create trigger parties_assign_code before insert on parties
  for each row execute function parties_assign_code();

-- ---------------------------------------------------------------------------
-- Stock locations. 'godown', 'office' and 'sale_point' are AKB's own stores.
alter table branches drop constraint branches_kind_check;
alter table branches add constraint branches_kind_check
  check (kind in ('godown','office','sale_point','company_site','amanat','dealer'));
alter table branches add column party_id   int references parties(id);
alter table branches add column city       text;
alter table branches add column created_by int references users(id);
alter table branches add column created_at timestamptz not null default now();
-- A customer warehouse belongs to that customer; a trading source is a dealer (any party).
alter table branches add constraint branches_party_needed
  check (kind not in ('amanat','dealer') or party_id is not null);

create or replace function location_code_prefix(p_kind text) returns text language sql immutable as $$
  select case p_kind when 'company_site' then 'CS' when 'amanat' then 'AM' when 'dealer' then 'DL' else 'WH' end
$$;

insert into code_counters(prefix, last)
  select pfx, max(coalesce(substring(code from '^' || pfx || '(\d+)$')::int, 0))
    from (select location_code_prefix(kind) as pfx, code from branches) x
   group by pfx
  on conflict (prefix) do update set last = greatest(code_counters.last, excluded.last);

create or replace function branches_assign_code() returns trigger language plpgsql as $$
begin
  if new.code is null or btrim(new.code) = '' then
    new.code := next_code(location_code_prefix(new.kind), 3);
  else
    perform bump_code_counter(location_code_prefix(new.kind), new.code);
  end if;
  return new;
end $$;
create trigger branches_assign_code before insert on branches
  for each row execute function branches_assign_code();

-- ---------------------------------------------------------------------------
-- OGs: terms are credit or cash (cbd); no discounts; freight is not added on the OG
-- (freight_by now means delivery: 'akb' = Pohnch, AKB delivers; 'customer' = X, customer collects).
-- NOT VALID keeps any older rows as they are; every new or changed OG must follow the rules.
alter table ogs drop constraint ogs_terms_check;
alter table ogs add constraint ogs_terms_check check (terms in ('cbd','credit')) not valid;
alter table ogs add constraint ogs_no_discount check (discount = 0) not valid;
alter table ogs add constraint ogs_no_og_freight check (freight_per_bag = 0) not valid;

-- ---------------------------------------------------------------------------
-- Dispatches: vehicle and driver details, and how the freight was settled.
--   akb_cost             Pohnch: AKB pays the transporter; freight is AKB's cost.
--   customer_paid        Pohnch: the customer paid the transporter for AKB; the customer is credited.
--   charged_to_customer  AKB paid (or owes) the transporter; the amount is added to the customer's account.
--   none                 X: the customer arranged and paid the transport; nothing for AKB to record.
alter table dispatches add column vehicle_details text;
alter table dispatches add column driver_phone   text;
alter table dispatches add column driver_cnic    text;
alter table dispatches add column delivery       text not null default 'x' check (delivery in ('pohnch','x'));
alter table dispatches add column freight_settlement text not null default 'none'
  check (freight_settlement in ('akb_cost','customer_paid','charged_to_customer','none'));
alter table dispatches alter column branch_id drop not null;

create table dispatch_photos (
  id          bigserial primary key,
  dispatch_id bigint not null references dispatches(id),
  mime        text not null check (mime in ('image/jpeg','image/png','image/webp')),
  bytes       bytea not null,
  size        int not null check (size > 0 and size <= 3145728),
  sha256      text not null,
  created_by  int not null references users(id),
  created_at  timestamptz not null default now()
);
create index dispatch_photos_dispatch_idx on dispatch_photos(dispatch_id);
create trigger dispatch_photos_no_change before update or delete on dispatch_photos
  for each row execute function forbid_change();

-- ---------------------------------------------------------------------------
-- OG value = goods + freight added to (or credited to) the customer at dispatch − discount (now always 0).
create or replace view og_totals as
  select o.id as og_id,
         coalesce(l.bags, 0)::bigint as bags,
         coalesce(l.goods, 0) as goods_value,
         coalesce(d.freight, 0) as freight_value,
         coalesce(l.goods, 0) + coalesce(d.freight, 0) - o.discount as total_value
    from ogs o
    left join (select og_id, sum(bags) as bags, sum(bags * rate) as goods from og_lines group by og_id) l on l.og_id = o.id
    left join (select og_id, sum(freight_value) as freight from dispatches group by og_id) d on d.og_id = o.id;

-- ---------------------------------------------------------------------------
-- Permissions
insert into permissions(code, description) values
  ('customer.create',  'Add customers (a sales rep''s new customers are assigned to them)'),
  ('locations.manage', 'Add stock locations: company warehouses, customer warehouses (amanat), trading dealers');

insert into role_permissions(role_code, permission_code) values
  ('owner','customer.create'), ('owner','locations.manage'),
  ('sales','customer.create'), ('sales','locations.manage'),
  ('accounts','customer.create'),
  ('distribution','locations.manage'),
  ('admin','customer.create'), ('admin','locations.manage');

grant select, insert, update on code_counters to akb_app;
grant select, insert on dispatch_photos to akb_app;
grant usage, select on sequence dispatch_photos_id_seq to akb_app;
