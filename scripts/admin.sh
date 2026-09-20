#!/usr/bin/env bash
#
# Admin ops wrapper — runs scripts/bootstrap-admin.ts against an explicit
# environment instead of relying on ad-hoc exported variables.
#
# Usage:
#   SSMS_ENV=dev  ./scripts/admin.sh bootstrap
#   SSMS_ENV=prod ./scripts/admin.sh bootstrap
#
# Reads SUPABASE_URL / SUPABASE_SECRET_KEY / BOOTSTRAP_ADMIN_EMAIL /
# BOOTSTRAP_ADMIN_PASSWORD from .env.<env>.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/env.sh
source "$SCRIPT_DIR/env.sh"

cd "$REPO_ROOT"
ssms_banner

cmd="${1:-bootstrap}"
shift || true

case "$cmd" in
  bootstrap)
    for v in SUPABASE_URL SUPABASE_SECRET_KEY BOOTSTRAP_ADMIN_EMAIL; do
      if [[ -z "${!v:-}" ]]; then
        echo "ERROR: $v is not set in .env.$SSMS_ENV" >&2
        exit 1
      fi
    done
    ssms_require_prod_confirmation "bootstrap admin ${BOOTSTRAP_ADMIN_EMAIL}"
    npx ts-node scripts/bootstrap-admin.ts
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Use one of: bootstrap" >&2
    exit 1
    ;;
esac
