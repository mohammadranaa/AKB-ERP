#!/usr/bin/env bash
# Starts the API and the screens on this Mac (after tools/mac-setup.sh). Press Ctrl+C to stop both.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v brew >/dev/null; then export PATH="$(brew --prefix postgresql@17)/bin:$(brew --prefix node@22)/bin:$PATH"; fi
pg_isready -q -h localhost || { command -v brew >/dev/null && brew services start postgresql@17 >/dev/null; sleep 2; }
pnpm migrate
trap 'kill 0' EXIT
pnpm dev:api &
pnpm dev:client &
sleep 3
echo
echo "AKB ERP is running at http://localhost:5173   (Ctrl+C to stop)"
(command -v open >/dev/null && open http://localhost:5173) || true
wait
