# Shared by the AWS server scripts. Not run on its own.
# shellcheck shell=bash

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034  # used by the scripts that source this file
STATE_DIR="${AKB_STATE_DIR:-/var/lib/akb-erp}"
CONF_FILE="${AKB_CONF_FILE:-/etc/akb-erp.conf}"
ENV_FILE="${AKB_ENV_FILE:-$REPO/.env}"

# Settings written by the AWS template (region, backup bucket, alert topic). Nothing secret.
if [ -f "$CONF_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONF_FILE"
fi

die() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

need_root() { [ "$(id -u)" = 0 ] || die "run this with sudo"; }

# docker compose for the AWS stack. Tests replace this function to run against a local database.
compose() {
  docker compose -f "$REPO/deploy/aws/docker-compose.yml" --env-file "$ENV_FILE" -p akb-erp "$@"
}

# Run a command as the postgres superuser inside the database container (stdin passes through).
db_exec() {
  compose exec -T db "$@"
}

env_value() {
  # Read one value from .env without sourcing the whole file into the environment.
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-
}

# Email alert through the AWS alert topic. Falls back to the log when no topic is configured.
alert() {
  local subject="$1" message="$2"
  log "ALERT: $subject - $message"
  if [ -n "${ALERT_TOPIC_ARN:-}" ] && command -v aws >/dev/null; then
    aws sns publish --region "$AWS_REGION" --topic-arn "$ALERT_TOPIC_ARN" \
      --subject "AKB ERP: $subject" --message "$message (server $(hostname), $(date '+%Y-%m-%d %H:%M %Z'))" >/dev/null ||
      log "could not send the alert email"
  fi
}

wait_for_api() {
  local tries="${1:-60}"
  for _ in $(seq 1 "$tries"); do
    if compose exec -T api wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  return 1
}
