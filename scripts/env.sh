#!/usr/bin/env bash
#
# Shared environment loader for SSMS ops scripts.
#
# Sourced by scripts/db.sh and scripts/admin.sh. Never run directly.
#
# Contract:
#   SSMS_ENV=dev|prod  (required — there is deliberately NO default)
#
# Loads .env.<env> from the repo root and exports its contents. Refuses to run
# against prod without an explicit confirmation, so a stale shell variable can
# never silently point a migration loop at production.
#
# Why no default: the previous setup used a single .env plus whatever
# DATABASE_URL happened to be exported in your shell. That makes "apply all
# migrations" a coin flip between dev and prod. Requiring SSMS_ENV makes the
# target explicit at every call site.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

_die() {
  echo "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Resolve the target environment
# ---------------------------------------------------------------------------
if [[ -z "${SSMS_ENV:-}" ]]; then
  cat >&2 <<'EOF'
ERROR: SSMS_ENV is not set.

Every ops command must name its target environment explicitly:

  SSMS_ENV=dev  ./scripts/db.sh counts
  SSMS_ENV=prod ./scripts/db.sh counts

There is no default, on purpose — see scripts/env.sh.
EOF
  exit 1
fi

case "$SSMS_ENV" in
  dev|prod) ;;
  *) _die "SSMS_ENV must be 'dev' or 'prod' (got: '$SSMS_ENV')." ;;
esac

ENV_FILE="$REPO_ROOT/.env.$SSMS_ENV"

if [[ ! -f "$ENV_FILE" ]]; then
  _die "$ENV_FILE not found. Copy .env.$SSMS_ENV.example to .env.$SSMS_ENV and fill it in."
fi

# ---------------------------------------------------------------------------
# 2. Load it
# ---------------------------------------------------------------------------
# `set -a` exports everything defined while it is active.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# ---------------------------------------------------------------------------
# 3. Sanity-check that the file matches the environment it claims to be
# ---------------------------------------------------------------------------
# Each .env.<env> declares its own SSMS_ENV_NAME. If they disagree, someone has
# copied a prod file into the dev slot (or vice versa) — refuse to continue.
if [[ -n "${SSMS_ENV_NAME:-}" && "$SSMS_ENV_NAME" != "$SSMS_ENV" ]]; then
  _die "$ENV_FILE declares SSMS_ENV_NAME=$SSMS_ENV_NAME but was loaded as '$SSMS_ENV'. Refusing to run."
fi

# Derive the Supabase project ref from SUPABASE_URL for display + guardrails.
SSMS_PROJECT_REF="$(printf '%s' "${SUPABASE_URL:-}" | sed -E 's#^https://([^.]+)\..*#\1#')"

# If the env file pins an expected ref, enforce it. This catches the case where
# the right file is loaded but its SUPABASE_URL was pasted from another project.
if [[ -n "${SSMS_EXPECT_PROJECT_REF:-}" && "$SSMS_EXPECT_PROJECT_REF" != "$SSMS_PROJECT_REF" ]]; then
  _die "Project ref mismatch: $ENV_FILE expects '$SSMS_EXPECT_PROJECT_REF' but SUPABASE_URL resolves to '$SSMS_PROJECT_REF'."
fi

# ---------------------------------------------------------------------------
# 4. Production guardrail
# ---------------------------------------------------------------------------
# Destructive-by-default commands against prod require deliberate confirmation.
# Set SSMS_CONFIRM_PROD=yes to satisfy this non-interactively (CI, deploy jobs).
ssms_require_prod_confirmation() {
  local action="${1:-this operation}"

  [[ "$SSMS_ENV" == "prod" ]] || return 0
  [[ "${SSMS_CONFIRM_PROD:-}" == "yes" ]] && return 0

  if [[ ! -t 0 ]]; then
    _die "Refusing to run '$action' against PROD non-interactively. Set SSMS_CONFIRM_PROD=yes if you mean it."
  fi

  echo "" >&2
  echo "  ⚠️  You are about to run '$action' against PRODUCTION" >&2
  echo "      project: ${SSMS_PROJECT_REF:-<unknown>}" >&2
  echo "" >&2
  read -r -p "  Type the project ref to continue: " reply
  if [[ "$reply" != "$SSMS_PROJECT_REF" ]]; then
    _die "Confirmation did not match. Aborted."
  fi
  echo "" >&2
}

# A one-line banner so you always know where a command landed.
ssms_banner() {
  if [[ "$SSMS_ENV" == "prod" ]]; then
    echo "▲ SSMS [PROD] ${SSMS_PROJECT_REF:-?}" >&2
  else
    echo "· SSMS [dev] ${SSMS_PROJECT_REF:-?}" >&2
  fi
}
