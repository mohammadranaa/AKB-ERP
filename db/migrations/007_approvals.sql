-- 007_approvals: reversal requests (maker-checker for corrections).

create table reversal_requests (
  id              bigserial primary key,
  entry_id        bigint not null references journal_entries(id),
  reason          text not null,
  requested_by    int not null references users(id),
  requested_at    timestamptz not null default now(),
  status          text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by      int references users(id),
  decided_at      timestamptz,
  decision_note   text,
  reversal_entry_id bigint references journal_entries(id)
);
create unique index reversal_requests_one_pending on reversal_requests(entry_id) where status = 'pending';

create or replace function reversal_requests_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved','rejected')
     and only_columns_change(to_jsonb(old), to_jsonb(new), array['status','decided_by','decided_at','decision_note','reversal_entry_id']) then
    if new.decided_by = old.requested_by then
      raise exception 'The person who requested a reversal cannot approve it' using errcode = 'P0001';
    end if;
    return new;
  end if;
  raise exception 'Reversal requests cannot be changed after a decision' using errcode = 'P0001';
end $$;
create trigger reversal_requests_guard before update or delete on reversal_requests
  for each row execute function reversal_requests_guard();

grant select, insert, update on reversal_requests to akb_app;
grant usage, select on sequence reversal_requests_id_seq to akb_app;
