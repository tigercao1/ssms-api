#!/usr/bin/env bash
#
# Thin wrapper around psql for the SSMS Supabase database.
#
# Requires DATABASE_URL to be set (use the IPv4 *Session pooler* string from the
# Supabase dashboard → Connect → Session pooler; the direct db.<ref>.supabase.co
# host is IPv6-only and may not resolve on many networks).
#
# Usage:
#   ./scripts/db.sh seed                 # apply supabase/seed.sql (idempotent)
#   ./scripts/db.sh query "select 1;"    # run a one-off SQL statement
#   ./scripts/db.sh file path/to.sql     # run an arbitrary .sql file
#   ./scripts/db.sh shell                # open an interactive psql session
#   ./scripts/db.sh counts               # quick reference-data row counts
#
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "Get it from Supabase dashboard → Connect → Session pooler, e.g.:" >&2
  echo "  export DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found. Install with: brew install libpq && brew link --force libpq" >&2
  exit 1
fi

cmd="${1:-shell}"
shift || true

case "$cmd" in
  seed)
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/seed.sql
    ;;
  file)
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$1"
    ;;
  query)
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
  shell)
    psql "$DATABASE_URL"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Use one of: seed | file <path> | query <sql> | counts | shell" >&2
    exit 1
    ;;
esac
