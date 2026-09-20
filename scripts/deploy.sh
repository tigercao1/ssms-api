#!/usr/bin/env bash
#
# Push app-facing env values from .env.<env> into the Fly.io app, so the
# deployed API and the local ops scripts can never drift apart.
#
# Usage:
#   SSMS_ENV=prod ./scripts/deploy.sh secrets     # sync secrets to Fly
#   SSMS_ENV=prod ./scripts/deploy.sh diff        # show which keys differ
#   SSMS_ENV=prod ./scripts/deploy.sh release     # fly deploy
#
# Only the variables the running app actually reads are pushed. Deliberately
# excluded:
#   DATABASE_URL              — ops/migrations only; the app uses the REST API
#   SUPABASE_PUBLISHABLE_KEY  — portal build-time value, not used server-side
#   BOOTSTRAP_ADMIN_*         — one-shot script input, never a running secret
#   SSMS_*                    — local script bookkeeping
#   PORT                      — provided by the platform
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/env.sh
source "$SCRIPT_DIR/env.sh"

cd "$REPO_ROOT"
ssms_banner

command -v fly >/dev/null 2>&1 || {
  echo "ERROR: flyctl not found. Install with: brew install flyctl" >&2
  exit 1
}

# Keys the NestJS app reads at runtime.
APP_KEYS=(
  SUPABASE_URL
  SUPABASE_SECRET_KEY
  SUPABASE_STORAGE_BUCKET
  CORS_ALLOWED_ORIGINS
  RESEND_API_KEY
  MAIL_FROM
)

cmd="${1:-diff}"
shift || true

case "$cmd" in
  diff)
    # Fly never reveals secret values, only names + digests. So this compares
    # presence, not content — enough to catch "forgot to set it entirely".
    echo "Keys set locally in .env.$SSMS_ENV vs present on Fly:"
    remote="$(fly secrets list --json 2>/dev/null | python3 -c \
      'import json,sys; print(" ".join(s["Name"] for s in json.load(sys.stdin)))' 2>/dev/null || echo "")"
    for k in "${APP_KEYS[@]}"; do
      local_state="unset"; [[ -n "${!k:-}" ]] && local_state="set"
      remote_state="absent"; [[ " $remote " == *" $k "* ]] && remote_state="present"
      printf '  %-26s local=%-5s fly=%s\n' "$k" "$local_state" "$remote_state"
    done
    ;;
  secrets)
    ssms_require_prod_confirmation "sync secrets to Fly"
    args=()
    for k in "${APP_KEYS[@]}"; do
      if [[ -n "${!k:-}" ]]; then
        args+=("$k=${!k}")
      else
        echo "  … skipping $k (empty in .env.$SSMS_ENV)" >&2
      fi
    done
    if [[ ${#args[@]} -eq 0 ]]; then
      echo "ERROR: nothing to set — .env.$SSMS_ENV has no app values filled in." >&2
      exit 1
    fi
    # A single call = one machine restart instead of one per key.
    fly secrets set "${args[@]}"
    ;;
  release)
    ssms_require_prod_confirmation "fly deploy"
    fly deploy --remote-only
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Use one of: diff | secrets | release" >&2
    exit 1
    ;;
esac
