#!/usr/bin/env bash
# Weekly copy of the AKB ERP backup from AWS to this office server (Linux or Mac).
#
# Schedule it to run every day (see docs/OFFICE_BACKUP_COPY.md). It downloads only when the newest
# copy here is 6 days old or more, so it copies once a week and catches up by itself if this
# machine was switched off on the usual day.
#
# Settings: office-backup.conf next to this script. AWS login: aws-credentials next to this script.
# The copies stay encrypted; only the owners' backup key opens them.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
conf="$here/office-backup.conf"
[ -f "$conf" ] || { echo "missing $conf (copy office-backup.conf.example)" >&2; exit 1; }
# shellcheck source=office-backup.conf.example
. "$conf"
: "${BUCKET:?set BUCKET in office-backup.conf}" "${REGION:?set REGION}" "${DEST:?set DEST}"
KEEP_DAYS="${KEEP_DAYS:-365}"
EVERY_DAYS="${EVERY_DAYS:-6}"

export AWS_SHARED_CREDENTIALS_FILE="$here/aws-credentials"
export AWS_CONFIG_FILE="$here/aws-config"
[ -f "$AWS_SHARED_CREDENTIALS_FILE" ] || { echo "missing $AWS_SHARED_CREDENTIALS_FILE" >&2; exit 1; }
command -v aws >/dev/null || { echo "the AWS CLI is not installed" >&2; exit 1; }

mkdir -p "$DEST"
log="$DEST/pull-backup.log"
say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$log"; }

newest_local=$(find "$DEST" -maxdepth 1 -name 'akb-*.dump.age' -mtime "-$EVERY_DAYS" | head -1)
if [ -n "$newest_local" ] && [ "${1:-}" != "--now" ]; then
  exit 0 # this week's copy is already here
fi

latest=$(aws s3 ls --region "$REGION" "s3://$BUCKET/daily/" | awk '{print $4}' | grep '\.dump\.age$' | sort | tail -1 || true)
[ -n "$latest" ] || { say "ERROR: no nightly backups found in s3://$BUCKET/daily/"; exit 1; }

target="$DEST/$latest"
if [ -f "$target" ]; then
  say "ERROR: the newest backup on AWS ($latest) is the one already copied; AWS has made no new nightly backup for $EVERY_DAYS days or more"
  exit 1
fi
say "copying $latest"
aws s3 cp --only-show-errors --region "$REGION" "s3://$BUCKET/daily/$latest" "$target.partial"
expected=$(aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "daily/$latest" --query 'Metadata.sha256' --output text)
actual=$( (sha256sum "$target.partial" 2>/dev/null || shasum -a 256 "$target.partial") | cut -d' ' -f1)
if [ "$expected" != "$actual" ]; then
  rm -f "$target.partial"
  say "ERROR: $latest arrived damaged (checksum mismatch); will try again tomorrow"
  exit 1
fi
head -c 21 "$target.partial" | grep -q 'age-encryption.org/v1' || { rm -f "$target.partial"; say "ERROR: $latest is not an encrypted backup"; exit 1; }
mv "$target.partial" "$target" # keeps the backup's own date, which the 6-day check uses
chmod 600 "$target"

# Tell the AWS server this office has its copy (it emails an alert if no copy is collected for 8 days).
size=$(wc -c <"$target" | tr -d ' ')
printf 'collected=%s\nfile=%s\nbytes=%s\nhost=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$latest" "$size" "$(hostname)" |
  aws s3 cp --only-show-errors --region "$REGION" - "s3://$BUCKET/office-receipts/latest.txt"

find "$DEST" -maxdepth 1 -name 'akb-*.dump.age' -mtime "+$KEEP_DAYS" -print -delete | sed 's/^/removed old copy /' >>"$log" || true
say "ok: $latest ($size bytes); $(find "$DEST" -maxdepth 1 -name 'akb-*.dump.age' | wc -l | tr -d ' ') weekly copies kept"
