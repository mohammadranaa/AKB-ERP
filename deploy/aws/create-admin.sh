#!/usr/bin/env bash
# Creates the first administrator on a new installation and prints a one-time password
# (they must change it and set up an authenticator app when they first sign in).
#   sudo deploy/aws/create-admin.sh <username> "<Full name>"
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
need_root
[ $# -eq 2 ] || die 'usage: create-admin.sh <username> "<Full name>"'
compose exec -T api node dist/src/cli/create-admin.js "$1" "$2"
