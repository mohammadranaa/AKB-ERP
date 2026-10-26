-- 002_masters: parties and products.

create table parties (
  id            serial primary key,
  code          text not null unique,
  kind          text not null check (kind in ('customer','supplier','transporter','tenant','employee','other')),
  name_en       text not null,
  name_ur       text,
  city          text,
  phone         text,
  tax_no        text,
  filer         boolean,
  credit_limit  numeric(18,2) not null default 0 check (credit_limit >= 0),
  credit_days   int not null default 30 check (credit_days >= 0),
  rep_user_id   int references users(id),   -- sales rep who owns this customer
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    int references users(id)
);
create index parties_kind_idx on parties(kind);
create index parties_rep_idx on parties(rep_user_id);
create index parties_name_trgm on parties (lower(name_en));

create table products (
  id            serial primary key,
  code          text not null unique,
  name_en       text not null,
  name_ur       text,
  manufacturer  text not null,
  nutrient      text,                      -- urea, DAP, NP, CAN, SSP, SOP, MOP, AS
  bag_kg        numeric(6,2) not null default 50 check (bag_kg > 0),
  floor_price   numeric(18,2) check (floor_price is null or floor_price > 0),
  active        boolean not null default true
);
