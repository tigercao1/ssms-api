#!/usr/bin/env bash
#
# PR-time rules for supabase/migrations, checked against a base ref:
#
#   1. Files already on the base branch are immutable (no edit, delete or rename).
#      ALLOW_EDIT=true (label `migration:edit-unapplied`) permits editing, not
#      renaming or deleting, a migration that failed and was never applied. The
#      runner still refuses to run if an edited file is recorded as applied.
#   2. New files are named NNN_snake_case.sql and numbered above every file on base.
#   3. Plain SQL only: no transaction control (the runner wraps all pending files in
#      one transaction), no psql backslash commands, no CONCURRENTLY.
#   4. Destructive statements, top level or inside a DO block, fail unless
#      ALLOW_DESTRUCTIVE=true (the PR carries the `migration:destructive` label).
#      Migrations run before the new code deploys, so they must work with the
#      code that is already live.
#
#   scripts/check-migrations.sh origin/main
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

BASE="${1:?usage: check-migrations.sh <base-ref>}"
ALLOW_DESTRUCTIVE="${ALLOW_DESTRUCTIVE:-false}"
ALLOW_EDIT="${ALLOW_EDIT:-false}"
DIR="supabase/migrations"
NAME_PATTERN='^[0-9]{3}_[a-z0-9_]+\.sql$'
B='(^|[^a-z0-9_])'
E='([^a-z0-9_]|$)'

export LC_ALL=C
cd "$(git rev-parse --show-toplevel)"

failures=0
fail() {
  local file="$1" msg="$2"
  failures=$((failures + 1))
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    echo "::error file=$file::$msg"
  else
    echo "✗ $file: $msg"
  fi
}

base_max="$(git ls-tree --name-only "$BASE" "$DIR/" | xargs -n1 basename | { grep -E "$NAME_PATTERN" || true; } | sort | tail -1 | cut -c1-3)"
base_max=$((10#${base_max:-0}))

added=()
edited=" "
while IFS=$'\t' read -r status path rest; do
  case "$status" in
    A) added+=("$path") ;;
    M)
      if [[ "$ALLOW_EDIT" == "true" ]]; then
        echo "! $path: edit allowed by the 'migration:edit-unapplied' label"
        added+=("$path")
        edited="$edited$path "
      else
        fail "$path" "edited; migrations already on main are immutable, add a new file instead (or label 'migration:edit-unapplied' if it was never applied)"
      fi
      ;;
    *) fail "$path" "status $status; migrations already on main are immutable, add a new file instead" ;;
  esac
done < <(git diff --name-status -M "$BASE"...HEAD -- "$DIR/" | awk -F'\t' '{print $1 "\t" ($3 ? $3 : $2) "\t" ($3 ? $2 : "")}')

seen=" "
new_count=0
for path in ${added[@]+"${added[@]}"}; do
  name="$(basename "$path")"
  [[ "$name" == ".gitkeep" ]] && continue
  if [[ ! "$name" =~ $NAME_PATTERN ]]; then
    fail "$path" "name must match $NAME_PATTERN (e.g. 261_add_widget.sql)"
    continue
  fi
  num=$((10#${name:0:3}))
  if [[ "$edited" == *" $path "* ]]; then
    :
  elif ((num <= base_max)); then
    fail "$path" "number ${name:0:3} must be greater than the highest on base ($(printf '%03d' "$base_max"))"
  fi
  if [[ "$seen" == *" $num "* ]]; then
    fail "$path" "number ${name:0:3} is used by another new migration in this PR"
  fi
  seen="$seen$num "
  new_count=$((new_count + 1))

  scanned="$(scripts/sql_scan.py "$path")"
  top="$(sed -n 's/^top //p' <<<"$scanned")"
  executed="$(sed -nE 's/^(top|do) //p' <<<"$scanned")"

  if grep -qE "^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction)( |$)" <<<"$top"; then
    fail "$path" "contains transaction control; the runner wraps migrations in a transaction"
  fi
  if grep -q '^meta ' <<<"$scanned"; then
    fail "$path" "contains a psql backslash command; migrations must be plain SQL"
  fi
  if grep -qE "${B}concurrently${E}" <<<"$top"; then
    fail "$path" "uses CONCURRENTLY, which cannot run inside the runner's transaction"
  fi

  destructive="$(
    grep -E "${B}drop (table|schema|column)${E}" <<<"$executed" || true
    grep -E "${B}alter table${E}" <<<"$executed" \
      | sed -E 's/drop (constraint|default|not null|identity|expression)//g' \
      | grep -E "${B}drop${E}" || true
    grep -E "${B}(truncate|rename)${E}" <<<"$executed" || true
    grep -E "${B}delete from${E}" <<<"$executed" || true
    grep -E "${B}set not null${E}" <<<"$executed" || true
    grep -E "${B}alter column [a-z0-9_\"]+ (set data )?type${E}" <<<"$executed" || true
  )"
  if [[ -n "$destructive" && "$ALLOW_DESTRUCTIVE" != "true" ]]; then
    while read -r stmt; do
      fail "$path" "destructive statement needs the 'migration:destructive' label: $(cut -c1-120 <<<"$stmt")"
    done < <(sort -u <<<"$destructive" | sed 's/^ *//')
  fi
done

if ((failures > 0)); then
  echo "$failures migration rule violation(s)."
  exit 1
fi
echo "Migration rules passed ($new_count new file(s), base max $(printf '%03d' "$base_max"))."
