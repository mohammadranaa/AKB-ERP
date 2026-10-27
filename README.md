# AKB ERP

Order-to-cash, stock and ledger system for AKB Group (fertilizer distribution).

**What works today:** sign-in with roles and authenticator codes · OGs with credit, floor-price and stock checks · approvals (nobody approves their own work) · dispatch with gate pass · branch stock from movements · goods receipts and transfers · receipts with OG allocation and cheque returns · double-entry ledger, manual journals, reversals, trial balance · day close with cash/bank counts and a checksummed day book (Excel/CSV) · tamper-evident audit log.

**Not built yet:** the finance module (guarantees, bank limits, margin money) and procurement/company orders. These wait for the answers to the questionnaire.

## Run it on a Mac

Pick one. Both take about ten minutes the first time. Details and troubleshooting: [docs/RUNNING_ON_A_MAC.md](docs/RUNNING_ON_A_MAC.md).

**Option A, Docker Desktop (recommended)**

```sh
cp .env.example .env        # then open .env and change the three passwords
docker compose up -d --build
docker compose exec api node dist/src/cli/seed.js   # optional: demo data
```

Open http://localhost:8080 and sign in as `owner` / `Demo-Pass-2026`.

**Option B, no Docker (Homebrew)**

```sh
./tools/mac-setup.sh   # installs PostgreSQL 17 + Node 22, creates .env with random passwords, loads demo data
./tools/start.sh       # every time you want to use it
```

Open http://localhost:5173. To use it from phones on the same Wi-Fi, start with `./tools/start.sh --lan` (details in the guide).

## Demo copy for phones

`node tools/build-demo.mjs` builds `dist-demo/akb-erp-demo.html`: one file, made-up data, read-only, opens in any browser with no server. Build it only from demo data (the script refuses otherwise).

## Demo users

All use the password `Demo-Pass-2026`: `owner`, `accounts`, `accounts2`, `sales1`, `sales2`, `dist`, `procure`, `finance`, `auditor`, `admin`. Demo data is refused when `NODE_ENV=production`.

## Before real data goes in

1. Set `NODE_ENV=production` and `REQUIRE_TOTP=true` in `.env`.
2. Start from an empty database (no demo data) and create the first administrator:
   `docker compose exec api node dist/src/cli/create-admin.js <username> "<Full name>"` (Docker) or `pnpm --filter @akb/api exec tsx src/cli/create-admin.ts <username> "<Full name>"` (Homebrew). It prints a one-time password.
3. Turn on FileVault on the Mac, and schedule `./tools/backup.sh` with copies kept off the laptop.

## Development

```sh
pnpm install
pnpm test        # API tests against the akb_test database (wiped every run)
pnpm typecheck
```

- `apps/api` Fastify + TypeScript API. Business rules that must never break (balanced entries, no edits after posting, gapless numbers, locked days, maker-checker) are enforced inside PostgreSQL, not only in code.
- `apps/client` React screens.
- `db/migrations` schema, applied in order by `pnpm migrate`. Never edit an applied migration; add a new one.

Client spreadsheets (`*.xlsx`, `*.csv`) and `data/`, `backups/` are git-ignored on purpose. Real company data never goes into this repository.
