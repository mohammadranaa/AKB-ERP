#!/usr/bin/env bash
# Writes a full copy of the database to backups/ (never committed to git).
# Restore with:  pg_restore --clean --if-exists -d akb backups/<file>.dump
# Copy the backups folder to an external drive regularly; a backup on the same laptop does not protect against losing the laptop.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
chmod 700 backups
file="backups/akb-$(date +%Y%m%d-%H%M%S).dump"
if docker compose ps --status running db >/dev/null 2>&1 && [ -n "$(docker compose ps -q db 2>/dev/null)" ]; then
  docker compose exec -T db pg_dump -U postgres -Fc akb > "$file"
else
  if command -v brew >/dev/null; then export PATH="$(brew --prefix postgresql@17)/bin:$PATH"; fi
  set -a; . ./.env; set +a
  pg_dump -Fc "$MIGRATION_DATABASE_URL" > "$file"
fi
chmod 600 "$file"
echo "Backup written: $file ($(du -h "$file" | cut -f1))"
