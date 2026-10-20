#!/usr/bin/env bash
# Applies the Supabase shim + migrations to a scratch database, then runs the
# assertion suite (supabase/tests/test.sql).
#
# Requirements: psql pointed at a scratch Postgres (no production data!).
#   PGHOST=localhost PGPORT=5432 PGUSER=postgres bash supabase/tests/run.sh
# The database named by DB (default partnershipy_test) is dropped and recreated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DB="${DB:-partnershipy_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"

echo "-- recreating scratch database ${DB} on ${PGHOST}:${PGPORT}"
"${PSQL[@]}" -d postgres -c "drop database if exists ${DB};" -c "create database ${DB};"

echo "-- applying supabase shim (mimics auth/storage roles)"
"${PSQL[@]}" -d "$DB" -f "$SCRIPT_DIR/shim.sql"

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "-- applying $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f"
done

echo "-- running assertion suite"
"${PSQL[@]}" -d "$DB" -f "$SCRIPT_DIR/test.sql"

echo "OK: migrations applied and assertions passed"
