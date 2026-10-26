#!/bin/sh
# Runs once, as the Postgres superuser, when the database volume is first created
# (docker-entrypoint-initdb.d). Creates the two roles the system uses:
#   akb_owner  owns the schema and runs migrations
#   akb_app    what the API connects as: no ownership, no superuser, subject to row-level security
set -eu
: "${AKB_OWNER_PASSWORD:?set AKB_OWNER_PASSWORD}"
: "${AKB_APP_PASSWORD:?set AKB_APP_PASSWORD}"
DB="${AKB_DB_NAME:-akb}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
create role akb_owner login password '${AKB_OWNER_PASSWORD}';
create role akb_app login password '${AKB_APP_PASSWORD}' nosuperuser nocreatedb nocreaterole nobypassrls;
create database ${DB} owner akb_owner;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB" <<SQL
revoke create on schema public from public;
alter schema public owner to akb_owner;
SQL

# A separate database for the automated tests (wiped and rebuilt on every test run).
if [ "${AKB_CREATE_TEST_DB:-true}" = "true" ]; then
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
create database ${DB}_test owner akb_owner;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${DB}_test" <<SQL
revoke create on schema public from public;
alter schema public owner to akb_owner;
SQL
fi
# Extensions (pgcrypto, citext) are created by the first migration, as akb_owner.
