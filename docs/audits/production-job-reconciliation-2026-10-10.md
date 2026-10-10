# Production job reconciliation (2026-10-10)

The owner explicitly approved, on 2026-10-10, a narrow reconciliation of the three historical jobs documented as still `running` in `production-reanalysis-preparation-2026-10-09.md`. Nothing else was written: there was no bulk cleanup and no document change.

- **Project:** Supabase `jpzeckefppmiujwajgvk`.
- **Organization:** `11111111-1111-1111-1111-111111111111`.

## Method

1. **Pre-write read** at 14:34 UTC. Each row was re-read and confirmed to be the exact audited row: same id, document id, `started_at` and attempt count (1). Each was still `running`, with no `completed_at` and no `error_message`.
2. **One conditional update per row.** The guard was `WHERE id = ? AND document_id = ? AND status = 'running' AND attempt_count = 1 AND started_at = <audited value> AND completed_at IS NULL`, and the update returned the row it changed.
   - It set `status = 'failed'` and `error_message = 'expired: exceeded platform maximum duration'`.
   - A row that had changed would have matched nothing and been left alone. Each update matched exactly one row.
   - No more specific termination cause is claimed: the platform limit is 300 s, Vercel Hobby with Fluid compute.
3. **Post-write read.** All three rows are `failed` with that message. `completed_at` and `attempt_count` are unchanged. No job in production is `running` or `queued`.

## Per-row audit

| Job | Document | Started (UTC) | Before | After | Document state (unchanged) |
|---|---|---|---|---|---|
| `f5c0c348-14b1-4fae-97c7-c7ad399b4419` | `04e23a28-61a0-4abc-91ac-8c6f2db31ecf` | 2026-05-26 14:23:29.124 | running, attempt 1, no error | failed, `expired: exceeded platform maximum duration` | decisioned, live |
| `b2827cd8-a940-4176-b3b5-c09ba0f2252d` | `722d3aa7-9f42-42dc-9830-737ae73041a5` | 2026-08-11 19:41:58.352 | running, attempt 1, no error | failed, same message | processing, deleted 2026-08-11 19:43:07 (not touched) |
| `9293abe6-3063-4495-85ea-151708809c11` | `c295be20-0a7c-4a98-92f6-783a1eb11c40` | 2026-08-11 19:52:22.239 | running, attempt 1, no error | failed, same message | decisioned, live |

The pre-write snapshot is kept outside Git with the other production evidence.

## Derived display, going forward

A job that stays persisted as `running` longer than 15 minutes now appears in the document diagnostics as **`document_processing_expired`**. This is derived at read time in `lib/server/documentDiagnosticsRead.ts`, and the stored row is never changed by it.

- **Threshold:** 15 minutes, against a platform maximum of 300 s.
- **Scope:** only the latest job counts, so a stale job that a later run superseded shows nothing.
- **Attention:** blocking, retryable, "reprocess document".

There is no heartbeat, lease column or cleanup cron.
