# Trial system on Vercel + Neon

A practice copy of AKB ERP that the AKB team can open from anywhere and enter **made-up** data into.
It must never hold real company data: the client's rule is that real data stays on their own servers.
When the trial ends, the real system is installed on the client's server (see `RUNNING_ON_A_MAC.md` and the Docker setup) and the trial is deleted.

## What runs where

| Piece | Vercel project | Root directory | Notes |
|---|---|---|---|
| Screens | `akb-erp` | `apps/client` | Static files. Forwards `/api/...` to the API project, so the browser sees one address. |
| API | `akb-erp-api` | `apps/api` | Fastify, run as a Vercel Function in Singapore (`sin1`). |
| Database | Neon (added from the Vercel Storage tab) | | PostgreSQL. Connected to `akb-erp-api` only. |

## How the database is protected without a second password

Neon gives one owner login (`DATABASE_URL` / `DATABASE_URL_UNPOOLED`). The API uses it, but every connection switches to the restricted role `akb_app` the moment it opens, and again inside every transaction (`DB_SET_ROLE=akb_app`). Row-level security therefore applies exactly as on the client's server. At start-up the API refuses to run if its queries would bypass row-level security. The direct (unpooled) connection is used so the role switch cannot be lost by a connection pooler.

On each deploy, `vercel-build` applies new migrations (creating `akb_app` if missing) and, on a trial system, loads the demo data if the database is empty.

## Environment variables on `akb-erp-api`

| Variable | Value |
|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | Added automatically when Neon is connected. Never paste these anywhere. |
| `DB_SET_ROLE` | `akb_app` |
| `TRIAL_MODE` | `true` (banner on every screen, owner/admin reset button, demo data) |
| `TRIAL_PASSWORD` | The password every trial user starts with (share it with the AKB team privately) |
| `REQUIRE_TOTP` | `false` for the trial (authenticator codes optional) |
| `TRUST_PROXY` | `true` |
| `TIMEZONE` | `Asia/Karachi` |
| `CORS_ORIGINS` | The screens' address, e.g. `https://akb-erp.vercel.app` |

## Deploying

1. Create the Neon database from the Vercel Storage tab, region **Singapore** (or Frankfurt, then change `regions` in `apps/api/vercel.json` to `fra1`).
2. Create project `akb-erp-api` from the GitHub repo, root directory `apps/api`, framework Fastify. Connect the Neon database to it. Add the variables above. Deploy.
3. In `apps/client/vercel.json`, the `/api` rewrite points at the API project's address (`akb-erp-api.vercel.app`); change it if the API project is renamed.
4. Create project `akb-erp` from the same repo, root directory `apps/client`, framework Vite. Deploy.
5. Open the screens' address, sign in as `owner` with the trial password, and check the yellow trial banner is showing.

Every push to `main` redeploys both projects.

## Resetting the trial

Signed in as the owner or admin: **Administration → Users → Reset trial data**, type `RESET`. Everything entered during the trial is deleted, the demo data is loaded again and everyone is signed out.

## Checking the setup locally

`tools/` and the tests can run in the same mode as Vercel. Point `TEST_MIGRATION_DATABASE_URL` and `TEST_DATABASE_URL` at a database whose owner can create roles but is not a superuser, and set `DB_SET_ROLE=akb_app`. Then run `pnpm test`.
