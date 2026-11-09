#!/usr/bin/env bash
# Installs the latest version from GitHub (main branch).
#   sudo deploy/aws/update.sh
# 1. backs up the database (kept 30 days), 2. pulls the new code, 3. rebuilds and restarts.
# The API applies any new database migrations when it starts.
# Best run outside working hours; staff are signed out for about a minute.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root

cd "$REPO"
before=$(git rev-parse --short HEAD)
git fetch --quiet origin main
after=$(git rev-parse --short origin/main)
if [ "$before" = "$after" ]; then
  log "already up to date ($before)"
  exit 0
fi

log "backing up before the update"
"$REPO/deploy/aws/backup-s3.sh" pre-update

log "updating $before -> $after"
git merge --ff-only --quiet origin/main
compose build --pull
compose up -d --remove-orphans

if wait_for_api 60; then
  log "updated to $after"
  docker image prune -f >/dev/null
else
  alert "update FAILED" "The API did not start after updating from $before to $after. Follow 'If an update fails' in docs/DEPLOY_AWS.md (go back to $before and restore the pre-update backup)."
  exit 1
fi
