#!/usr/bin/env bash
#
# Season roster import and invite emails — runs scripts/import-season-roster.ts
# against an explicit environment.
#
# Usage:
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --csv <export.csv> --report <outside-repo.json>   # dry run
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --csv <export.csv> --apply
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --send --only <email>
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --send
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --remind
#   SSMS_ENV=dev ./scripts/import-season-roster.sh --release-stale-claims <minutes>
#
# A run that dies mid-send leaves invites claimed but not marked sent; later
# runs skip them and list their ids as needs review. Check Resend for each one,
# then --release-stale-claims makes the undelivered ones eligible again.
#
# --apply, --send, --remind and --release-stale-claims against prod ask for the
# project ref first (or need SSMS_CONFIRM_PROD=yes when not interactive).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/env.sh
source "$SCRIPT_DIR/env.sh"

cd "$REPO_ROOT"
ssms_banner

for v in SUPABASE_URL SUPABASE_SECRET_KEY; do
  if [[ -z "${!v:-}" ]]; then
    echo "ERROR: $v is not set in .env.$SSMS_ENV" >&2
    exit 1
  fi
done

for arg in "$@"; do
  case "$arg" in
    --apply | --send | --remind | --release-stale-claims)
      ssms_require_prod_confirmation "import-season-roster $arg"
      export SSMS_CONFIRM_PROD=yes
      ;;
  esac
done

npx ts-node scripts/import-season-roster.ts "$@"
