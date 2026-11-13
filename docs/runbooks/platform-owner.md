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
- **One active owner at a time.** Change owners by revoking, then granting.
  - Grants are refused under `REPEATABLE READ` (55000 `platform_owner_grant_isolation`), where two racing grants could both commit.
  - The SQL editor's default, `READ COMMITTED`, is fine.
- **Every event records** the subject, who recorded it, why, when, and the database role used.
  - The database stamps the role and the time itself; values supplied in the `INSERT` are overwritten.
  - Nothing is ever updated or deleted.
- **Fail-closed.** With no active grant, or if the lookup fails, nobody is platform owner and the tools return 403. Normal sign-in is never affected.
- **Trust boundary.** Triggers enforce append-only, one owner and attribution.
  - They bind every API role and every ordinary direct session.
  - They do not bind a direct session that turns triggers off with `SET session_replication_role = replica`. Supabase lets `postgres` set it, and in that mode a session can record a second owner, forge attribution, or delete events.
  - They also do not bind a session that alters the table as its owner.
  - That is the same boundary as owning the schema, and the same one the processing hold's write fence documents.
  - `anon`, `authenticated` and `service_role` cannot set `session_replication_role`.
  - The bootstrap below refuses to run with triggers off. For hand-over and revocation, run the statements in a fresh SQL editor session, where the setting is `origin`.

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
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'bootstrap refused: triggers are off (session_replication_role = %); run SET session_replication_role = origin',
      current_setting('session_replication_role');
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
- refuses to run while triggers are off, so the ledger's one-owner check and attribution stamp always apply to it;
- records exactly one grant, or nothing;
- is safe to re-run.

Do not use a bare `INSERT … SELECT … WHERE email = …`: it silently records nothing when the email does not match.

Verify:

```sql
SELECT u.email, public.is_platform_owner(u.id) AS platform_owner
FROM auth.users u
WHERE u.email = '<your login email>';
```

The change applies on your next request; no sign-out is needed.

## Hand over or revoke

```sql
-- Revoke the current owner
INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
VALUES ('<current owner user id>', false, '<your user id>', '<why>');

-- Grant the new owner (refused while another owner is active)
INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
VALUES ('<new owner user id>', true, '<your user id>', '<why>');
```

## Audit

```sql
SELECT event_seq, subject_user_id, granted, recorded_by, reason, recorded_at, recorded_by_db_role
FROM public.platform_owner_grant_events
ORDER BY event_seq;
```

**Improvement Orchestrator:** `/api/internal/orchestrator` (`internalOrchestratorAccess.ts`) also requires the platform owner. The former "allowlist or any organization admin" rule is gone.
- The grant opens access only.
- The orchestrator's own protections are unchanged:
  - it is unavailable in production builds;
  - its output is advisory text and a prompt file;
  - provider configuration is checked separately.

**Not platform-owner scoped, by design:**
- **Organization-scoped tools:** Ask This Project, document diagnostics, recovery review, Forgewing friction intake, customer header mappings.
- **Scheduled crons:** authorized by `CRON_SECRET`.
