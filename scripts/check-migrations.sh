#!/usr/bin/env bash
#
# PR-time rules for supabase/migrations, checked against a base ref:
#
#   1. Files already on the base branch are immutable (no edit, delete or rename).
#   2. New files are named NNN_snake_case.sql and numbered above every file on base.
#   3. No transaction control (the runner wraps all pending files in one transaction)
#      and no CREATE INDEX CONCURRENTLY (cannot run inside a transaction).
#   4. Destructive statements fail unless ALLOW_DESTRUCTIVE=true (the PR carries the
#      `migration:destructive` label). Migrations run before the new code deploys,
#      so they must work with the code that is already live.
#
#   scripts/check-migrations.sh origin/main
set -euo pipefail
shopt -s inherit_errexit 2>/dev/null || true

BASE="${1:?usage: check-migrations.sh <base-ref>}"
ALLOW_DESTRUCTIVE="${ALLOW_DESTRUCTIVE:-false}"
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

base_max="$(git ls-tree --name-only "$BASE" "$DIR/" | xargs -n1 basename | grep -E "$NAME_PATTERN" | sort | tail -1 | cut -c1-3)"
base_max=$((10#${base_max:-0}))

added=()
while IFS=$'\t' read -r status path rest; do
  case "$status" in
    A) added+=("$path") ;;
    R*) fail "$path" "renames $rest; migrations already on main are immutable, add a new file instead" ;;
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
  if ((num <= base_max)); then
    fail "$path" "number ${name:0:3} must be greater than the highest on base ($(printf '%03d' "$base_max"))"
  fi
  if [[ "$seen" == *" $num "* ]]; then
    fail "$path" "number ${name:0:3} is used by another new migration in this PR"
  fi
  seen="$seen$num "
  new_count=$((new_count + 1))

  # One line per statement, comments stripped, lower-cased.
  statements="$(sed -e 's/--.*$//' "$path" | tr '\n' ' ' | tr ';' '\n' | tr '[:upper:]' '[:lower:]' | tr -s ' ')"

  if grep -qE "^ *(begin|commit|rollback|start transaction|savepoint)( |$)" <<<"$statements"; then
    fail "$path" "contains transaction control; the runner wraps migrations in a transaction"
  fi
  if grep -qE "${B}concurrently${E}" <<<"$statements"; then
    fail "$path" "uses CONCURRENTLY, which cannot run inside the runner's transaction"
  fi

  destructive="$(
    grep -E "${B}drop (table|schema|column)${E}" <<<"$statements" || true
    grep -E "${B}alter table${E}" <<<"$statements" \
      | sed -E 's/drop (constraint|default|not null|identity|expression)//g' \
      | grep -E "${B}drop${E}" || true
    grep -E "${B}(truncate|rename)${E}" <<<"$statements" || true
    grep -E "${B}delete from${E}" <<<"$statements" || true
    grep -E "${B}set not null${E}" <<<"$statements" || true
    grep -E "${B}alter column [a-z0-9_\"]+ (set data )?type${E}" <<<"$statements" || true
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
