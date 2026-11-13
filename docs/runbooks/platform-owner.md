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
- **Every event records** the subject, who recorded it, why, when, and the database role used. Nothing is ever updated or deleted.
- **Fail-closed.** With no active grant, or if the lookup fails, nobody is platform owner and the tools return 403. Normal sign-in is never affected.

## Bootstrap (once, after the migration is applied)

In the production SQL editor, signed in as the project owner:

```sql
INSERT INTO public.platform_owner_grant_events (subject_user_id, granted, recorded_by, reason)
SELECT id, true, id, 'Founder bootstrap: platform owner for EightForge and Forgewing'
FROM auth.users
WHERE email = '<your login email>';
```

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

**Not covered:** `/api/internal/orchestrator` still uses its older check (`internalOrchestratorAccess.ts`). That check admits the allowlists *or any organization admin*. Moving it onto the platform owner is a separate, deliberate change.
