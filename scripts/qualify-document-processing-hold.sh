#!/usr/bin/env bash
# Offline qualification of the document processing hold.
#
# Disposable only: creates its own PostgreSQL 17 and PostgREST v14.7 containers
# on a private Docker network, replays every migration, runs
# lib/server/documentProcessingHold.postgres.test.ts against them, and removes
# everything on exit. It accepts no database URL and never reaches a hosted
# Supabase project.
set -Eeuo pipefail

suffix="$$"
network="ef-hold-net-${suffix}"
db="ef-hold-db-${suffix}"
rest_a="ef-hold-rest-a-${suffix}"
rest_b="ef-hold-rest-b-${suffix}"
rest_pre="ef-hold-rest-pre-${suffix}"
jwt_secret="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
authenticator_password="$(node -e "process.stdout.write(require('crypto').randomBytes(16).toString('hex'))")"
work="$(mktemp -d)"

cleanup() {
  docker rm -f "${rest_a}" "${rest_b}" "${rest_pre}" "${db}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  case "${work}" in */tmp.*) rm -rf -- "${work}" ;; esac
}
trap cleanup EXIT

psql_db() { docker exec -i "${db}" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$1"; }

docker network create "${network}" >/dev/null
docker run -d --name "${db}" --network "${network}" -e POSTGRES_PASSWORD=postgres postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "${db}" pg_isready -U postgres -d postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2
docker exec "${db}" pg_isready -U postgres -d postgres >/dev/null

# Hosted-Supabase surface the migrations expect (same prelude as the existing
# replay gates), plus a PostgREST authenticator.
psql_db postgres <<SQL
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS \$\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS \$\$ SELECT current_setting('request.jwt.claim.role', true) \$\$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
AS \$\$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb \$\$;
DO \$\$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
DO \$\$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN ALTER ROLE service_role BYPASSRLS; END \$\$;
DO \$\$ BEGIN CREATE ROLE extraction_rls_test_role NOLOGIN NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
GRANT authenticated TO extraction_rls_test_role;
CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${authenticator_password}';
GRANT anon, authenticated, service_role TO authenticator;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt() TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE SCHEMA storage;
CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated,service_role;
SQL

hold_migration="supabase/migrations/20261111210000_document_processing_hold.sql"
mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' | sort)
replayed=0
for migration in "${migrations[@]}"; do
  [[ "${migration}" == "${hold_migration}" ]] && continue
  LC_ALL=C perl -0777 -pe 's/\r\n/\n/g' "${migration}" > "${work}/m.sql"
  if ! psql_db postgres < "${work}/m.sql" > "${work}/replay.log" 2>&1; then
    echo "FRESH REPLAY: FAILED AT ${migration}"; tail -40 "${work}/replay.log"; exit 1
  fi
  replayed=$((replayed + 1))
done
echo "FRESH REPLAY (pre-hold): PASS (${replayed} migrations)"

# Snapshot of the deployed schema (5a7fb05) for the compatibility matrix.
psql_db postgres <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'postgres' AND pid <> pg_backend_pid();
SQL
docker exec "${db}" createdb -U postgres -T postgres prehold

LC_ALL=C perl -0777 -pe 's/\r\n/\n/g' "${hold_migration}" > "${work}/m.sql"
psql_db postgres < "${work}/m.sql"
echo "HOLD MIGRATION APPLY: PASS ($((replayed + 1)) migrations total)"
# Idempotence guard: a second apply must fail (no silent re-creation).
if psql_db postgres < "${work}/m.sql" >/dev/null 2>&1; then
  echo "HOLD MIGRATION REAPPLY: UNEXPECTEDLY SUCCEEDED"; exit 1
fi
echo "HOLD MIGRATION REAPPLY: refused as expected"

start_rest() {
  docker run -d --name "$1" --network "${network}" -p 127.0.0.1::3000 \
    -e PGRST_DB_URI="postgres://authenticator:${authenticator_password}@${db}:5432/$2" \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
    -e PGRST_JWT_SECRET="${jwt_secret}" public.ecr.aws/supabase/postgrest:v14.7 >/dev/null
}
start_rest "${rest_a}" postgres
start_rest "${rest_b}" postgres
start_rest "${rest_pre}" prehold
port_of() { docker port "$1" 3000/tcp | head -1 | sed 's/.*://'; }
url_a="http://127.0.0.1:$(port_of "${rest_a}")"
url_b="http://127.0.0.1:$(port_of "${rest_b}")"
url_pre="http://127.0.0.1:$(port_of "${rest_pre}")"
for url in "${url_a}" "${url_b}" "${url_pre}"; do
  for _ in $(seq 1 60); do curl -fsS "${url}/" >/dev/null 2>&1 && break; sleep 1; done
done

DOCUMENT_PROCESSING_HOLD_DISPOSABLE_DB=1 \
HOLD_DB_CONTAINER="${db}" \
HOLD_REST_A_CONTAINER="${rest_a}" \
HOLD_REST_A_URL="${url_a}" \
HOLD_REST_B_URL="${url_b}" \
HOLD_REST_PREHOLD_URL="${url_pre}" \
HOLD_JWT_SECRET="${jwt_secret}" \
  npx vitest run lib/server/documentProcessingHold.postgres.test.ts --reporter verbose "$@"
