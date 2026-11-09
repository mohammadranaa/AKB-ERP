#!/usr/bin/env bash
# One-time installation of AKB ERP on the AWS server made by akb-erp-stack.yaml.
#
#   sudo deploy/aws/install.sh --domain erp.akbgroup.pk --email it@akbgroup.pk --backup-key age1...
#
#   --domain      the address staff will open; its DNS A record must already point at this server
#   --email       for the HTTPS certificate (Let's Encrypt expiry notices)
#   --backup-key  the backup PUBLIC key (age1...). Make the key pair on your own computer with
#                 age-keygen; the private key never comes to this server (docs/DEPLOY_AWS.md).
#
# Safe to run again: existing passwords and data are kept.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root

domain="" email="" backup_key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain="$2"; shift 2 ;;
    --email) email="$2"; shift 2 ;;
    --backup-key) backup_key="$2"; shift 2 ;;
    *) die "unknown option $1" ;;
  esac
done
[[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "--domain: e.g. erp.akbgroup.pk (lower case)"
[[ "$email" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "--email: an email address"
[[ "$backup_key" =~ ^age1[0-9a-z]{58}$ ]] || die "--backup-key: the age public key, starting age1 (not the AGE-SECRET-KEY line)"
[ -n "${BACKUP_BUCKET:-}" ] || die "$CONF_FILE is missing; was this server created from akb-erp-stack.yaml?"
for cmd in docker age aws git curl openssl; do command -v "$cmd" >/dev/null || die "$cmd is not installed (the server set-up may still be running; wait 5 minutes)"; done

# The domain must point here, or the certificate cannot be issued.
my_ip=$(curl -fsS --max-time 10 https://checkip.amazonaws.com || true)
dns_ip=$(getent ahostsv4 "$domain" | awk 'NR==1{print $1}' || true)
if [ -n "$my_ip" ] && [ "$dns_ip" != "$my_ip" ]; then
  die "$domain points to '${dns_ip:-nothing}', but this server is $my_ip. Set the DNS A record first (it can take up to an hour)."
fi

cd "$REPO"
umask 077
if [ ! -f .env ]; then
  log "creating .env with new random passwords"
  pw() { openssl rand -hex 24; }
  cat >.env <<EOF
# AKB ERP production settings. Created by deploy/aws/install.sh on $(date '+%Y-%m-%d').
# Passwords are random and live only on this server. Never commit or copy this file.
NODE_ENV=production
DOMAIN=$domain
ACME_EMAIL=$email
BACKUP_AGE_RECIPIENT=$backup_key
POSTGRES_PASSWORD=$(pw)
AKB_OWNER_PASSWORD=$(pw)
AKB_APP_PASSWORD=$(pw)
EOF
else
  log ".env exists; keeping its passwords and updating domain, email and backup key"
  sed -i -e "s|^DOMAIN=.*|DOMAIN=$domain|" -e "s|^ACME_EMAIL=.*|ACME_EMAIL=$email|" \
    -e "s|^BACKUP_AGE_RECIPIENT=.*|BACKUP_AGE_RECIPIENT=$backup_key|" .env
fi
chmod 600 .env
umask 022

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

log "building and starting (the first build takes 5-10 minutes)"
compose up -d --build
wait_for_api 90 || die "the API did not start; see: sudo docker compose -f deploy/aws/docker-compose.yml --env-file .env -p akb-erp logs api"

log "setting up automatic backups and health checks"
unit() { # name, description, command
  cat >"/etc/systemd/system/$1.service" <<EOF
[Unit]
Description=$2
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$3
EOF
}
timer() { # name, schedule
  cat >"/etc/systemd/system/$1.timer" <<EOF
[Unit]
Description=Schedule for $1

[Timer]
OnCalendar=$2
Persistent=true
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
EOF
}
unit akb-backup-frequent "AKB ERP backup (every 4 hours, kept 7 days)" "$REPO/deploy/aws/backup-s3.sh frequent"
timer akb-backup-frequent "*-*-* 10,14,18:00:00"
unit akb-backup-daily "AKB ERP backup (nightly, kept 35 days)" "$REPO/deploy/aws/backup-s3.sh daily"
timer akb-backup-daily "*-*-* 23:30:00"
unit akb-backup-monthly "AKB ERP backup (monthly, kept 13 months)" "$REPO/deploy/aws/backup-s3.sh monthly"
timer akb-backup-monthly "*-*-01 23:45:00"
unit akb-health "AKB ERP health check" "$REPO/deploy/aws/health.sh"
timer akb-health "*:0/5"
systemctl daemon-reload
for t in akb-backup-frequent akb-backup-daily akb-backup-monthly akb-health; do systemctl enable --now "$t.timer" >/dev/null; done

log "taking the first backup to check S3 works"
"$REPO/deploy/aws/backup-s3.sh" daily

cat <<EOF

AKB ERP is running at https://$domain

Next:
  1. Create the first administrator:
       sudo deploy/aws/create-admin.sh admin "Your Name"
     Sign in with the one-time password it prints, change it, and set up the authenticator app.
  2. Check a restore works (bring the backup private key over for this only, then delete it):
       sudo deploy/aws/restore.sh --key /root/akb-backup.key --latest daily && shred -u /root/akb-backup.key
  3. Confirm the alert email from AWS (subject "AWS Notification - Subscription Confirmation").
EOF
