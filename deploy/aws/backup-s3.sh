#!/usr/bin/env bash
# Backs up the AKB ERP database to the S3 backup bucket, encrypted.
#   sudo deploy/aws/backup-s3.sh [frequent|daily|monthly|pre-update]
# Run automatically by the timers install.sh sets up: every 4 hours in the working day (kept 7 days),
# nightly (kept 35 days), monthly (kept 13 months), and before every update (kept 30 days).
#
# The backup is encrypted on this server with the backup PUBLIC key before it leaves. Only the
# matching private key opens it, and that key is kept off the server (see docs/DEPLOY_AWS.md).
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

tier="${1:-daily}"
case "$tier" in frequent | daily | monthly | pre-update) ;; *) die "unknown backup type: $tier" ;; esac

recipient="$(env_value BACKUP_AGE_RECIPIENT)"
[[ "$recipient" =~ ^age1[0-9a-z]{58}$ ]] || die "BACKUP_AGE_RECIPIENT in .env is not an age public key"
[ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set ($CONF_FILE)"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
work="$(mktemp -d "$STATE_DIR/backup.XXXXXX")"
cleanup() { rm -rf "$work"; }
fail() {
  alert "backup FAILED ($tier)" "The $tier database backup did not complete: $1. The last good backup is still in S3. Check the server."
  exit 1
}
trap cleanup EXIT
trap 'fail "a step failed (backup-s3.sh line $LINENO)"' ERR

stamp="$(date +%Y%m%d-%H%M%S)"
key="$tier/akb-$stamp.dump.age"

log "dumping the database"
db_exec pg_dump -U postgres --format=custom --compress=6 akb >"$work/akb.dump"
size=$(stat -c %s "$work/akb.dump")
[ "$size" -gt 10000 ] || fail "the dump is suspiciously small ($size bytes)"

# Prove the dump is readable before trusting it.
db_exec pg_restore --list <"$work/akb.dump" >"$work/contents.txt" || fail "the dump could not be read back"
tables=$(grep -c ' TABLE DATA ' "$work/contents.txt" || true)
[ "$tables" -gt 20 ] || fail "the dump lists only $tables tables"

age --encrypt --recipient "$recipient" --output "$work/akb.dump.age" "$work/akb.dump"
rm -f "$work/akb.dump"
sha=$(sha256sum "$work/akb.dump.age" | cut -d' ' -f1)

log "uploading s3://$BACKUP_BUCKET/$key"
aws s3 cp --only-show-errors --region "$AWS_REGION" --sse AES256 \
  --metadata "sha256=$sha,tables=$tables,dump-bytes=$size" \
  "$work/akb.dump.age" "s3://$BACKUP_BUCKET/$key"

printf '%s %s %s\n' "$(date +%s)" "$key" "$sha" >"$STATE_DIR/last-backup-$tier"
log "backup done: $key ($(numfmt --to=iec "$size") before encryption, $tables tables)"
