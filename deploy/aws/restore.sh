#!/usr/bin/env bash
# Restores an encrypted AKB ERP backup.
#
#   Check a backup (monthly drill; the live system is not touched):
#     sudo deploy/aws/restore.sh --key /root/akb-backup.key --latest daily
#
#   Replace the live database with a backup (disaster recovery; everyone is signed out):
#     sudo deploy/aws/restore.sh --key /root/akb-backup.key --from daily/akb-20270115-233000.dump.age --replace-live
#
# The private key file is brought to the server only for the restore. Delete it afterwards:
#     shred -u /root/akb-backup.key
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

keyfile="" from="" latest="" mode="check" target="akb_restore_check" keep="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --key) keyfile="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --latest) latest="$2"; shift 2 ;;
    --replace-live) mode="replace"; shift ;;
    --keep) keep="yes"; shift ;;
    --file) from="file:$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[ -f "$keyfile" ] || die "--key: the backup private key file is needed (AGE-SECRET-KEY-...)"
[ -n "$from" ] || [ -n "$latest" ] || die "give --from <s3 path>, --latest <frequent|daily|monthly|pre-update> or --file <local .age file>"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
work="$(mktemp -d "$STATE_DIR/restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT

if [ -n "$latest" ]; then
  [ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set ($CONF_FILE)"
  from=$(aws s3 ls --region "$AWS_REGION" "s3://$BACKUP_BUCKET/$latest/" | awk '{print $4}' | grep '\.dump\.age$' | sort | tail -1 || true)
  [ -n "$from" ] || die "no backups found under $latest/"
  from="$latest/$from"
fi

if [[ "$from" == file:* ]]; then
  cp "${from#file:}" "$work/akb.dump.age"
else
  log "downloading s3://$BACKUP_BUCKET/$from"
  aws s3 cp --only-show-errors --region "$AWS_REGION" "s3://$BACKUP_BUCKET/$from" "$work/akb.dump.age"
  expected=$(aws s3api head-object --region "$AWS_REGION" --bucket "$BACKUP_BUCKET" --key "$from" --query 'Metadata.sha256' --output text 2>/dev/null || true)
  actual=$(sha256sum "$work/akb.dump.age" | cut -d' ' -f1)
  if [ -n "$expected" ] && [ "$expected" != "None" ] && [ "$expected" != "$actual" ]; then
    die "the downloaded file does not match its checksum; try another backup"
  fi
fi

age --decrypt --identity "$keyfile" --output "$work/akb.dump" "$work/akb.dump.age"
db_exec pg_restore --list <"$work/akb.dump" >/dev/null || die "the backup cannot be read"

count_sql="select 'parties', count(*) from parties union all select 'ogs', count(*) from ogs
  union all select 'journal_entries', count(*) from journal_entries union all select 'journal_lines', count(*) from journal_lines
  union all select 'receipts', count(*) from receipts union all select 'audit_log', count(*) from audit_log order by 1"
# Every posted entry must balance; the restored ledger as a whole must too.
balance_sql="select coalesce(sum(debit),0) - coalesce(sum(credit),0) from journal_lines"

restore_into() {
  local db="$1"
  db_exec psql -v ON_ERROR_STOP=1 -U postgres -d postgres -q \
    -c "drop database if exists $db with (force)" -c "create database $db owner akb_owner"
  db_exec pg_restore -U postgres --exit-on-error --single-transaction -d "$db" <"$work/akb.dump"
}

if [ "$mode" = "check" ]; then
  [[ "$target" =~ ^akb_restore_[a-z_]+$ ]] || die "bad check database name"
  log "restoring into the check database $target (the live system is not touched)"
  restore_into "$target"
  echo "Rows in the backup:"
  db_exec psql -U postgres -d "$target" -At -F ' ' -c "$count_sql" | sed 's/^/  /'
  diff=$(db_exec psql -U postgres -d "$target" -At -c "$balance_sql")
  [ "$diff" = "0" ] || [ "$diff" = "0.00" ] || die "the restored ledger does not balance (difference $diff)"
  echo "  ledger balances: yes"
  if [ "$keep" = "no" ]; then
    db_exec psql -U postgres -d postgres -q -c "drop database $target with (force)"
  fi
  printf '%s %s\n' "$(date +%s)" "$from" >"$STATE_DIR/last-restore-check"
  log "restore check passed: $from"
  exit 0
fi

# Replace the live database.
echo "This replaces the LIVE database with $from."
echo "Everything entered after that backup will be lost, and everyone will be signed out."
read -r -p "Type REPLACE to continue: " answer
[ "$answer" = "REPLACE" ] || die "cancelled"

log "safety copy of the current database first"
"$(dirname "$0")/backup-s3.sh" pre-update || die "could not take the safety copy; nothing was changed"
log "stopping the API"
compose stop api web
log "restoring"
restore_into akb
log "starting the API (it applies any newer migrations)"
compose start api web
wait_for_api 60 || die "the API did not come back; check: sudo docker compose -f deploy/aws/docker-compose.yml --env-file .env -p akb-erp logs api"
alert "database restored" "The live database was replaced with the backup $from."
log "done"
