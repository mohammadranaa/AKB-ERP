-- 001_core: organisation, users, roles, sessions, audit log, numbering, idempotency.
-- Runs as the owner role. The application connects as akb_app (see 000_roles in db/README.md).

create extension if not exists pgcrypto;
create extension if not exists citext;

-- ---------------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------------
create table firms (
  id          serial primary key,
  code        text not null unique,
  name        text not null,
  legal_name  text,
  created_at  timestamptz not null default now()
);

create table branches (
  id        serial primary key,
  firm_id   int not null references firms(id),
  code      text not null unique,
  name_en   text not null,
  name_ur   text,
  kind      text not null default 'godown' check (kind in ('godown','office','sale_point')),
  owned     boolean,
  active    boolean not null default true
);

-- Business vs personal vs rental separation on every ledger line.
create table cost_centres (
  id    serial primary key,
  code  text not null unique,
  name  text not null
);

-- ---------------------------------------------------------------------------
-- Roles and permissions
-- ---------------------------------------------------------------------------
create table roles (
  code        text primary key,
  name        text not null,
  description text
);

create table permissions (
  code        text primary key,
  description text not null
);

create table role_permissions (
  role_code       text not null references roles(code),
  permission_code text not null references permissions(code),
  primary key (role_code, permission_code)
);

create table users (
  id              serial primary key,
  username        citext not null unique,
  full_name       text not null,
  role_code       text not null references roles(code),
  branch_ids      int[],              -- null = all branches
  active          boolean not null default true,
  password_hash   text not null,
  totp_secret     text,
  totp_enabled    boolean not null default false,
  failed_logins   int not null default 0,
  locked_until    timestamptz,
  must_change_pw  boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      int references users(id)
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       int not null references users(id),
  token_hash    text not null unique,     -- sha256 of the bearer token; the token itself is never stored
  scope         text not null default 'full' check (scope in ('full','limited')),  -- limited: must change password / set up 2FA first
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
create index sessions_user_idx on sessions(user_id);

-- ---------------------------------------------------------------------------
-- Audit log: append-only, each row hashed with the previous row's hash.
-- Timestamps are hashed as microseconds since 1970 so the hash does not depend on the session time zone.
-- ---------------------------------------------------------------------------
create table audit_log (
  id         bigserial primary key,
  at         timestamptz not null default clock_timestamp(),
  user_id    int references users(id),
  action     text not null,
  entity     text not null,
  entity_id  text,
  detail     jsonb,
  prev_hash  text,
  hash       text not null
);
create index audit_entity_idx on audit_log(entity, entity_id);

create or replace function audit_log_chain() returns trigger language plpgsql as $$
declare
  last_hash text;
begin
  -- Serialise writers so the chain has no forks.
  perform pg_advisory_xact_lock(724001);
  select hash into last_hash from audit_log order by id desc limit 1;
  new.prev_hash := last_hash;
  new.hash := encode(digest(
      coalesce(last_hash, '') || '|' || (extract(epoch from new.at) * 1000000)::bigint::text || '|' || coalesce(new.user_id::text, '') || '|' ||
      new.action || '|' || new.entity || '|' || coalesce(new.entity_id, '') || '|' || coalesce(new.detail::text, ''),
      'sha256'), 'hex');
  return new;
end $$;

create trigger audit_log_chain before insert on audit_log
  for each row execute function audit_log_chain();

create or replace function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op
    using errcode = 'P0001';
end $$;

create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function forbid_change();

-- Recompute the chain and return the first broken row id, or null if intact.
create or replace function audit_log_verify() returns bigint language plpgsql as $$
declare
  r record;
  expected text;
  last_hash text := null;
begin
  for r in select * from audit_log order by id loop
    expected := encode(digest(
      coalesce(last_hash, '') || '|' || (extract(epoch from r.at) * 1000000)::bigint::text || '|' || coalesce(r.user_id::text, '') || '|' ||
      r.action || '|' || r.entity || '|' || coalesce(r.entity_id, '') || '|' || coalesce(r.detail::text, ''),
      'sha256'), 'hex');
    if r.hash <> expected or r.prev_hash is distinct from last_hash then
      return r.id;
    end if;
    last_hash := r.hash;
  end loop;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Gapless document numbers (sequences skip numbers on rollback; this does not).
-- Fiscal year in Pakistan runs July to June: FY 2026-27 is labelled 2627.
-- ---------------------------------------------------------------------------
create table doc_counters (
  doc_type  text not null,
  fy_label  text not null,
  next_no   int  not null default 1,
  primary key (doc_type, fy_label)
);

create or replace function fy_label(d date) returns text language sql immutable as $$
  select case when extract(month from d) >= 7
    then lpad((extract(year from d)::int % 100)::text, 2, '0') || lpad(((extract(year from d)::int + 1) % 100)::text, 2, '0')
    else lpad(((extract(year from d)::int - 1) % 100)::text, 2, '0') || lpad((extract(year from d)::int % 100)::text, 2, '0')
  end
$$;

create or replace function next_doc_no(p_doc_type text, p_date date) returns text language plpgsql as $$
declare
  fy text := fy_label(p_date);
  n int;
begin
  insert into doc_counters(doc_type, fy_label) values (p_doc_type, fy)
    on conflict do nothing;
  update doc_counters set next_no = next_no + 1
    where doc_type = p_doc_type and fy_label = fy
    returning next_no - 1 into n;
  return p_doc_type || '-' || fy || '-' || lpad(n::text, 5, '0');
end $$;

-- ---------------------------------------------------------------------------
-- Idempotency: a retried request with the same key returns the first response.
-- ---------------------------------------------------------------------------
create table idempotency_keys (
  key          text not null,
  user_id      int  not null references users(id),
  route        text not null,
  status_code  int  not null,
  response     jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (key, user_id)
);

-- Session context helpers used by row-level security.
create or replace function app_user_id() returns int language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::int
$$;
create or replace function app_role() returns text language sql stable as $$
  select nullif(current_setting('app.role', true), '')
$$;
