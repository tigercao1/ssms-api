#!/usr/bin/env bash
#
# Fails unless DATABASE_URL points at the Supabase project EXPECT_PROJECT_REF,
# so a secret pasted into the wrong GitHub Environment cannot migrate or dump
# the wrong database.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is not set}"
: "${EXPECT_PROJECT_REF:?EXPECT_PROJECT_REF is not set}"

case "$DATABASE_URL" in
  *"postgres.${EXPECT_PROJECT_REF}:"* | *"@db.${EXPECT_PROJECT_REF}.supabase.co"*)
    echo "target: Supabase project $EXPECT_PROJECT_REF"
    ;;
  *)
    echo "ERROR: DATABASE_URL does not point at project $EXPECT_PROJECT_REF" >&2
    exit 1
    ;;
esac
