#!/usr/bin/env bash
# Local disposable PostgreSQL only. No supplied production URL is accepted.
set -Eeuo pipefail
database_name="eightforge_b8_qualification_${$}"
qualification_temp="$(mktemp -d /tmp/eightforge-b8-qualification.XXXXXX)"
cleanup() {
  runuser -u postgres -- dropdb --if-exists "$database_name" >/dev/null
  case "$qualification_temp" in /tmp/eightforge-b8-qualification.*) rm -rf -- "$qualification_temp";; *) exit 1;; esac
}
trap cleanup EXIT
chmod 0755 "$qualification_temp"
runuser -u postgres -- createdb "$database_name"
psql=(runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 --dbname "$database_name")
"${psql[@]}" <<'SQL'
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.role',true)$$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN ALTER ROLE service_role BYPASSRLS; END $$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
GRANT EXECUTE ON FUNCTION auth.uid(),auth.role() TO authenticated,anon,service_role;
SQL
mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -name '*.sql' -type f | sort)
for migration in "${migrations[@]}"; do
  LC_ALL=C perl -0777 -pe 's/\r\n/\n/g' "$migration" > "$qualification_temp/migration.sql"
  chmod 0644 "$qualification_temp/migration.sql"
  "${psql[@]}" --file "$qualification_temp/migration.sql" >>"$qualification_temp/replay.log" 2>&1 || { tail -50 "$qualification_temp/replay.log"; exit 1; }
done
"${psql[@]}" --file scripts/sql/verify-region-bound-human-fact-assertions.sql >"$qualification_temp/legacy.log" 2>&1 || { cat "$qualification_temp/legacy.log"; exit 1; }
"${psql[@]}" --file scripts/sql/verify-customer-header-mapping-lifecycle.sql >"$qualification_temp/b8.log" 2>&1 || { cat "$qualification_temp/b8.log"; exit 1; }
echo "B8 FRESH MIGRATION REPLAY: PASS (${#migrations[@]} migrations)"
echo 'B8 LEGACY NO-PIN ASSERTION RPC REGRESSION: PASS'
echo 'B8 MAPPING LIFECYCLE / ACL / HISTORY / HISTORICAL PIN: PASS'
# Two real sessions approve competing children of104. Session1 holds the exact
# key lock after approval; session2 must block and then reject the stale head.
cat > "$qualification_temp/concurrent.sql" <<'SQL'
SELECT public.customer_header_mapping_canonical_json(jsonb_set(jsonb_set(envelope_canonical_json::jsonb,'{revisionId}',to_jsonb(:'revision'::text)),
 '{supersedesRevisionId}','"b8200000-0000-4000-8000-000000000104"')) AS envelope
 FROM public.customer_header_mapping_revisions WHERE revision_id='b8200000-0000-4000-8000-000000000104' \gset
SELECT data::text AS snapshot FROM public.document_extractions WHERE id='b8200000-0000-4000-8000-000000000041' \gset
BEGIN;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claim.role='service_role';
SELECT public.approve_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',:'envelope',:'snapshot'::jsonb);
SELECT pg_sleep(:hold_seconds);
COMMIT;
SQL
chmod 0644 "$qualification_temp/concurrent.sql"
"${psql[@]}" -v revision='b8200000-0000-4000-8000-000000000105' -v hold_seconds=3 --file "$qualification_temp/concurrent.sql" >"$qualification_temp/session1.log" 2>&1 &
first_pid=$!
# Observe first transaction's exact key lock rather than treating elapsed time
# as proof that the competing transaction really waited.
for attempt in $(seq 1 100); do
  held="$("${psql[@]}" -Atc "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname='$database_name' AND l.locktype='advisory' AND l.granted")"
  [[ "$held" != 0 ]] && break
  sleep 0.05
done
[[ "$held" != 0 ]] || { echo 'B8 concurrency: first key lock not observed'; exit 1; }
"${psql[@]}" -v revision='b8200000-0000-4000-8000-000000000106' -v hold_seconds=0 --file "$qualification_temp/concurrent.sql" >"$qualification_temp/session2.log" 2>&1 &
second_pid=$!
for attempt in $(seq 1 100); do
  blocked="$("${psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname='$database_name' AND wait_event_type='Lock' AND wait_event='advisory'")"
  [[ "$blocked" != 0 ]] && break
  sleep 0.02
done
[[ "$blocked" != 0 ]] || { echo 'B8 concurrency: competing session did not block'; exit 1; }
wait "$first_pid" || { cat "$qualification_temp/session1.log"; exit 1; }
if wait "$second_pid"; then echo 'B8 concurrency: stale competing approval succeeded'; exit 1; fi
grep -F 'must supersede exact current chain head' "$qualification_temp/session2.log" >/dev/null
"${psql[@]}" -Atc "SELECT 1/CASE WHEN count(*)=1 THEN 1 ELSE 0 END FROM public.customer_header_mapping_revisions WHERE revision_id IN ('b8200000-0000-4000-8000-000000000105','b8200000-0000-4000-8000-000000000106')" >/dev/null
echo 'B8 TWO-SESSION APPROVAL KEY LOCK / STALE CHILD REJECTION: PASS'
cat > "$qualification_temp/activation.sql" <<'SQL'
SELECT digest AS digest FROM public.customer_header_mapping_revisions WHERE revision_id='b8200000-0000-4000-8000-000000000105' \gset
BEGIN;
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claim.role='service_role';
SELECT public.transition_customer_header_mapping('b8200000-0000-4000-8000-000000000001','b8200000-0000-4000-8000-000000000011',
 'b8200000-0000-4000-8000-000000000105',:'digest','activate');
SELECT pg_sleep(:hold_seconds);
COMMIT;
SQL
chmod 0644 "$qualification_temp/activation.sql"
"${psql[@]}" -v hold_seconds=3 --file "$qualification_temp/activation.sql" >"$qualification_temp/activation1.log" 2>&1 &
first_pid=$!
for attempt in $(seq 1 100); do
  held="$("${psql[@]}" -Atc "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname='$database_name' AND l.locktype='advisory' AND l.granted")"
  [[ "$held" != 0 ]] && break
  sleep 0.05
done
[[ "$held" != 0 ]] || { echo 'B8 activation: first key lock not observed'; exit 1; }
"${psql[@]}" -v hold_seconds=0 --file "$qualification_temp/activation.sql" >"$qualification_temp/activation2.log" 2>&1 &
second_pid=$!
for attempt in $(seq 1 100); do
  blocked="$("${psql[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname='$database_name' AND wait_event_type='Lock' AND wait_event='advisory'")"
  [[ "$blocked" != 0 ]] && break
  sleep 0.02
done
[[ "$blocked" != 0 ]] || { echo 'B8 activation: competing session did not block'; exit 1; }
wait "$first_pid" || { cat "$qualification_temp/activation1.log"; exit 1; }
if wait "$second_pid"; then echo 'B8 activation: double activation succeeded'; exit 1; fi
grep -F 'only unactivated current approved head may activate' "$qualification_temp/activation2.log" >/dev/null
"${psql[@]}" -Atc "SELECT 1/CASE WHEN (SELECT count(*) FROM public.customer_header_mapping_active WHERE revision_id='b8200000-0000-4000-8000-000000000105')=1
 AND (SELECT count(*) FROM public.customer_header_mapping_events WHERE revision_id='b8200000-0000-4000-8000-000000000105' AND action='activated')=1 THEN 1 ELSE 0 END" >/dev/null
echo 'B8 TWO-SESSION ACTIVATION KEY LOCK / SINGLE ACTIVE REVISION: PASS'
