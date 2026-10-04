#!/usr/bin/env bash
#
# Tracked migration runner: applies each file in supabase/migrations exactly once
# and records it in ssms_meta.schema_migrations.
#
#   scripts/migrate.sh status                 # applied / pending / changed / missing
#   scripts/migrate.sh apply                  # apply every pending file, one transaction
#   scripts/migrate.sh baseline <file.sql>    # record files up to <file.sql> as applied
#                                             # without running them (one-time adoption)
#
# Target database: $DATABASE_URL, or the libpq PG* variables when it is unset.
# For dev/prod use `SSMS_ENV=<env> ./scripts/db.sh migrate <cmd>`, which loads
# .env.<env> and asks for confirmation before writing to prod.
#
# MIGRATIONS_DIR overrides the directory (CI uses it to apply a base branch's files).
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"
GIT_SHA="${MIGRATE_GIT_SHA:-${GITHUB_SHA:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)}}"
LOCK_KEY=731029401
NAME_PATTERN='^[0-9]{3}_[a-z0-9_]+\.sql$'

export LC_ALL=C

TMP_SCRIPT=""
trap '[[ -z "$TMP_SCRIPT" ]] || rm -f "$TMP_SCRIPT"' EXIT

INIT_SQL="
set client_min_messages = warning;
create schema if not exists ssms_meta;
revoke all on schema ssms_meta from public;
create table if not exists ssms_meta.schema_migrations (
  filename   text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now(),
  git_sha    text not null
);
reset client_min_messages;
"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

psql_run() {
  psql ${DATABASE_URL:+"$DATABASE_URL"} -X -q -v ON_ERROR_STOP=1 "$@"
}

checksum() {
  shasum -a 256 "$1" | awk '{print $1}'
}

migration_files() {
  [[ -d "$MIGRATIONS_DIR" ]] || die "migrations directory not found: $MIGRATIONS_DIR"
  local f name
  for f in "$MIGRATIONS_DIR"/*.sql; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    [[ "$name" =~ $NAME_PATTERN ]] || die "migration file name does not match $NAME_PATTERN: $name"
    echo "$name"
  done | sort
}

applied_rows() {
  local exists
  exists="$(psql_run -At -c "select to_regclass('ssms_meta.schema_migrations') is not null")"
  [[ "$exists" == "t" ]] || return 0
  psql_run -At -F ' ' -c "select filename, checksum from ssms_meta.schema_migrations order by filename"
}

# Prints one line per migration: <state> <filename>, where state is
# applied | pending | changed | missing.
classify() {
  local applied files name sum recorded
  files="$(migration_files)"
  applied="$(applied_rows)"
  while read -r name; do
    sum="$(checksum "$MIGRATIONS_DIR/$name")"
    recorded="$(awk -v n="$name" '$1 == n {print $2}' <<<"$applied")"
    if [[ -z "$recorded" ]]; then
      echo "pending $name"
    elif [[ "$recorded" == "$sum" ]]; then
      echo "applied $name"
    else
      echo "changed $name"
    fi
  done <<<"$files"
  while read -r name _; do
    [[ -n "$name" ]] || continue
    [[ -f "$MIGRATIONS_DIR/$name" ]] || echo "missing $name"
  done <<<"$applied"
}

cmd_status() {
  local rows bad
  rows="$(classify)"
  awk '{
    label = ($1 == "applied") ? "applied" : toupper($1)
    note = ""
    if ($1 == "changed") note = "  (file edited after it was applied)"
    if ($1 == "missing") note = "  (recorded as applied, file not in repo)"
    printf "  %-8s %s%s\n", label, $2, note
  }' <<<"$rows"
  echo "$(grep -c '^applied ' <<<"$rows" || true) applied, $(grep -c '^pending ' <<<"$rows" || true) pending"
  bad="$(grep -E '^(changed|missing) ' <<<"$rows" || true)"
  [[ -z "$bad" ]] || return 1
}

cmd_apply() {
  local rows pending script name
  rows="$(classify)"
  if grep -qE '^(changed|missing) ' <<<"$rows"; then
    cmd_status || true
    die "refusing to apply: applied migrations do not match the repo"
  fi
  pending="$(awk '$1 == "pending" {print $2}' <<<"$rows")"
  if [[ -z "$pending" ]]; then
    echo "Nothing to apply."
    return 0
  fi

  script="$(mktemp)"
  TMP_SCRIPT="$script"
  {
    echo "begin;"
    echo "select pg_advisory_xact_lock($LOCK_KEY) as locked \\gset"
    echo "$INIT_SQL"
    while read -r name; do
      echo "\\echo '── applying $name'"
      echo "\\i '$MIGRATIONS_DIR/$name'"
      echo "insert into ssms_meta.schema_migrations (filename, checksum, git_sha)"
      echo "  values ('$name', '$(checksum "$MIGRATIONS_DIR/$name")', '$GIT_SHA');"
    done <<<"$pending"
    echo "commit;"
  } >"$script"

  psql_run -f "$script"
  echo "✅ applied $(wc -l <<<"$pending" | tr -d ' ') migration(s)"
}

cmd_baseline() {
  local last="${1:-}" count script name files
  [[ -n "$last" ]] || die "usage: migrate.sh baseline <file.sql>"
  [[ -f "$MIGRATIONS_DIR/$last" ]] || die "no such migration: $last"
  files="$(migration_files)"
  if [[ -n "$(applied_rows)" ]]; then
    die "ssms_meta.schema_migrations already has rows; baseline is for first adoption only"
  fi

  script="$(mktemp)"
  TMP_SCRIPT="$script"
  count=0
  {
    echo "begin;"
    echo "select pg_advisory_xact_lock($LOCK_KEY) as locked \\gset"
    echo "$INIT_SQL"
    while read -r name; do
      [[ "$name" > "$last" ]] && break
      echo "insert into ssms_meta.schema_migrations (filename, checksum, git_sha)"
      echo "  values ('$name', '$(checksum "$MIGRATIONS_DIR/$name")', 'baseline');"
    done <<<"$files"
    echo "commit;"
  } >"$script"
  count="$(grep -c '^insert ' "$script")"

  psql_run -f "$script"
  echo "✅ baselined $count migration(s) up to $last"
}

case "${1:-status}" in
  status) cmd_status ;;
  apply) cmd_apply ;;
  baseline) cmd_baseline "${2:-}" ;;
  *) die "unknown command: $1 (use status | apply | baseline <file.sql>)" ;;
esac
