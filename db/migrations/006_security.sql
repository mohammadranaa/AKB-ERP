-- 006_security: change guards on business records, row-level security, and grants for akb_app.

-- ---------------------------------------------------------------------------
-- Guards: which columns may change after a record is created.
-- ---------------------------------------------------------------------------
create or replace function only_columns_change(old_row jsonb, new_row jsonb, allowed text[]) returns boolean
language sql immutable as $$
  select (old_row - allowed) = (new_row - allowed)
$$;

create or replace function ogs_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Only draft OGs can be deleted; cancel it instead' using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status <> 'draft' and not only_columns_change(to_jsonb(old), to_jsonb(new),
       array['status','decided_by','decided_at','decision_comment','due_date']) then
    raise exception 'OG % can no longer be edited', old.og_no using errcode = 'P0001';
  end if;
  if old.status in ('rejected','cancelled') and new.status <> old.status then
    raise exception 'OG % is closed', old.og_no using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger ogs_guard before update or delete on ogs
  for each row execute function ogs_guard();

create or replace function receipts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'posted' and new.status = 'returned'
     and only_columns_change(to_jsonb(old), to_jsonb(new), array['status']) then
    return new;
  end if;
  raise exception 'Posted receipts cannot be changed; record a cheque return or reversal' using errcode = 'P0001';
end $$;
create trigger receipts_guard before update or delete on receipts
  for each row execute function receipts_guard();

create or replace function allocations_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.reversed_at is null and new.reversed_at is not null
     and only_columns_change(to_jsonb(old), to_jsonb(new), array['reversed_at','reversed_by_return_id']) then
    return new;
  end if;
  raise exception 'Receipt allocations cannot be changed' using errcode = 'P0001';
end $$;
create trigger allocations_guard before update or delete on receipt_allocations
  for each row execute function allocations_guard();

create trigger cheque_returns_no_change before update or delete on cheque_returns
  for each row execute function forbid_change();
create trigger goods_receipts_no_change before update or delete on goods_receipts
  for each row execute function forbid_change();
create trigger goods_receipt_lines_no_change before update or delete on goods_receipt_lines
  for each row execute function forbid_change();
create trigger stock_transfer_lines_no_change before update or delete on stock_transfer_lines
  for each row execute function forbid_change();

create or replace function transfers_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'in_transit' and new.status = 'received'
     and only_columns_change(to_jsonb(old), to_jsonb(new), array['status','received_by','received_at','received_date']) then
    return new;
  end if;
  raise exception 'Stock transfers cannot be changed after sending' using errcode = 'P0001';
end $$;
create trigger transfers_guard before update or delete on stock_transfers
  for each row execute function transfers_guard();

create or replace function adjustments_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved','rejected')
     and only_columns_change(to_jsonb(old), to_jsonb(new), array['status','decided_by','decided_at','decision_note']) then
    if new.decided_by = old.requested_by then
      raise exception 'The person who requested an adjustment cannot approve it' using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Stock adjustments cannot be changed after a decision' using errcode = 'P0001';
end $$;
create trigger adjustments_guard before update or delete on stock_adjustments
  for each row execute function adjustments_guard();

create or replace function day_lock_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (old.status = 'locked') then
    raise exception 'A locked business day cannot be reopened or changed' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger day_lock_guard before update or delete on business_days
  for each row execute function day_lock_guard();

-- ---------------------------------------------------------------------------
-- Row-level security. Fails closed: with no app.role set, akb_app sees nothing.
-- Sales reps see only the customers, OGs and receipts assigned to them.
-- ---------------------------------------------------------------------------
alter table parties  enable row level security;
alter table ogs      enable row level security;
alter table receipts enable row level security;

create policy parties_scope on parties
  using (app_role() is not null and (app_role() <> 'sales' or kind <> 'customer' or rep_user_id = app_user_id()))
  with check (app_role() is not null and (app_role() <> 'sales' or kind <> 'customer' or rep_user_id = app_user_id()));

create policy ogs_scope on ogs
  using (app_role() is not null and (app_role() <> 'sales' or rep_user_id = app_user_id()))
  with check (app_role() is not null and (app_role() <> 'sales' or rep_user_id = app_user_id()));

create policy receipts_scope on receipts
  using (app_role() is not null and (app_role() <> 'sales' or rep_user_id = app_user_id()))
  with check (app_role() is not null and (app_role() <> 'sales' or rep_user_id = app_user_id()));

-- ---------------------------------------------------------------------------
-- Grants. akb_app can read everything and insert records; it can update only
-- where a workflow needs it (the guards above limit what), and delete only drafts.
-- It owns no tables, so it cannot drop or alter anything.
-- ---------------------------------------------------------------------------
grant usage on schema public to akb_app;
grant select, insert on all tables in schema public to akb_app;
grant usage, select on all sequences in schema public to akb_app;

grant update on users, sessions, parties, products, accounts, bank_accounts, business_days,
  journal_entries, journal_lines, doc_counters, ogs, og_lines, receipts, receipt_allocations,
  stock_transfers, stock_adjustments, branches, idempotency_keys to akb_app;
grant delete on journal_entries, journal_lines, ogs, og_lines, sessions, idempotency_keys to akb_app;

revoke update, delete on audit_log, stock_movements, dispatches, dispatch_lines, cheque_returns,
  goods_receipts, goods_receipt_lines, stock_transfer_lines from akb_app;
