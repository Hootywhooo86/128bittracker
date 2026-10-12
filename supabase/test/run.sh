#!/usr/bin/env bash
# Runs family.sql + tracker.sql on a throwaway local Postgres and checks per-account isolation.
#   bash supabase/test/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)
DIR=$(mktemp -d)
trap '"$BIN/pg_ctl" -D "$DIR/db" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"' EXIT
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
chmod 777 "$DIR"
run "'$BIN/initdb' -D '$DIR/db' -A trust -U postgres >/dev/null"
run "'$BIN/pg_ctl' -D '$DIR/db' -o '-k $DIR -p 54329 -c listen_addresses=' -l '$DIR/log' start >/dev/null"
PSQL=(env PGOPTIONS='-c client_min_messages=warning' psql -h "$DIR" -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f supabase/test/supabase-stub.sql
"${PSQL[@]}" -f supabase/family.sql
"${PSQL[@]}" -f supabase/tracker.sql
"${PSQL[@]}" -f supabase/tracker.sql   # safe to run twice
"${PSQL[@]}" -o /dev/null -f supabase/test/isolation.sql
# Fresh schema for the end-to-end run (isolation.sql deleted account A).
"${PSQL[@]}" -c "drop schema public cascade; create schema public; grant usage on schema public to anon, authenticated; delete from auth.users;"
"${PSQL[@]}" -f supabase/family.sql
"${PSQL[@]}" -f supabase/tracker.sql
"${PSQL[@]}" -c "insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@x.com'), ('bbbbbbbb-0000-0000-0000-000000000002', 'b@x.com');"
PGHOST="$DIR" PGPORT=54329 node --disable-warning=ExperimentalWarning supabase/test/e2e.mjs
echo "supabase SQL: all checks passed"
