#!/usr/bin/env bash
# Sets up AKB ERP on a Mac WITHOUT Docker: Homebrew PostgreSQL 17 + Node 22 + pnpm.
# Safe to run again; it skips anything already done.
#   ./tools/mac-setup.sh          set up and load demo data
#   ./tools/mac-setup.sh --empty  set up with no demo data
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v brew >/dev/null || { echo "Homebrew is needed first. Install it from https://brew.sh and run this again."; exit 1; }

say "1/6 Installing PostgreSQL 17 and Node 22 (skipped if already installed)"
brew list postgresql@17 >/dev/null 2>&1 || brew install postgresql@17
brew list node@22 >/dev/null 2>&1 || brew install node@22
export PATH="$(brew --prefix postgresql@17)/bin:$(brew --prefix node@22)/bin:$PATH"

say "2/6 Starting PostgreSQL"
brew services start postgresql@17 >/dev/null
for _ in $(seq 1 30); do pg_isready -q -h localhost && break; sleep 1; done
pg_isready -h localhost >/dev/null || { echo "PostgreSQL did not start. Try: brew services restart postgresql@17"; exit 1; }

say "3/6 Creating settings file (.env) with new random passwords"
if [ ! -f .env ]; then
  owner_pw=$(openssl rand -hex 16); app_pw=$(openssl rand -hex 16)
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" \
      -e "s/^AKB_OWNER_PASSWORD=.*/AKB_OWNER_PASSWORD=${owner_pw}/" \
      -e "s/^AKB_APP_PASSWORD=.*/AKB_APP_PASSWORD=${app_pw}/" \
      -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://akb_app:${app_pw}@localhost:5432/akb#" \
      -e "s#^MIGRATION_DATABASE_URL=.*#MIGRATION_DATABASE_URL=postgres://akb_owner:${owner_pw}@localhost:5432/akb#" \
      .env.example > .env
  chmod 600 .env
  echo "Created .env (only your user account can read it)."
else
  echo ".env already exists; keeping it."
fi
set -a; . ./.env; set +a

say "4/6 Creating the database and its two users"
if psql -h localhost -d postgres -tAc "select 1 from pg_roles where rolname='akb_owner'" | grep -q 1; then
  echo "Already created."
else
  POSTGRES_USER="$(whoami)" PGHOST=localhost sh db/init/00-roles.sh
fi

say "5/6 Installing the app's packages"
corepack enable >/dev/null 2>&1 || npm install -g pnpm@10
pnpm install --frozen-lockfile

say "6/6 Building the database tables"
pnpm migrate
if [ "${1:-}" != "--empty" ]; then
  pnpm seed || true   # refuses (harmlessly) if users already exist
fi

say "Done."
echo "Start the system any time with:   ./tools/start.sh"
echo "Then open http://localhost:5173  (demo sign-in: owner / Demo-Pass-2026)"
