# AKB ERP: notes for Claude Code

Fertilizer distribution ERP for AKB Group (Pakistan). pnpm monorepo: `apps/api` (Fastify 5, TypeScript, raw SQL via `pg`), `apps/client` (React 19 + Vite), `db/migrations` (PostgreSQL 17).

## Rules that must not be broken
- Never commit client data. `*.xlsx`, `*.xls`, `*.csv`, `data/`, `backups/`, `.env` are git-ignored; do not force-add them. Real files may be read locally only.
- Do not send company data to any third-party service.
- Never edit an applied migration; add a new numbered file. `pnpm migrate` refuses edited files.
- Money is `numeric(18,2)` in the database and strings in TypeScript (`lib/money.ts` converts to paisa BigInt). Never use floating point for money.
- Posted journal entries are immutable; corrections are reversals. Business rules live in the database (triggers in `003_ledger.sql`, `006_security.sql`); keep them there.
- The API connects as `akb_app` (row-level security applies, fails closed). Migrations run as `akb_owner`.
- `REQUIRE_TOTP` must stay true in production; demo seed refuses production.

## Commands
- `pnpm install`, `pnpm migrate`, `pnpm seed` (demo data), `pnpm dev:api` (port 4000), `pnpm dev:client` (port 5173, proxies /api)
- `pnpm test` (wipes and rebuilds the `akb_test` database), `pnpm typecheck`
- Docker: `docker compose up -d --build`, then http://localhost:8080
- Settings come from `.env` at the repo root (see `.env.example`).

## Layout
- `apps/api/src/routes/*` one file per area; writes go through `app.mutate` (one transaction, idempotency key, audit).
- `apps/api/src/services/posting.ts` the only way to post ledger entries.
- `apps/client/src/pages/*` one file per area; shared bits in `components/ui.tsx`.
