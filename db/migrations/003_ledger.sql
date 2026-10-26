-- 003_ledger: chart of accounts, double-entry journal, day locks.
-- Rules enforced here, not only in the API:
--   * every posted entry balances (debits = credits, at least two lines)
--   * posted entries and their lines can never be updated or deleted; corrections are reversals
--   * nothing can be posted into a locked business day
--   * receivable/payable lines must name a party
--   * posted entries get a gapless number per fiscal year

create table accounts (
  id           serial primary key,
  code         text not null unique,
  name         text not null,
  type         text not null check (type in ('asset','liability','equity','income','expense')),
  parent_id    int references accounts(id),
  postable     boolean not null default true,
  control      text check (control in ('receivable','payable','bank','cash')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

create table bank_accounts (
  id            serial primary key,
  account_id    int not null unique references accounts(id),
  bank_name     text not null,
  branch_name   text,
  account_title text,
  account_no    text,
  active        boolean not null default true
);

create table business_days (
  business_date  date primary key,
  status         text not null default 'open' check (status in ('open','locked')),
  locked_at      timestamptz,
  locked_by      int references users(id),
  checklist      jsonb,
  export_sha256  text,           -- checksum of the stored Excel day book
  export_xlsx    bytea,          -- the day book exactly as generated at lock time
  export_csv     text,
  csv_sha256     text
);

create table journal_entries (
  id            bigserial primary key,
  entry_no      text unique,
  firm_id       int not null references firms(id),
  business_date date not null,
  narration     text not null,
  source_type   text not null,       -- manual, dispatch, receipt, cheque_return, reversal, opening, import ...
  source_id     text,
  status        text not null default 'posted' check (status in ('draft','pending_approval','posted')),
  reversal_of   bigint unique references journal_entries(id),
  reversed_by   bigint references journal_entries(id),
  created_by    int not null references users(id),
  created_at    timestamptz not null default now(),
  approved_by   int references users(id),
  approved_at   timestamptz,
  posted_at     timestamptz,
  posted_txid   bigint
);
create index je_date_idx on journal_entries(business_date);
create index je_source_idx on journal_entries(source_type, source_id);

create table journal_lines (
  id              bigserial primary key,
  entry_id        bigint not null references journal_entries(id),
  line_no         int not null,
  account_id      int not null references accounts(id),
  party_id        int references parties(id),
  branch_id       int references branches(id),
  cost_centre_id  int references cost_centres(id),
  debit           numeric(18,2) not null default 0 check (debit >= 0),
  credit          numeric(18,2) not null default 0 check (credit >= 0),
  memo            text,
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
  unique (entry_id, line_no)
);
create index jl_account_idx on journal_lines(account_id);
create index jl_party_idx on journal_lines(party_id);

-- ---------------------------------------------------------------------------
create or replace function assert_day_open(d date) returns void language plpgsql as $$
begin
  if exists (select 1 from business_days where business_date = d and status = 'locked') then
    raise exception 'Business date % is locked; post the correction on an open day', d
      using errcode = 'P0001';
  end if;
end $$;

create or replace function je_before_insert() returns trigger language plpgsql as $$
begin
  if new.reversed_by is not null then
    raise exception 'A new entry cannot already be reversed' using errcode = 'P0001';
  end if;
  if new.status = 'posted' then
    perform assert_day_open(new.business_date);
    new.posted_at := now();
    new.posted_txid := txid_current();
    new.entry_no := next_doc_no('JV', new.business_date);
  else
    new.entry_no := null;
    new.posted_at := null;
    new.posted_txid := null;
  end if;
  return new;
end $$;
create trigger je_before_insert before insert on journal_entries
  for each row execute function je_before_insert();

create or replace function je_before_update() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    -- The only change allowed on a posted entry is recording its reversal, once.
    if old.reversed_by is null and new.reversed_by is not null
       and (to_jsonb(new) - 'reversed_by') = (to_jsonb(old) - 'reversed_by') then
      return new;
    end if;
    raise exception 'Posted journal entry % cannot be changed; reverse it instead', old.entry_no
      using errcode = 'P0001';
  end if;
  if new.status = 'posted' then
    -- Maker-checker: an entry that waited for approval cannot be approved by its creator.
    if old.status = 'pending_approval' and new.approved_by is not distinct from old.created_by then
      raise exception 'The person who created an entry cannot approve it' using errcode = 'P0001';
    end if;
    perform assert_day_open(new.business_date);
    new.posted_at := now();
    new.posted_txid := txid_current();
    new.entry_no := next_doc_no('JV', new.business_date);
  end if;
  return new;
end $$;
create trigger je_before_update before update on journal_entries
  for each row execute function je_before_update();

create or replace function je_before_delete() returns trigger language plpgsql as $$
begin
  if old.status = 'posted' then
    raise exception 'Posted journal entry % cannot be deleted; reverse it instead', old.entry_no
      using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger je_before_delete before delete on journal_entries
  for each row execute function je_before_delete();

create or replace function jl_guard() returns trigger language plpgsql as $$
declare
  e record;
  a record;
begin
  select status, posted_txid into e from journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
  if tg_op in ('UPDATE','DELETE') then
    if e.status = 'posted' then
      raise exception 'Lines of a posted entry cannot be changed' using errcode = 'P0001';
    end if;
    if tg_op = 'DELETE' then return old; end if;
  end if;
  if tg_op = 'INSERT' and e.status = 'posted' and e.posted_txid is distinct from txid_current() then
    raise exception 'Lines cannot be added to a posted entry' using errcode = 'P0001';
  end if;
  select postable, active, control into a from accounts where id = new.account_id;
  if not a.postable or not a.active then
    raise exception 'Account % is not open for posting', new.account_id using errcode = 'P0001';
  end if;
  if a.control in ('receivable','payable') and new.party_id is null then
    raise exception 'A receivable or payable line must name a party' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger jl_guard before insert or update or delete on journal_lines
  for each row execute function jl_guard();

-- Deferred to commit time, so an entry and all its lines can be written in one transaction.
create or replace function je_check_balanced() returns trigger language plpgsql as $$
declare
  eid bigint;
  st text;
  d numeric; c numeric; n int;
begin
  if tg_table_name = 'journal_lines' then eid := new.entry_id; else eid := new.id; end if;
  select status into st from journal_entries where id = eid;
  if st <> 'posted' then return null; end if;
  select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into d, c, n
    from journal_lines where entry_id = eid;
  if n < 2 then
    raise exception 'Journal entry % needs at least two lines', eid using errcode = 'P0001';
  end if;
  if d <> c then
    raise exception 'Journal entry % does not balance: debits % vs credits %', eid, d, c using errcode = 'P0001';
  end if;
  if d = 0 then
    raise exception 'Journal entry % has no amount', eid using errcode = 'P0001';
  end if;
  return null;
end $$;

create constraint trigger je_balanced_on_entry after insert or update on journal_entries
  deferrable initially deferred for each row execute function je_check_balanced();
create constraint trigger je_balanced_on_line after insert on journal_lines
  deferrable initially deferred for each row execute function je_check_balanced();

-- Reverse a posted entry with an opposite entry, linking both. Returns the new entry id.
create or replace function reverse_entry(p_entry_id bigint, p_user_id int, p_reason text, p_date date)
returns bigint language plpgsql as $$
declare
  o record;
  new_id bigint;
begin
  select * into o from journal_entries where id = p_entry_id for update;
  if not found then raise exception 'Journal entry % not found', p_entry_id using errcode = 'P0002'; end if;
  if o.status <> 'posted' then raise exception 'Only posted entries can be reversed' using errcode = 'P0001'; end if;
  if o.reversed_by is not null then raise exception 'Entry % is already reversed', o.entry_no using errcode = 'P0001'; end if;
  if o.reversal_of is not null then raise exception 'A reversal cannot itself be reversed; post a new entry' using errcode = 'P0001'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = 'P0001'; end if;

  insert into journal_entries(firm_id, business_date, narration, source_type, source_id, status, reversal_of, created_by, approved_by, approved_at)
    values (o.firm_id, p_date, 'Reversal of ' || o.entry_no || ': ' || p_reason, 'reversal', o.id::text, 'posted', o.id, p_user_id, p_user_id, now())
    returning id into new_id;

  insert into journal_lines(entry_id, line_no, account_id, party_id, branch_id, cost_centre_id, debit, credit, memo)
    select new_id, line_no, account_id, party_id, branch_id, cost_centre_id, credit, debit, memo
      from journal_lines where entry_id = o.id order by line_no;

  update journal_entries set reversed_by = new_id where id = o.id;
  return new_id;
end $$;

-- ---------------------------------------------------------------------------
create view posted_lines as
  select l.*, e.entry_no, e.business_date, e.narration, e.source_type, e.source_id, e.firm_id,
         e.reversal_of, e.reversed_by
    from journal_lines l join journal_entries e on e.id = l.entry_id
   where e.status = 'posted';

create view account_balances as
  select a.id as account_id, a.code, a.name, a.type, a.control,
         coalesce(sum(p.debit),0)  as debit,
         coalesce(sum(p.credit),0) as credit,
         coalesce(sum(p.debit - p.credit),0) as balance
    from accounts a left join posted_lines p on p.account_id = a.id
   group by a.id;

-- Receivable balance per party (positive = party owes AKB; negative = advance held).
create view party_receivables as
  select p.party_id, coalesce(sum(p.debit - p.credit),0) as balance
    from posted_lines p join accounts a on a.id = p.account_id
   where a.control = 'receivable'
   group by p.party_id;
