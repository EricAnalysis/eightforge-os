# Document processing hold and write fence

Migrations:
- `20261105120000_document_processing_hold.sql`: control, audit, admissions, job fence.
- `20261105120100_document_processing_write_fence.sql`: protected-write fence, revoke, drain by writer authority.

Server modules:
- `lib/server/documentProcessingHold.ts`
- `lib/server/documentProcessingAdmissionContext.ts`

Operator route: `/api/internal/document-processing-hold`.

This is a durable, platform-wide stop for document processing. It lets a maintenance window, the A1/A2 source-authority release first, **hold → drain → verify** before migrating. It does not migrate, backfill or deploy anything.

**Status: not deployed.** Merging to `main` applies both migrations to production.
- They are additive and do **not** activate a hold: the default state is processing allowed.
- They add triggers to `document_extractions`. Each migration sets `lock_timeout = '10s'`; if that expires, the migration fails cleanly and can be re-run.

## 1. Writers and what is fenced

**Protected processing output:** `document_extractions` `INSERT` and `UPDATE`, which covers blob rows and normalized fact rows. That is the surface the A1/A2 guards protect. Its application writers are:

| Writer | Reached from | Under admission |
|---|---|---|
| Blob insert (`processDocument`) | `documents/process` | `documents_process` |
| Fact supersede + insert (`upsertManyExtractionFacts`) | `processDocument` (normalization) | `documents_process` |
| Blob diagnostics update (`intelligencePersistence`, canonical persistence) | `processDocument`; 7b project reruns; `evaluate` | the caller's admission; each 7b sibling gets its own `project_rerun` admission |
| Blob insert (`jobs/process`) | `analyze` → `jobs/process`, or direct dispatch | `job_process` (claim admission) |

The admission travels with the work through AsyncLocalStorage, so it also covers `after()` tasks, stages abandoned by `withStageTimeout`, and fire-and-forget calls.

**Job fence** (migration 1): job creation and queued→running claims, as before.

**Permitted terminal bookkeeping**, never fenced: job `completed`/`failed` updates, document status updates, and `reset-stuck-documents`.

**Unrelated, not fenced:**
- Validator writes, because `triggerProjectValidation` only *reads* extractions.
- Compliance and Step 1 shadow RPCs, which write shadow tables.
- Decisions, tasks and activity events.
- Document edits and deletes. `DELETE` on `document_extractions` is not fenced: the app never deletes extraction rows, and document deletion cascades.

**Direct database sessions** have no PostgREST request context: migrations, backfills, the SQL editor. They are not application writes and are not fenced.
- Every application write reaches the database through PostgREST.
- The only direct-driver code in the repository is the offline Phase 17 evaluation runners, which never touch `document_extractions`.

## 2. The write fence

A row trigger on `document_extractions` checks every application write. A deferred constraint trigger checks it again at commit.

| Request | While not held | While held |
|---|---|---|
| No admission header (5a7fb05, browser, any unadmitted path) | allowed | refused `held_unadmitted` |
| Header names an admission that is: unknown / malformed | refused | refused |
| … presented by any role other than `service_role` (e.g. a browser that read an id from `document_analysis_jobs`) | refused `admission_role_mismatch` | refused |
| … for another document; a row with no document | refused | refused |
| … insert for another or no organization; update that changes the row's organization | refused | refused |
| … closed / revoked / expired | refused | refused |
| … superseded by a newer **source-processing** admission for the document | refused | refused |
| … open, in lease, not superseded | allowed | allowed (in-flight work) |

- **Database authority.** The header (`x-eightforge-processing-admission`) only names the admission. The database decides validity from the admission row, whose identity, sequence and lease are immutable. A caller cannot supply or extend a lease, and the service role cannot write the admission table.
- **Supersession follows lineage.**
  - Only a newer *source-processing* admission (`documents_process`, `document_analyze`, `job_process`) makes older admissions for the same document stale.
  - Derived refreshes (`document_evaluate`, `project_rerun`) never supersede anything. They read existing output, so a sibling's 7b rerun or a user's evaluate can't knock out the run producing new output.
- **Legacy rows.** Rows with no organization can still be updated inside the admitted document, but an admitted write can never move a row to another document or tenant.
- **Commit-time recheck.** A transaction that wrote under a valid admission cannot commit after that admission expires, is closed, revoked or superseded. The deferred check runs at commit and aborts the whole transaction.
- **Lock order.** Each check holds the shared hold advisory lock until commit. Hold, revoke and (while held) the drain read take it exclusively, so they are ordered after every in-flight protected write.
  - Polling the state while not held takes no exclusive lock.
  - Hold, revoke and the drain read give up after `lock_timeout = 5s` with `55P03`. The route returns `503 hold_lock_busy` and nothing changes; retry. This bounds how long they, and the admissions queued behind them, can wait on a long in-flight write.
- **Observable refusals.** SQLSTATE `55000`, detail `document_processing_write_fenced:<reason>`.
  - The admission transport records each refusal.
  - `processDocument` refuses to mark a fenced run `completed`; it fails the job.
  - `evaluate` returns `409 DOCUMENT_PROCESSING_WRITE_FENCED` without marking the document failed.
- **Fact writes are not atomic.** The fact writer supersedes and inserts in two requests, which predates this change. A refusal between them leaves the old facts superseded and no new ones, but the job is failed, not completed. A2's R1 makes this atomic.

## 3. Drain semantics

`drain_state = drained` ⇔ the control is held **and** no admission is write-valid (open, with its lease running).

Why that proves no pre-hold attempt can still commit a protected write:
- An unadmitted application write is refused while held, whatever build sends it.
- An admitted write needs an open admission with a running lease. Nothing in the database can create one while held (admission is refused), reopen one (closing is one-way), or extend one (leases are immutable).
- The drain read takes the exclusive hold lock. Every protected write that already passed its checks has committed, and is visible, before the read. Every later one re-checks and is refused.
- So `drained` is stable until release.

It is not defined by job status, lease arithmetic, request counts, or elapsed time.

## 4. Operator procedure

Authority is the platform-operator allowlist: `INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS` / `_ROLES`.
- It fails closed when unconfigured.
- Organization admins are not operators.
- The actor comes from the session.

```http
GET  /api/internal/document-processing-hold
POST /api/internal/document-processing-hold
     {"action":"hold" | "release" | "revoke","requestKey":"<new uuid>","reason":"..."}
```

Every POST is audited. The same `requestKey` with the same body replays; with a different body it returns `409`.

1. **Hold.** `action=hold`. New processing returns `503 DOCUMENT_PROCESSING_HELD`.
2. **Drain.** Either:
   - wait until in-flight requests close or their leases (15 min) expire; or
   - `action=revoke` (only while held, otherwise `409 not_held`), which closes every write-valid admission. In-flight requests then fail at their next protected write.
3. **Verify.** `GET` until `drain_state` is `drained`. The counts below are evidence only:
   - `admissions_write_valid`, `natural_drain_at`;
   - `admissions_abandoned`;
   - `jobs_queued` / `jobs_running`.

   Queued jobs stay queued.
4. **Migrate / backfill** with direct database sessions. They are not fenced.
5. **Release.** `action=release`. Nothing releases a hold implicitly; a failed deploy leaves it on.

## 5. Deployment prerequisites and limits

- **Header passthrough must be verified on the hosted gateway.** Confirm the Supabase API gateway forwards `x-eightforge-processing-admission` to PostgREST, on staging or a disposable branch project. If it were stripped:
  - safety holds: writes look unadmitted, so they are allowed only while not held, and refused while held;
  - but admitted in-flight work would fail as soon as a hold starts, so `revoke` would be the only way to drain cleanly.
- **PostgreSQL 16+.** The fence uses `pg_input_is_valid`. The write-fence migration asserts `server_version_num >= 160000` and fails before changing anything on an older server. Production was recorded as 17; confirm read-only before merge.
- **Lock waits are bounded.** Hold, revoke and the held drain read use `lock_timeout = 5s` (§2). Writers waiting behind them are therefore bounded by that plus the in-flight transaction.
- **Direct SQL is trusted.** A session that can run SQL can skip or pre-empt the fence:
  - `SET CONSTRAINTS ALL IMMEDIATE`;
  - `session_replication_role = replica`;
  - pre-seeding the `eightforge.write_fence_*` cache settings;
  - clearing `request.headers`.

  None of these is reachable through the PostgREST table API, and no RPC calls `set_config`.
- **Migration order.**
  - The two hold migrations are versioned `20261105120000` / `20261105120100`. That is above the production head (`20261104120000`, inferred) and below every pending stream: #305 `1106*`/`1107*`, FDE `1108*`, A1 `1109033515`, RPC `1109120000`, A2 `1110*`/`1111*`.
  - So the hold can merge **first** without re-stamping anything.
  - Rule: it must merge before any of those. Otherwise, re-stamp it just above the production head at merge time.
- **Build memory.** `npm run build` needs `NODE_OPTIONS=--max-old-space-size=8192` locally.

## 6. Offline qualification

```bash
bash scripts/qualify-document-processing-hold.sh
```

Docker only. The script:
- creates disposable PostgreSQL 17 + three PostgREST v14.7 containers;
- replays every migration;
- runs `lib/server/documentProcessingHold.postgres.test.ts`: the 20 hold scenarios, the W01–W16 write-fence races, and the B1/B3/B4/B5 regressions;
- removes everything on exit.

It accepts no database URL.
