# Platform owner

One authenticated account administers EightForge's and Forgewing's platform-wide tools:
- the processing hold;
- workflow assessment review;
- the improvement lifecycle;
- project intelligence signals;
- repository plan runs;
- Linear projection.

It replaces the `INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS` / `_ROLES` environment allowlists, which no longer grant platform authority.

- **Ledger:** `public.platform_owner_grant_events` (migration `20261105120200`), append-only.
- **Check:** `public.is_platform_owner(user_id)`, resolved by `getActorContext` on every authenticated request, from the verified session's user id.
- **Authority:** `resolveWorkflowPlatformReviewAccess` accepts only `platformOwner === true`.

## Rules

- **Organization roles grant nothing platform-wide.** `owner` and `admin` stay tenant-scoped.
- **Only a direct database session can write the ledger,** i.e. the Supabase SQL editor. `anon`, `authenticated` and `service_role` cannot insert, update or delete, so compromising the application cannot create a platform owner.
- **One active owner at a time.** Change owners with the Hand over block below.
  - Grants are refused under `REPEATABLE READ` (55000 `platform_owner_grant_isolation`), where two racing grants could both commit.
  - The SQL editor's default, `READ COMMITTED`, is fine.
- **Every event records** the subject, who recorded it, why, when, and the database role used.
  - The database stamps the role and the time itself; values supplied in the `INSERT` are overwritten.
  - Nothing is ever updated or deleted.
- **Fail-closed.** With no active grant, or if the lookup fails, nobody is platform owner and the tools return 403. Normal sign-in is never affected.
- **Trust boundary.** Two layers protect the ledger:
  - **Privileges:** no API role (`anon`, `authenticated`, `service_role`, `authenticator`) can write the ledger or set `session_replication_role`. This is what keeps a compromised application out.
  - **Triggers:** append-only, one owner, and attribution. They hold only while they fire.
- **What the schema owner (`postgres`, i.e. the SQL editor) can still do.** It owns the table and its functions. So it can bypass the ledger and leave no reliable trace:
  - turn triggers off for a session: `SET session_replication_role = replica`, which Supabase allows for `postgres`;
  - turn them off for every future login of a role: `ALTER ROLE … SET session_replication_role = replica`. On `authenticator`, this also switches off triggers for all PostgREST traffic, including the processing hold's write fence;
  - disable a trigger on the table: `ALTER TABLE … DISABLE TRIGGER`;
  - replace `is_platform_owner` or a trigger function: `CREATE OR REPLACE FUNCTION`.
- **Guards against accidents.** That boundary is the same as owning the schema. The SQL blocks below defend against accidental bypass, not a malicious owner:
  - each write block refuses unless this session's `session_replication_role` is `origin`, all four ledger triggers are enabled, and no role or database default sets `session_replication_role`;
  - the Audit section checks the same conditions, plus the function fingerprints.
- Use only the blocks below; never a bare `INSERT`.

## Bootstrap (once, after the migration is applied)

In the production SQL editor, signed in as the project owner, replace `<your login email>` and run:

```sql
DO $bootstrap$
DECLARE
  v_email   constant text := lower(btrim('<your login email>'));
  v_matches integer;
  v_user    uuid;
BEGIN
  IF v_email = '' OR v_email LIKE '<%' THEN
    RAISE EXCEPTION 'bootstrap refused: replace <your login email> first';
  END IF;
  -- Ledger guard (identical in every write block): the triggers must fire.
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'refused: triggers are off (session_replication_role = %); run SET session_replication_role = origin',
      current_setting('session_replication_role');
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.platform_owner_grant_events'::regclass
        AND t.tgname IN ('platform_owner_grant_events_immutable', 'platform_owner_grant_events_no_truncate',
                         'platform_owner_grant_events_stamp', 'platform_owner_grant_events_validate')
        AND t.tgenabled IN ('O', 'A')) <> 4 THEN
    RAISE EXCEPTION 'refused: a ledger trigger is disabled or missing; run the Audit checks';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c(setting)
             WHERE c.setting LIKE 'session_replication_role=%' AND c.setting <> 'session_replication_role=origin') THEN
    RAISE EXCEPTION 'refused: a role or database default sets session_replication_role; run the Audit checks';
  END IF;
  SELECT count(*) INTO v_matches FROM auth.users u WHERE lower(btrim(u.email)) = v_email;
  IF v_matches <> 1 THEN
    RAISE EXCEPTION 'bootstrap refused: % accounts have that login email (need exactly 1)', v_matches;
  END IF;
  SELECT u.id INTO v_user FROM auth.users u
  WHERE lower(btrim(u.email)) = v_email
    AND u.deleted_at IS NULL AND u.email_confirmed_at IS NOT NULL
    AND NOT coalesce(u.is_anonymous, false)
    AND (u.banned_until IS NULL OR u.banned_until <= now());
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'bootstrap refused: the account is unconfirmed, anonymous, banned or deleted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = v_user) THEN
    RAISE EXCEPTION 'bootstrap refused: the account has no EightForge user profile';
  END IF;
  IF public.is_platform_owner(v_user) THEN
    RAISE NOTICE 'already the platform owner; nothing recorded';
    RETURN;
  END IF;
  INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
  VALUES (v_user, true, v_user, 'Founder bootstrap: platform owner for EightForge and Forgewing');
END
$bootstrap$;
```

The statement:
- resolves exactly one account, case-insensitively;
- refuses a missing, ambiguous, unconfirmed, banned, deleted or profile-less account;
- refuses to run if the ledger's triggers are off for this session, disabled on the table, or turned off by a role or database default, so the one-owner check and attribution stamp apply to it;
- records exactly one grant, or nothing;
- is safe to re-run.

Do not use a bare `INSERT … SELECT … WHERE email = …`: it silently records nothing when the email does not match.

Verify:

```sql
SELECT u.email, public.is_platform_owner(u.id) AS platform_owner
FROM auth.users u
WHERE lower(btrim(u.email)) = lower(btrim('<your login email>'));
```

The change applies on your next request; no sign-out is needed.

## Hand over

Revokes whoever is active and grants the new owner, in one transaction. Replace the three placeholders:

```sql
DO $handover$
DECLARE
  v_me_email  constant text := lower(btrim('<your login email>'));
  v_new_email constant text := lower(btrim('<new owner login email>'));
  v_reason    constant text := btrim('<why>');
  v_me  uuid;
  v_new uuid;
  r     record;
BEGIN
  IF v_me_email LIKE '<%' OR v_new_email LIKE '<%' OR v_reason = '' OR v_reason LIKE '<%' THEN
    RAISE EXCEPTION 'hand-over refused: replace every <placeholder> first';
  END IF;
  -- Ledger guard (identical in every write block): the triggers must fire.
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'refused: triggers are off (session_replication_role = %); run SET session_replication_role = origin',
      current_setting('session_replication_role');
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.platform_owner_grant_events'::regclass
        AND t.tgname IN ('platform_owner_grant_events_immutable', 'platform_owner_grant_events_no_truncate',
                         'platform_owner_grant_events_stamp', 'platform_owner_grant_events_validate')
        AND t.tgenabled IN ('O', 'A')) <> 4 THEN
    RAISE EXCEPTION 'refused: a ledger trigger is disabled or missing; run the Audit checks';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c(setting)
             WHERE c.setting LIKE 'session_replication_role=%' AND c.setting <> 'session_replication_role=origin') THEN
    RAISE EXCEPTION 'refused: a role or database default sets session_replication_role; run the Audit checks';
  END IF;
  IF (SELECT count(*) FROM auth.users u WHERE lower(btrim(u.email)) = v_me_email) <> 1
     OR (SELECT count(*) FROM auth.users u WHERE lower(btrim(u.email)) = v_new_email) <> 1 THEN
    RAISE EXCEPTION 'hand-over refused: each login email must match exactly one account';
  END IF;
  SELECT u.id INTO v_me FROM auth.users u WHERE lower(btrim(u.email)) = v_me_email;
  SELECT u.id INTO v_new FROM auth.users u
  WHERE lower(btrim(u.email)) = v_new_email
    AND u.deleted_at IS NULL AND u.email_confirmed_at IS NOT NULL
    AND NOT coalesce(u.is_anonymous, false)
    AND (u.banned_until IS NULL OR u.banned_until <= now());
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'hand-over refused: the new owner account is unconfirmed, anonymous, banned or deleted';
  END IF;
  IF public.is_platform_owner(v_new) THEN
    RAISE NOTICE 'already the platform owner; nothing recorded';
    RETURN;
  END IF;
  FOR r IN
    SELECT l.subject_user_id
    FROM (SELECT DISTINCT ON (e.subject_user_id) e.subject_user_id, e.granted
          FROM public.platform_owner_grant_events e
          ORDER BY e.subject_user_id, e.event_seq DESC) l
    WHERE l.granted
  LOOP
    INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
    VALUES (r.subject_user_id, false, v_me, v_reason);
  END LOOP;
  INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
  VALUES (v_new, true, v_me, v_reason);
END
$handover$;
```

Both accounts need an EightForge profile; the ledger refuses an event that names an account without one.

## Revoke

Revokes every active owner. The platform tools then refuse everyone until a new bootstrap. Replace both placeholders:

```sql
DO $revoke$
DECLARE
  v_me_email constant text := lower(btrim('<your login email>'));
  v_reason   constant text := btrim('<why>');
  v_me      uuid;
  v_revoked integer := 0;
  r         record;
BEGIN
  IF v_reason = '' OR v_reason LIKE '<%' THEN
    RAISE EXCEPTION 'revocation refused: write a reason first';
  END IF;
  -- Revocation is never blocked by the ledger guard, because it is the safe
  -- direction. A failed check is reported and the revocation still happens.
  IF current_setting('session_replication_role') <> 'origin'
     OR (SELECT count(*) FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = 'public.platform_owner_grant_events'::regclass
           AND t.tgname IN ('platform_owner_grant_events_immutable', 'platform_owner_grant_events_no_truncate',
                            'platform_owner_grant_events_stamp', 'platform_owner_grant_events_validate')
           AND t.tgenabled IN ('O', 'A')) <> 4
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c(setting)
                WHERE c.setting LIKE 'session_replication_role=%' AND c.setting <> 'session_replication_role=origin') THEN
    RAISE WARNING 'ledger guard failed (triggers off, disabled, or a role default); revoking anyway. Run the Audit checks next.';
  END IF;
  IF (SELECT count(*) FROM auth.users u WHERE lower(btrim(u.email)) = v_me_email) = 1 THEN
    SELECT u.id INTO v_me FROM auth.users u
    WHERE lower(btrim(u.email)) = v_me_email
      AND EXISTS (SELECT 1 FROM public.user_profiles p WHERE p.id = u.id);
  END IF;
  FOR r IN
    SELECT l.subject_user_id
    FROM (SELECT DISTINCT ON (e.subject_user_id) e.subject_user_id, e.granted
          FROM public.platform_owner_grant_events e
          ORDER BY e.subject_user_id, e.event_seq DESC) l
    WHERE l.granted
  LOOP
    INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
    VALUES (r.subject_user_id, false, coalesce(v_me, r.subject_user_id),
            v_reason || CASE WHEN v_me IS NULL THEN ' [recorder unresolved; self-recorded]' ELSE '' END);
    v_revoked := v_revoked + 1;
  END LOOP;
  RAISE NOTICE 'revoked % active platform owner(s)', v_revoked;
END
$revoke$;
```

If the owner account itself is compromised, also end its sessions: in the Supabase Dashboard, open Authentication, then Users, and ban that user or reset its password.

## Audit

The history:

```sql
SELECT event_seq, subject_user_id, granted, recorded_by, reason, recorded_at, recorded_by_db_role
FROM public.platform_owner_grant_events
ORDER BY event_seq;
```

The ledger guard's conditions. Every `ok` should be true:

```sql
SELECT 'this session has triggers on' AS check_name,
       current_setting('session_replication_role') = 'origin' AS ok
UNION ALL
SELECT 'all four ledger triggers enabled',
       (SELECT count(*) FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.platform_owner_grant_events'::regclass
          AND t.tgname IN ('platform_owner_grant_events_immutable', 'platform_owner_grant_events_no_truncate',
                           'platform_owner_grant_events_stamp', 'platform_owner_grant_events_validate')
          AND t.tgenabled IN ('O', 'A')) = 4
UNION ALL
SELECT 'no role or database default turns triggers off',
       NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) AS c(setting)
                   WHERE c.setting LIKE 'session_replication_role=%' AND c.setting <> 'session_replication_role=origin');
```

To see which role has such a default:

```sql
SELECT r.rolname, d.datname, s.setconfig
FROM pg_catalog.pg_db_role_setting s
LEFT JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
LEFT JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase;
```

Clear it with `ALTER ROLE <role> RESET session_replication_role`.

These checks don't detect a replaced function. The release preflight fingerprints `is_platform_owner` and the trigger functions against the migration; re-run it after any schema change.

**Improvement Orchestrator:** `/api/internal/orchestrator` (`internalOrchestratorAccess.ts`) also requires the platform owner. The former "allowlist or any organization admin" rule is gone.
- The grant opens access only.
- The orchestrator's own protections are unchanged:
  - it is unavailable in production builds;
  - its output is advisory text and a prompt file;
  - provider configuration is checked separately.

**Not platform-owner scoped, by design:**
- **Organization-scoped tools:** Ask This Project, document diagnostics, recovery review, Forgewing friction intake, customer header mappings.
- **Scheduled crons:** authorized by `CRON_SECRET`.
