#!/usr/bin/env bash
#
# Thin wrapper around psql for the SSMS Supabase database.
#
# The target environment is ALWAYS explicit — there is no default:
#
#   SSMS_ENV=dev  ./scripts/db.sh counts
#   SSMS_ENV=prod ./scripts/db.sh counts
#
# Connection details come from .env.<env> (see .env.dev.example /
# .env.prod.example), not from whatever DATABASE_URL is floating in your shell.
#
# Usage:
#   ./scripts/db.sh seed                 # apply supabase/seed.sql (idempotent)
#   ./scripts/db.sh query "select 1;"    # run a one-off SQL statement
#   ./scripts/db.sh file path/to.sql     # run an arbitrary .sql file
#   ./scripts/db.sh migrate              # apply every migration in order
#   ./scripts/db.sh shell                # interactive psql session
#   ./scripts/db.sh counts               # reference-data row counts
#   ./scripts/db.sh rls                  # verify RLS is enabled + FORCEd
#   ./scripts/db.sh dump [out.sql]       # pg_dump the public schema
#
# Writes against prod prompt for confirmation (SSMS_CONFIRM_PROD=yes to skip).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=scripts/env.sh
source "$SCRIPT_DIR/env.sh"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set in .env.$SSMS_ENV" >&2
  echo "Get it from Supabase dashboard → Connect → Session pooler, e.g.:" >&2
  echo "  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install with: brew install libpq && brew link --force libpq" >&2
  exit 1
fi

cd "$REPO_ROOT"
ssms_banner

cmd="${1:-shell}"
shift || true

case "$cmd" in
  seed)
    ssms_require_prod_confirmation "db seed"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
    ;;
  file)
    [[ -n "${1:-}" ]] || { echo "Usage: db.sh file <path.sql>" >&2; exit 1; }
    ssms_require_prod_confirmation "db file $1"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"
    ;;
  migrate)
    # Apply every migration in lexical order, stopping at the first failure.
    # NOTE: there is no migration tracking table — this re-runs everything.
    # Migrations are written to be idempotent; if one fails, fix forward.
    ssms_require_prod_confirmation "apply ALL migrations"
    shopt -s nullglob
    for f in $(ls supabase/migrations/*.sql | sort); do
      echo "── applying $f"
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
    done
    echo "✅ all migrations applied"
    ;;
  query)
    [[ -n "${1:-}" ]] || { echo "Usage: db.sh query \"<sql>\"" >&2; exit 1; }
    # Any statement could mutate; confirm on prod.
    ssms_require_prod_confirmation "db query"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "$1"
    ;;
  counts)
    psql "$DATABASE_URL" -c "
      select 'teaching_locations'   as table, count(*) from teaching_locations
      union all select 'languages',             count(*) from languages
      union all select 'course_levels_offered', count(*) from course_levels_offered
      union all select 'exam_preparations',     count(*) from exam_preparations
      order by 1;"
    ;;
  rls)
    # Expect relrowsecurity = t AND relforcerowsecurity = t on every row.
    psql "$DATABASE_URL" -c "
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname in ('instructors','instructor_certifications',
                        'instructor_trainer_status','audit_log','api_keys')
      order by relname;"
    ;;
  dump)
    out="${1:-ssms-${SSMS_ENV}-$(date -u +%Y%m%dT%H%M%SZ).sql}"
    command -v pg_dump >/dev/null 2>&1 || { echo "ERROR: pg_dump not found." >&2; exit 1; }
    pg_dump "$DATABASE_URL" --schema=public --no-owner --no-privileges -f "$out"
    echo "✅ dumped to $out"
    ;;
  shell)
    psql "$DATABASE_URL"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Use one of: seed | file <path> | migrate | query <sql> | counts | rls | dump [out] | shell" >&2
    exit 1
    ;;
esac
