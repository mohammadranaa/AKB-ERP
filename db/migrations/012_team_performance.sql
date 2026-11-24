-- 012_team_performance: what each salesman has sold and collected, against a monthly target,
-- and what each employee has done in the system (Nov 2026).
--  * Sales are credited to the rep on the OG (copied from the customer when the OG is made),
--    collections to the rep on the receipt. Nothing new is recorded for this; it is read from the books.
--  * Monthly targets per rep: bags, sales value and collections. Set by the owner.

create table sales_targets (
  id                 serial primary key,
  rep_user_id        int  not null references users(id),
  month              date not null check (extract(day from month) = 1),
  target_bags        int  not null default 0 check (target_bags >= 0),
  target_sales       numeric(18,2) not null default 0 check (target_sales >= 0),
  target_collection  numeric(18,2) not null default 0 check (target_collection >= 0),
  note               text,
  set_by             int  not null references users(id),
  set_at             timestamptz not null default now(),
  unique (rep_user_id, month)
);

create or replace function sales_targets_check() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from users where id = new.rep_user_id and role_code = 'sales') then
    raise exception 'Targets are set for sales reps only' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger sales_targets_check before insert or update on sales_targets
  for each row execute function sales_targets_check();

insert into permissions(code, description) values
  ('team.read',      'See every salesman''s sales, collections and targets, and what each employee has done in the system'),
  ('targets.manage', 'Set monthly targets for sales reps');

insert into role_permissions(role_code, permission_code) values
  ('owner','team.read'), ('owner','targets.manage'),
  ('accounts','team.read'), ('auditor','team.read');

grant select, insert, update on sales_targets to akb_app;
grant usage, select on sequence sales_targets_id_seq to akb_app;
