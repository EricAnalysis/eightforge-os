# Production function duration and job claim (2026-10-10)

This follows step H (production runtime hardening) in `docs/handoffs/claude-current-handoff.md`. Production was only read. The one code change is the atomic job claim below.

## 1. Effective function duration: what is now known

| Fact | Evidence |
|---|---|
| Plan is **Hobby** | The Vercel runtime-logs API, queried for project `prj_AJR1wf21cEXYkYyBX0W6nFGgzDFk` in team `team_pcUyrpKqevZ8CHuWoihcQnLb`, refused a 30-day window: "The hobby plan does not retain runtime logs for the requested time range" (2026-10-10). |
| Live production deployment | `dpl_7oicDG6dqyqGEavUayiz637HbwmR`, commit `3c0e056` (#189), region `iad1`, Node 24.x. Later merges (#190–#193) were docs-only and did not produce a newer READY production deployment. |
| Hobby duration limits | Vercel docs (`/docs/functions/configuring-functions/duration`, updated 2026-08-24): with Fluid compute the **default and the maximum are both 300 s**. |
| Fluid compute | **Enabled.** The owner's dashboard screenshot of Project Settings → Functions (2026-10-10) shows Fluid Compute enabled and the function region iad1. The deployment and project APIs available here do not return the setting. |
| Route exports | `/api/jobs/process/[jobId]` and `/api/documents/process` export no `maxDuration`. They therefore run at the plan default, 300 s. The `app/api/internal/*` routes set 30–60 s. |

**Decision: no `maxDuration` is set.** On Hobby with Fluid enabled, 300 s is already both the default and the ceiling for the processing routes, so exporting it would change nothing. A processing run longer than 300 s cannot complete on Hobby at all; that would be a plan decision for the owner, not a code fix.

## 2. Job claim race: fixed

`POST /api/jobs/process/[jobId]` read the job, checked `status === 'queued'`, then wrote `running` in a separate update. Two concurrent dispatches for one job could both pass the check and both process it, inserting duplicate extractions and duplicate decisions for the same job.

**Fix:** the route now claims the job with one conditional update, `claimQueuedJob` in `lib/server/analysisJobService.ts`:

- The update is `UPDATE … SET status='running', started_at, attempt_count = n+1 WHERE id = ? AND status = 'queued'`.
- If no row matched, the loser returns 409 and touches nothing.
- If the claim errors, the outcome is unknown, so the route returns 503 and never marks the job or document failed. Another dispatch may own it.

There is no schema change. `lib/pipeline/processDocument.ts` creates its own job immediately before running it, so it has no shared-job race and is unchanged.

Tests are in `lib/server/analysisJobClaim.test.ts`:

- the claim condition and the attempt count;
- a lost race;
- a claim error that fails loudly;
- the route on a lost claim: 409, no download, no status writes;
- the route on an unknown claim outcome: 503, no status writes.

## 3. Still open: killed runs leave `running` / `processing`

If the platform terminates a function mid-run, nothing moves its job out of `running` or its document out of `processing`. A new analysis still works, because every analyze call creates a fresh job, so this is a display and audit problem, not a blocker.

On Hobby with Fluid, no invocation can outlive 300 s, so a job `running` for more than 15 minutes is provably dead.

**Proposed reconciliation (not built; needs owner approval because it writes production history):**

1. Read-time: present such jobs as `expired` in job and document status displays. No write.
2. If approved, a one-time, per-row-audited transition of the three documented historical `running` jobs (see the production preparation audit) to `failed` with `error_message = 'expired: exceeded platform maximum duration'`.

There should be no bulk cleanup and no causation claim about why each run stopped. A heartbeat or lease column would be a schema change, scoped separately.
