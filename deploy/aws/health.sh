#!/usr/bin/env bash
# Runs every 5 minutes (timer set up by install.sh). Emails an alert when something is wrong,
# at most once every 6 hours per problem, and again when it is fixed.
#   - the API or the HTTPS front server is not answering
#   - the HTTPS certificate expires within 14 days (renewal failing)
#   - the disk is more than 80% full
#   - no successful nightly backup in the last 26 hours
set -uo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

mkdir -p "$STATE_DIR/alerts"
problems=0

report() {
  local name="$1" ok="$2" message="$3" flag="$STATE_DIR/alerts/$1"
  if [ "$ok" = "yes" ]; then
    if [ -f "$flag" ]; then
      rm -f "$flag"
      alert "fixed: $name" "This problem has cleared: $message"
    fi
    return
  fi
  problems=$((problems + 1))
  if [ ! -f "$flag" ] || [ $(($(date +%s) - $(stat -c %Y "$flag"))) -gt 21600 ]; then
    touch "$flag"
    alert "$name" "$message"
  fi
}

# 1. API answering inside Docker
if compose exec -T api wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1; then api_ok=yes; else api_ok=no; fi
report api-down "$api_ok" "The AKB ERP API is not answering. Staff cannot use the system."

# 2. HTTPS front server, checked on this machine with the real domain name
domain="$(env_value DOMAIN)"
if [ -n "$domain" ]; then
  if curl -fsS --max-time 15 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null 2>&1; then https_ok=yes; else https_ok=no; fi
  report https-down "$https_ok" "https://$domain is not answering (Caddy or the certificate)."

  expiry=$(echo | timeout 15 openssl s_client -connect 127.0.0.1:443 -servername "$domain" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  if [ -n "$expiry" ]; then
    days=$((($(date -d "$expiry" +%s) - $(date +%s)) / 86400))
    if [ "$days" -ge 14 ]; then cert_ok=yes; else cert_ok=no; fi
    report certificate "$cert_ok" "The HTTPS certificate for $domain expires in $days days and has not renewed."
  fi
fi

# 3. Disk space
used=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$used" -lt 80 ]; then disk_ok=yes; else disk_ok=no; fi
report disk "$disk_ok" "The server disk is ${used}% full. Enlarge the volume in the AWS console (EC2 > Volumes > Modify)."

# 4. Nightly backup
last="$STATE_DIR/last-backup-daily"
if [ -f "$last" ] && [ $(($(date +%s) - $(cut -d' ' -f1 "$last"))) -lt 93600 ]; then backup_ok=yes; else backup_ok=no; fi
report backup-missing "$backup_ok" "No successful nightly backup in the last 26 hours."

exit $((problems > 0))
