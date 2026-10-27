-- 009_login_throttle: sign-in attempts per address, kept in the database so the limit holds
-- when the API runs as several short-lived copies (Vercel). Rows older than an hour are pruned.
create table login_attempts (
  id  bigserial primary key,
  ip  text not null,
  at  timestamptz not null default now()
);
create index login_attempts_ip_at on login_attempts(ip, at);

grant select, insert, delete on login_attempts to akb_app;
grant usage, select on sequence login_attempts_id_seq to akb_app;
