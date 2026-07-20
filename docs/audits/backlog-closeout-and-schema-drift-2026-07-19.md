# Backlog close-out and schema drift audit — 2026-07-19

Scope: closes the CS-6 … CS-24 backlog opened from
`full-system-audit-2026-07-08.md`, `overview-hang-and-suite-triage-2026-07-09.md`, and
`prod-first-load-decomposition-2026-07-15.md`. Records the canonical-source decisions made,
the schema drift discovered and remediated, and the corrections worth remembering.

---

## 1. Schema drift (CS-16 / CS-17)

### 1.1 The migration ledger is not the source of truth

The repo carries 63 migration files; the live `eightforge-os` database
(`jpzeckefppmiujwajgvk`) reported 40 applied entries, using **re-timestamped versions**
(e.g. `20260309181926`) that do not correspond to repo filenames. The migration history was
squashed or rewritten at some point.

**Consequence:** comparing ledgers produces false alarms. Drift must be established by
checking **schema state** (`information_schema`, `pg_indexes`, `pg_constraint`), not by
diffing migration lists. Most objects were in fact present — `intelligence_trace`,
`transaction_data_rows`, `execution_items`, `contract_upload_guidance`,
`decision_detections`, `documents.deleted_at`, and both `20260707` performance indexes all
verified live despite absent ledger entries.

### 1.2 Genuine drift found

Confined to two migrations that never reached the database:

| Migration | Objects missing in live |
|---|---|
| `20260430000000_document_truth_governance_phase` | `projects.validation_phase` (+ check, + index), `documents.document_subtype` (+ check, + index) |
| `20260323000000_document_precedence` | `documents.document_role`, `authority_status`, `effective_date`; all four precedence indexes; `operator_override_precedence` landed as `integer` rather than `boolean NOT NULL DEFAULT false` |

`precedence_rank` and `operator_override_precedence` existed only via
`missing_live_schema_baseline`, which is why partial inspection was initially misleading
(see §4.2).

### 1.3 Remediation applied

| Migration | Version | Result |
|---|---|---|
| `restore_projects_validation_phase_drift` | `20260718230645` | applied, verified |
| `restore_documents_precedence_columns_indexes_and_boolean_type` | `20260718230815` | applied, verified |
| `restore_documents_document_subtype_drift` | `20260719175737` | applied, verified |

All restored columns are nullable and start `NULL`, which is exactly what the
missing-column fallbacks already yielded downstream — the change is behaviour-preserving.
`operator_override_precedence` was cast with `USING (COALESCE(col, 0) <> 0)`; all 27 rows
were `NULL`, so every row resolved to `false` with no data loss.

Once parity was proven, the dead fallbacks were removed from
`useProjectWorkspaceData.ts`, `projectValidator.ts` and `triggerProjectValidation.ts`,
eliminating the measured ~476 ms (`validation_phase`) and ~855 ms (precedence) fallback
round-trips.

### 1.4 Do not replay historical migrations verbatim

`20260430000000` DROPs and re-ADDs `activity_events_event_type_check` with the event-type
list as of April. Later migrations expanded that list. Replaying it would have rejected
event types that are now valid and broken activity logging. The same hazard applies to
`document_relationships_relationship_type_check`.

**Rule:** when repairing drift, write a **scoped corrective migration** containing only the
missing objects. When a constraint must change, read the *current live* definition and
extend it additively. This rule was applied again in CS-11, where
`execution_items.status` was extended from `open | resolvable | resolved` to include
`superseded` without dropping any existing value.

---

## 2. Canonical-source decisions

### 2.1 `rate_row_count` (CS-9)

Canonical `facts.rate_row_count` derives from the **distinct persisted
`contract_analysis.rate_schedule_rows`**, recomputed in the same write as the rows so the
two cannot drift. The pipeline's `estimated_rate_row_count` is demoted to a diagnostic
qualification signal and must never be persisted as canonical truth. Duplicate `row_id`s
are collapsed only when identical; conflicting duplicates throw deterministically.

`rate_schedule_state` still keys off the estimate, so a document whose estimate is
non-zero but whose canonical assembly is empty remains `needs_review` rather than silently
passing. This is what makes a canonical count of `0` safe (see CS-9c below).

### 2.2 Invoice truth (CS-18 follow-up)

`invoices` / `invoice_lines` were a **persisted projection**, not an independent source.
The writer (`persistCanonicalInvoiceForDocument`) and the live reconstruction
(`synthesizeInvoicesFromLegacyExtractions`) both call
`buildCanonicalInvoiceRowsFromTypedFields`, and the reconstruction reads the live
`document_extractions` table. The projection was retired; invoice truth now flows solely
from `document_extractions` typed fields.

Parity was proven before removal: exposure summaries and full approval-gate outputs are
deep-equal for populated-projection vs synthesis-only input.

### 2.3 Decision cards (CS-13)

The Overview decision-card list now derives from `resolveProjectIssueObjects` rather than
`model.decisions`, reusing the existing canonical projector. Parity covers count, ordering,
titles, statuses, record IDs, evidence refs, provenance labels and `open`/`in_review`
filtering.

`operationsQuery` / `askOperationsChips` were deliberately **not** migrated:
`OperationalQueueModel.decisions` unions persisted decisions, trace decisions and execution
items behind portfolio-only fields, so it is a different aggregate, not the same truth.
Tracked in `cs-13-operations-query-follow-up-2026-07-19.md`.

### 2.4 Execution-item supersession (CS-11)

Execution items previously carried no run-generation linkage, so a resolved item from an
earlier validation run matched by `source_key` against a re-opened finding. Supersession is
now explicit: `status='superseded'` plus `superseded_by_run_id` referencing
`project_validation_runs(id) ON DELETE RESTRICT`, with a partial unique index on the active
source key so a new open row can coexist with its superseded ancestor.

**The backfill deliberately changed zero rows.** The 352 legacy resolved rows cannot
identify their causative run; writing a `superseded_by_run_id` would have manufactured
provenance — audit-shaped data that is actually a guess. Supersession applies only where
the causative run is genuinely known.

---

## 3. Verification posture

- `full-vitest.yml` runs the whole suite on push/PR with an **explicit, commented
  quarantine array**. Quarantine is now **empty**; the suite passes at 151 files / 1,311
  tests.
- A `tsc --noEmit` type gate runs before the suite. It has no quarantine. This was added
  because a type regression drifted unnoticed while only test lanes were enforced.
- Five mocked-import test files that were hitting 5 s timeouts were fixed at the root cause
  (warming Vitest's transformed module graph in `beforeAll`, then `vi.resetModules()`), not
  by raising timeouts.

---

## 4. Corrections worth remembering

### 4.1 A static search missing a value is not evidence of absence (CS-10)

`full-system-audit-2026-07-08.md` (M2) reported the `0.65` `needs_review` gate as missing.
It was present and active the whole time, at two sites in
`lib/contracts/exhibitARateTableRows.ts`, as an inline literal. It is now named
`RATE_OCR_NEEDS_REVIEW_THRESHOLD` so it is greppable. Note that not every `0.65` in the
codebase is this gate — `ocrGeometryLayout.ts` and
`canonicalOperationalTableRowAssembler.ts` use unrelated `0.65` ratios and must not be
folded into the same constant.

### 4.2 Verify every column before declaring a fallback dead

The precedence fallback was initially assessed as dead because `precedence_rank` and
`operator_override_precedence` existed. Three further columns
(`document_role`, `authority_status`, `effective_date`) were absent, so the fallback was in
fact **load-bearing**. The error surfaced only when a migration failed with
`column "document_role" does not exist`.

**Rule:** a compatibility fallback is dead only when *every* column it guards is verified
present.

### 4.3 A green gate that was never run is worse than a red one

`tsc --noEmit` was reported passing on a commit that in fact introduced a TS18047 error in
`lib/validator/exposure.test.ts`. The error also revealed a vacuous assertion: the invoice
parity test compared two possibly-null summaries, so `deepEqual(null, null)` would have
passed. Both are fixed, and the type gate is now enforced in CI (§3).

---

## 5. Follow-up dispositions

### 5.1 `document_subtype` — activated (operator-driven)

`document_subtype` is now selected by both precedence selects and flows into workspace,
precedence resolution, project facts, validator categorization and related-document
intelligence. The write path is operator-driven and already existed:

```
PATCH /api/projects/:id/document-precedence
  → validate against DOCUMENT_SUBTYPE_VALUES
  → scoped update
  → document_subtype_updated event
  → precedence reload → validator refresh
```

No extraction/classification writer exists, and none was invented — automatic population
would require new inference. Null-subtype and `document_role` semantics are unchanged.

The legacy precedence select/retry path was removed. It was reachable only on a
missing-column `42703`; now that every column it guarded is restored (§1.3), retaining it
would **mask** future schema drift rather than protect against it. This is the direct
corollary of the rule in §4.2.

**Still open:** whether to add automatic subtype classification and/or a backfill, and
whether to build operator-facing UI for it.

### 5.2 Activity-event delivery — explicit best-effort

Resolved as **explicit, observable best-effort delivery**. Every failure — returned insert
errors, missing configuration, and thrown client/network errors — now returns a structured
`ACTIVITY_EVENT_DELIVERY_FAILED` diagnostic, emitted centrally with organization, project,
entity, event type and error. Non-fatal user-route behaviour, event payloads and database
constraints are unchanged.

The audit-critical mutation list is now documented in
`activity-event-delivery-semantics.md`, covering decision/workflow lifecycle, document truth
and deletion, project archive/validation-phase/precedence/relationships/subtype, execution
creation/outcome/supersession, manual rate-link closure, validation request/completion, and
validator approval-decision sync.

**Known limitation:** this makes event loss *observable*, not *impossible*. That is
acceptable while the mutating row remains the system of record — CS-11 supersession, for
example, is durable in the row (`status` + `superseded_by_run_id`), so the event is a
secondary notification. If any listed event ever becomes required to *reconstruct* history
for compliance rather than merely to observe it, that specific event must be upgraded to a
durable outbox/retry.

### 5.3 Portfolio operations-query migration — stopped, by design

Migration onto the unified issue-object path was attempted and **correctly halted**: parity
is not achievable against the current canonical model. No source code was changed.

| Consumer requirement | Issue-object gap |
|---|---|
| Invoice `review_status` | Not represented |
| Trace-decision rows | Resolver accepts no `intelligence_trace` input |
| Queue `kind` + canonical record ID | Not represented losslessly |
| Raw `open` / `in_review` status | Issue lifecycle semantics differ |
| Blocked state | Portfolio rules differ |
| Severity | Finding normalization can change raw critical severity |
| Detected timestamp / ordering | Resolver orders by lifecycle/exposure/creation |
| Suppression + deduplication | Portfolio-specific rules absent |
| Superseded execution filtering | Requires canonical CS-11 integration first |

Migrating regardless would have changed items, counts, ordering, severities, invoice-review
signals, chips and superseded-generation visibility. This is why the work was scoped with an
explicit "stop and report rather than half-migrate" instruction.

**Owner decisions required before this can proceed:**

1. Land/rebase CS-11 into the portfolio branch.
2. Define a canonical trace-decision issue representation.
3. Define a canonical portfolio projection carrying queue IDs, kind, raw/review status,
   blocked semantics, timestamps, deduplication and suppression rules.
4. Decide whether bare findings and unmatched non-Pipeline-B decisions belong in the
   portfolio queue.

Detail: `cs-13-operations-query-follow-up-2026-07-19.md`.
