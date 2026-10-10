#!/usr/bin/env bash
#
# Encrypted logical backup of the public schema (schema + data).
#
#   DATABASE_URL=... BACKUP_AGE_RECIPIENT=age1... scripts/backup-db.sh <out-prefix>
#
# Writes <out-prefix>.sql.age and prints its path. The plaintext dump never
# leaves the temp directory. Restore steps: supabase/README.md § Backups.
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

prefix="${1:?usage: backup-db.sh <out-prefix>}"
: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is not set}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
plain="$tmp/dump.sql"

# --clean --if-exists so the dump restores into a database that already has a
# public schema (every PostgreSQL >= 15 database does).
pg_dump "$DATABASE_URL" \
  --schema=public --no-owner --no-privileges \
  --clean --if-exists \
  -f "$plain"

bytes=$(wc -c <"$plain")
echo "dumped $bytes bytes" >&2
if [ "$bytes" -lt 10000 ]; then
  echo "ERROR: dump is suspiciously small ($bytes bytes)" >&2
  exit 1
fi
grep -q 'CREATE TABLE public.instructors' "$plain" \
  || { echo "ERROR: dump is missing the instructors table" >&2; exit 1; }

age -r "$BACKUP_AGE_RECIPIENT" -o "$prefix.sql.age" "$plain"
echo "$prefix.sql.age"
