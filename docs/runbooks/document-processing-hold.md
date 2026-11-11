# Document processing hold

Migration `20261111210000_document_processing_hold.sql`. Server module `lib/server/documentProcessingHold.ts`. Operator route `/api/internal/document-processing-hold`.

This is a durable, platform-wide stop for new document processing. It exists so that a maintenance window, the A1/A2 source-authority release first, can **hold → drain → verify** before migrating. It does not migrate, backfill or deploy anything.

**Status: not deployed.** Merging this PR to `main` applies the migration to production. The migration is additive and does **not** activate a hold: the default state is processing allowed.

## 1. What is fenced

| Entry point | Writes | Admission | DB fence for older builds |
|---|---|---|---|
| `POST /api/documents/process` (upload, reprocess, recovery reprocess) | job, blob, facts, canonical intelligence, sibling reruns (7b) | `documents_process`, before `processDocument` creates its job | job insert refused while held |
| `POST /api/documents/[id]/analyze` | job, then dispatches `/api/jobs/process` | `document_analyze`, before `createAnalysisJob` | job insert refused while held |
| `POST /api/jobs/process/[jobId]` | claims a queued job, blob, decisions | `job_process`, before any job, document or storage access | queued→running claim refused while held |
| `POST /api/documents/[id]/evaluate` | blob diagnostics, decisions, tasks, document status | `document_evaluate`, before canonical evaluation | **none**: it writes no job row |

Not fenced, by design:

- **Reads**, and **terminal status writes** (`completed`/`failed`): in-flight work must always be able to record its outcome.
- **Crons.** `forgewing-shadow-cleanup` and `workflow-assessment-sweep` write neither jobs nor extraction output.
- **`/api/admin/reset-stuck-documents`.** It only fails stuck jobs and documents; it is a drain tool.
- **Scripts.** `scripts/reprocess-*.ts` only write `documents.intelligence_trace` and run from an operator's machine, not the deployment.
- **Sources inside admitted work.** `after()` tasks (compliance shadow, Step 1 shadow) and `void triggerProjectValidation()` run inside an admitted request. The lease covers them; see §4.

## 2. Schema and API

- `document_processing_control`, a singleton:
  - `held`, `hold_version` (+1 on every applied transition), `held_since`, `admission_lease_seconds` (900; CHECK 900–3600), `last_transition_id`.
  - A missing row refuses all admission.
- `document_processing_hold_transitions`: append-only (UPDATE/DELETE/TRUNCATE refused). One row per operator request: `request_key` (unique), request digest, `action`, `outcome` (`applied` | `already_held` | `already_released`), actor id and email, reason, before/after state.
- `document_processing_admissions`:
  - One row per admitted request: `entry_point`, organization, document, `job_id` (job_process only), `admitted_hold_version`, `admitted_at`, `lease_expires_at`.
  - It can only be closed, once (`closed_at`, `outcome`). Its identity and lease are immutable, and rows are never deleted.
- `document_analysis_jobs.admission_id` / `claim_admission_id`: nullable, so rows written by older builds stay valid.
- Trigger `document_analysis_jobs_hold_fence`: while held, it refuses `INSERT` and any queued→running claim unless the row carries a live, open admission for the same document. SQLSTATE `55000`, detail `document_processing_hold_active` (or `…_unverified` when the control row is missing).
- Functions: `admit_document_processing`, `close_document_processing_admission`, `set_document_processing_hold`, `read_document_processing_hold_state`.
  - All are `SECURITY DEFINER`, executable by `service_role` only.
  - `anon` and `authenticated` cannot call them or read the tables; `service_role` can only `SELECT` them.

**Concurrency.** Admission and the job fence take a transaction-scoped advisory lock in shared mode; a transition takes it exclusive.
- Each admission therefore commits wholly before or wholly after a hold, and every admission of a hold version has `admitted_at < held_since`.
- Heavyweight lock queues are fair, so a burst of admissions cannot starve a hold. Row-level `FOR SHARE` / `FOR UPDATE` could: the first offline run measured a hold delayed behind 100 parallel admissions.

**Application behaviour.** A refused request returns `503` with a typed body, and nothing has been written:
- `code: DOCUMENT_PROCESSING_HELD`, plus `holdVersion`;
- or `DOCUMENT_PROCESSING_HOLD_UNVERIFIED`, when the hold state cannot be read: RPC missing, network failure, malformed reply. The request fails closed.

Both carry `message` and `error`. The upload itself still succeeds; the document stays `uploaded` and can be processed after release.

## 3. Operator procedure

Authority is the platform-operator allowlist: `INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS` / `_ROLES`.
- It fails closed when unconfigured.
- Organization admins are not operators.
- The actor comes from the session; the body is strict.

```http
GET  /api/internal/document-processing-hold
POST /api/internal/document-processing-hold
     {"action":"hold","requestKey":"<new uuid>","reason":"A1/A2 maintenance window"}
```

Retrying with the same `requestKey` and the same body replays the recorded result. The same key with a different body returns `409`.

1. **Hold.** `POST action=hold`. Confirm `GET` shows `held: true` and a new `hold_version`.
2. **Confirm refusal.** Any process request returns `503 DOCUMENT_PROCESSING_HELD`.
3. **Drain.** Poll `GET` until `drain_state` is `drained`. That requires all of:
   - `now ≥ held_since + admission_lease_seconds`, which bounds any request a pre-hold build started before the hold;
   - no admission whose lease is still running, closed or not, because a closed request's `after()` work may still be writing.

   `drain_not_before` says when the first condition is met.
4. **Inspect, don't trust, statuses.** These counts are evidence for a human. None of them proves activity or inactivity:
   - `jobs_queued` / `jobs_running` / `jobs_running_without_claim_admission`;
   - `admissions_abandoned`: open, lease expired, so the request died without closing.

   A queued job stays queued through the window. Resolve stale `running` jobs or `processing` documents explicitly (`/api/admin/reset-stuck-documents`), never by reprocessing during the window.
5. **Release.** Release is only ever explicit: `POST action=release`.
   - Nothing releases a hold on timeout, restart or failed deploy.
   - A failed deploy leaves the hold on: fix forward.

## 4. When the hold can be trusted

The hold's own guarantees hold from the moment the migration is applied. The **drain** is only as strong as the following assumptions.

1. **No pre-hold build is still serving.** A 5a7fb05 instance cannot create or claim a job while held, because the database refuses it. But its `evaluate` route writes the blob with no job row, so the database cannot see or stop it.

   Trust the hold only after Vercel serves the hold build exclusively: the promoted deployment, with no older deployment receiving traffic, plus one lease (15 min) for in-flight requests on the old deployment.

2. **No admitted work outlives its lease** (900 s). The processing routes export no `maxDuration`, so they run at the Vercel project's default. Before the window, confirm in Vercel that this default (and any per-route override) is below 900 s. The admission ledger tracks every admitted request by time, not by status. But the application has writers that are not bound to the request:
   - **`withStageTimeout`** (`lib/server/stageTimeout.ts`) abandons a timed-out stage without cancelling it: 120 s for the blob insert, 300 s for canonical persistence. Canonical persistence then keeps writing, including the blob diagnostics update, after the job was marked failed and the response was sent.
   - **`void triggerProjectValidation(...)`** is fire-and-forget. It runs outside `after()`, and writes Validator tables only.

   On Fluid Compute an instance can stay alive after the request, so these promises are not provably bounded by `maxDuration`. The hold does not fence `document_extractions` writes at the database, by design (no per-row checks). An orphan that survives its lease could write after `drained`. The offline gate demonstrates this (`18`).

Closing assumption 2 needs one of:
- a write-time fence on the guarded tables, keyed by admission (A1's publication RPC is the natural place);
- or cancellable stages (an `AbortSignal` threaded into each Supabase call) and no un-awaited writers.

## 5. Offline qualification

```bash
bash scripts/qualify-document-processing-hold.sh
```

Docker only. The script:
- creates disposable PostgreSQL 17 + three PostgREST v14.7 containers (instance A, instance B, and the pre-hold schema);
- replays every migration;
- runs `lib/server/documentProcessingHold.postgres.test.ts`;
- removes everything on exit.

It accepts no database URL.
