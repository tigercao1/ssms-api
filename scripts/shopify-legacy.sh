#!/usr/bin/env bash
#
# Legacy Shopify `our_team` pairing — runs scripts/shopify-legacy.ts against an
# explicit environment.
#
# Usage:
#   SSMS_ENV=prod ./scripts/shopify-legacy.sh snapshot <output-dir>
#   SSMS_ENV=prod ./scripts/shopify-legacy.sh propose <output.csv> [--snapshot <file>]
#   SSMS_ENV=dev  ./scripts/shopify-legacy.sh apply <reviewed.csv>            # dry run
#   SSMS_ENV=dev  ./scripts/shopify-legacy.sh apply <reviewed.csv> --write
#
# apply --write against prod also requires SSMS_CONFIRM_PROD=yes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/env.sh
source "$SCRIPT_DIR/env.sh"

cd "$REPO_ROOT"
ssms_banner

cmd="${1:-}"

case "$cmd" in
  snapshot | propose | apply) ;;
  *)
    echo "Unknown command: ${cmd:-<none>}" >&2
    echo "Use one of: snapshot | propose | apply" >&2
    exit 1
    ;;
esac

for v in SUPABASE_URL SUPABASE_SECRET_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: $v is not set in .env.$SSMS_ENV" >&2
    exit 1
  fi
done

if [[ "$cmd" == "apply" ]] && [[ " $* " == *" --write "* ]]; then
  if [[ "$SSMS_ENV" == "prod" && "${SSMS_CONFIRM_PROD:-}" != "yes" ]]; then
    echo "ERROR: apply --write against PROD requires SSMS_CONFIRM_PROD=yes." >&2
    exit 1
  fi
fi

npx ts-node scripts/shopify-legacy.ts "$@"
