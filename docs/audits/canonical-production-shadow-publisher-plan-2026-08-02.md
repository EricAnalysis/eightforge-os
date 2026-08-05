# Canonical Production Shadow Publisher — Architecture Review & Implementation Plan

- **Date:** 2026-08-02
- **Phase:** architecture review + implementation planning (no code written)
- **Reviewer routing:** `eightforge-code-reviewer` (primary) + `eightforge-truth-engine-reviewer` (companion).
  `eightforge-performance-reviewer` was additionally engaged because measured artifact
  size crosses a runtime boundary (§11). `eightforge-supabase-reviewer` was engaged only
  for the destination decision (§7/§10). No migration is proposed, so
  `eightforge-migration-reviewer` is out of scope. No authoritative history is written,
  so `eightforge-audit-reviewer` is advisory only.
- **Objective:** emit a canonical Project Truth artifact from genuine production pipeline
  outputs, automatically, on real project processing, while remaining strictly
  non-authoritative.

---

## 0. Amendment record (authoritative — review against this)

This plan was amended **after** architecture approval and **before** final implementation
review. The implementation must be reviewed against the amended contract below, not
against the original wording of §4–§19. Every amendment is reflected inline in its
section, marked `(amended)`.

| # | Amendment | Amends | Status |
|---|---|---|---|
| A1 | **Single pricing-assembly authority.** One pricing assembly execution occurs inside `projectValidator` through the coordinated dual-view API; its frozen selected result is retained on `ProjectValidatorInput.assembledContractPricingRows`. The publisher consumes that array and **never reassembles pricing**. | §4 row 4, §5.1, §14 | **authorized, implemented** |
| A2 | **Source identity is snapshotted, not re-queried.** A frozen `ProjectValidatorInput.sourceArtifactSnapshot` is captured during validator-input construction. The publisher performs **zero** reads of `documents` / `extraction_source_artifacts`; its only post-validation read is the persisted run row. | §4 row 21, §5.1, §12 guard 7, §14 | **authorized, implemented** |
| A3 | **Q1 answered — manual bucket provisioning.** `canonical-shadow-artifacts` is provisioned manually. Code never calls a bucket-creation API and performs no infrastructure mutation. A missing bucket is a normalized `missing_bucket` failure. | §7, §17 Q1 | **decided** |
| A4 | **Immutable, fail-closed idempotency.** Objects are written with `upsert: false`. A conflicting object at the same path is compared using trusted stored `comparisonDigest` metadata; missing or divergent metadata fails closed without downloading the object. A *different* `publicationId` under the same run prefix fails closed as `idempotency_conflict`, with no second publication or manifest. | §8 | **amended, implemented** |
| A5 | **Manifest-last, whole-publication fail-closed.** The manifest is the terminal write. A stage failure (`source_run`, `adaptation`, `destination`) aborts the publication and writes **no manifest**; it is logged with a normalized failure category. The original "write a `failed`/`partial` manifest on stage failure" behavior is withdrawn — a torn artifact set with an index is worse than absence plus a log line. | §9 | **amended, implemented** |
| A6 | **Deterministic `generatedAt`.** `generatedAt` is the run's `completed_at ?? run_at`, not wall-clock time, so the entire artifact set is reproducible from the run. It remains excluded from every hash. | §6.1, §8 | **amended, implemented** |
| A7 | **Run-identity freshness check is stricter.** The pre-write re-read requires both `status === 'complete'` **and** `inputs_snapshot_hash === input.inputsSnapshotHash`. | §8, §9 | **amended, implemented** |
| A8 | **`supersedes` is `null` in v1.** Computing it requires listing `project/{projectId}/run/`, which is a cross-run read the publisher no longer performs. The field is retained in the manifest schema and deferred. | §6.1, §8 | **deferred** |
| A9 | **Transaction chunking deferred.** v1 writes a single `registry.transactions.ndjson.gz` part. Multi-part `registry.transactions.{000n}.ndjson.gz` remains designed-for (per-part digests already exist in `sectionDigests`) but is not implemented; measured Golden gzip size is ~5 MB against a 50 MB object limit. | §11 | **deferred** |
| A10 | **Bounded stages recalibrated.** Budgets are: source-run read 5 s, destination (serialize + upload of all parts + manifest) 60 s, whole publication 90 s. Adaptation and parity are synchronous and bounded only by the 90 s ceiling. | §9 | **amended, implemented** |
| A11 | **A1 full-call-graph clarification and coordinated dual-view assembly.** A1 applies transitively across each complete validation execution, including contract intelligence, synthetic and human overrides, rule packs, and shadow publication. One assembly execution accepts explicitly role-scoped authoritative and structural-candidate groups. It constructs each source candidate once from the structural representation. The deterministic analyzer category fallback applies to selected-row category only when synthetic/human-review validation selects structural rows as authoritative input and native assembly categorization is absent; it is disabled for every persisted-authoritative path. Native candidate visibility is preserved. The same invocation performs filtering, deduplication, winner selection, and ordering. Candidate identities include document, immutable source version, source kind, input role, and stable row identity; duplicate identities fail visibly, and lookup distinguishes a known row with no visible candidate from an identity miss. `ProjectValidatorInput.assembledContractPricingRows` retains selected rows; contract intelligence consumes candidates; the publisher consumes selected retained rows only. Candidate rows are internal and non-authoritative. The legacy wrapper returns isolated mutable deep copies. `analyzeContractIntelligence` does not invoke an assembler. `documentPipeline` may invoke the dual-view API once for its independent execution. | §4 row 4, §5.1, §12, §14, §15, §18, §19 | **authorized** |
| A12 | **Intentional persisted-rate-row compatibility narrowing.** Before A11, whenever canonical pricing assembly selected no governing rows, every persisted rate row could enter `normalizeRateScheduleItem` as a compatibility governing-rate candidate regardless of category state. That fallback is now allowed only when all four supported aliases — `category`, `source_category`, `material_type`, and `canonical_category` — are absent, `null`, `undefined`, empty, or whitespace-only. Any nonblank alias disables compatibility fallback, including a valid alias and an invalid, unsupported, or unresolvable alias; any non-string, non-null alias value also disables it. Such a row cannot become a governing rate-schedule item merely through the legacy persisted fallback. Affected validation runs may change from matched or contract-supported to missing contract rate, `BLOCKED`, and at-risk exposure. This intentional governing-pricing boundary prevents malformed or unresolved persisted category data from silently bypassing canonical pricing assembly. It is independent from A11 structural-wins selection rescue. The publisher remains shadow-only; A12 governs authoritative validator-input behavior adjacent to the publisher slice. | §5.1, §15 | **authorized, implemented** |

| A13 | **Canonical Project Truth becomes selectable runtime authority.** `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=canonical` promotes the frozen in-memory canonical registry from non-authoritative shadow output to the governing truth for one validation execution. The authoritative object is the registry, never a published artifact; storage is never read back into validation. Authority and publication are independent controls. Canonical mode prohibits silent fallback to legacy truth: an unestablished canonical authority is an honest `blocked`/`failed` state. One execution has one frozen source snapshot and one canonical registry, reused by validator inputs, findings, exposure, clearance, persistence metadata, and publication. Default remains `legacy`, which is the emergency rollback. Full statement, scope limits, and operator procedure in §20. | §0, §4, §5.1, §14, §15 | **authorized, implemented; acceptance gate passing (see §20.3)** |
| A14 | **Canonical transaction, invoice, and document-relationship authority.** Canonical authority extends from pricing to transactions, invoices, invoice lines, and document-family/governing relationships, with a per-domain coverage model that makes "canonical governed this run" a checkable claim. A run may not report complete authority while any required domain is blocked. Ticket-grain conflicts are preserved as deterministic diagnostics, never arbitrated. Full statement in §21. | §0, §4, §5.1, §21 | **authorized, implemented; acceptance gate passing (see §21)** |
| A15 | **Non-serving legacy versus canonical authority comparison.** Both authority modes run over ONE frozen validation input; their outputs are normalized, deltas are classified conservatively, and an operator-reviewable report is emitted. The comparison is advisory: the canonical result is non-serving and no comparison outcome can become a serving validation result. Comparison is a third independent control (`EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE`), defaults to `off`, is cohort-scoped by explicit project allowlist, and its failure is non-blocking to the serving run. Automated classifications are candidates only; promotion requires operator disposition of every material delta, never parity alone. Comparison artifacts are audit evidence and are never read as validation authority. Recommended production configuration: `authority=legacy`, `comparison=on`. Full statement in §22. | §0, §22 | **authorized, implemented; acceptance gate passing (see §22)** |

Amendments A1, A2, A11, A12, A13, A14, and A15 change the **production** contract; A3–A10 change
only publisher-internal behavior. A1/A2 exist for the same reason: the publisher must not
become a second authority for pricing or for source identity, and must not re-read
mutable production state after the snapshot it is publishing was defined.

A11 clarifies rather than relaxes A1: “exactly once” covers the full validation call graph.
The candidate and selected views are coordinated outputs of that one execution, not two
pricing authorities. Candidate visibility exists only to preserve pre-selection contract-
intelligence and override semantics; it is never a publication or reader input. Selection
rescue is limited to the historical enriched structural-selection path and is not a general
persisted-data repair policy.

---

## 1. Current architecture

### 1.1 Production document path

`lib/pipeline/processDocument.ts` is the single document orchestrator:

1. load `documents` row (admin client, org-scoped)
2. `setDocumentStatus('processing')`
3. storage download + `captureStorageObjectVersion`
4. `extractDocument(...)` → `ExtractionPayload`
5. **`scheduleExtractionComplianceShadow(...)`** — existing non-authoritative shadow,
   detached, registered through `registerBackgroundTask`
6. optional AI enrichment
7. `document_extractions` insert (skipped for spreadsheet `transaction_data`)
8. `normalizeExtraction(...)`
9. `setDocumentStatus('extracted')`
10. `generateAndPersistCanonicalIntelligence(...)` (bounded 300 s)
11. project-context sibling rerun, activity event
12. `setDocumentStatus('decisioned')`
13. `void triggerProjectValidation(projectId, 'document_processed')` — fire-and-forget

### 1.2 Production validation path

13 call sites (`app/api/documents/[id]/facts/review`, `app/api/documents/[id]/review`,
`app/api/execution-items/[id]/outcome`, `app/api/jobs/process/[jobId]`,
`app/api/projects/[id]/revalidate`, `app/api/projects/[id]/validation-phase`,
`lib/pipeline/processDocument.ts`, `lib/validator/revalidationRequests.ts`) all funnel
into `triggerProjectValidation`, which debounces (in-flight window 30 s), skips unchanged
inputs by `inputs_snapshot_hash`, then calls exactly one function:

```
runValidationFlow(params)            lib/validator/triggerProjectValidation.ts:460
  ├─ reportValidatorFreshnessShadow  (shadow; after(); log-only; already precedent)
  ├─ validateProject(projectId)      lib/validator/projectValidator.ts:2513
  │    └─ loadValidatorInput(...)    → ProjectValidatorInput (whole project in memory)
  └─ persistValidationRun(...)       lib/validator/persistValidationRun.ts:1099
```

`persistValidationRun` is the authoritative write boundary: it inserts the run row,
persists/updates findings + evidence, resolves stale findings, `markRunComplete`,
`updateProjectValidationState`, then runs five non-core side effects through
`runValidationSideEffect` (execution items, validator decisions, activity event,
approval snapshot, approval actions) — each already wrapped so failure is logged and
non-fatal. It returns `{ runId }`.

### 1.3 Canonical foundation (complete, unread)

`lib/canonical/**` holds the typed domain: pricing (`pricing.ts`, `pricingAdapter.ts`,
`pricingResolution.ts`), invoice (`invoice.ts`, `invoiceLine.ts`, `invoiceAdapter.ts`),
transaction (`transaction.ts`, `transactionAdapter.ts`), reconciliation
(`pricingMatch.ts`, `invoiceTransaction.ts`, `projectReconciliation.ts`), validation
(`factImpact.ts`), truth envelope, and the registry
(`project/projectTruth.ts`, `project/projectTruthBuilder.ts`).

`buildCanonicalProjectTruth` is pure, deterministic, sorts every collection by stable id,
and stamps `construction: { mode: 'shadow_only', persisted: false }`.

Crucially, adapters already exist for **production-shaped** inputs, not only extraction
payloads:

| Adapter | Accepts |
|---|---|
| `adaptAssembledPricingRows` / `buildCanonicalPricingSchedule` | assembled contract pricing rows |
| `adaptCurrentInvoiceRows` | current effective Validator `InvoiceRow` / `InvoiceLineRow` |
| `adaptProjectTransactionRow` | persisted `transaction_data_rows` shape |
| `representCanonicalPricingMatch` | an already-made match (pure projection) |
| `mapValidationFindingToCanonicalFacts` | persisted `ValidationFinding` + evidence |

Verified: **no production module imports `@/lib/canonical/*` today.** The only hits are
inside `lib/canonical/**`, `lib/evaluation/**`, and the guard test itself.

### 1.4 Existing shadow precedents to reuse (do not reinvent)

- `scheduleExtractionComplianceShadow` — detached task, `settleWithin` bounded races,
  `console.error({ mode: 'shadow' })`, idempotency key `analysis-job:{jobId}`.
- `reportValidatorFreshnessShadow` — project-level, validation-run-scoped, registered via
  `after()` from `next/server` inside a `try/catch` (because `after()` throws outside a
  request scope), log-only.
- `state_projection_shadow_mismatches` — RLS enabled, `REVOKE ALL` from `anon` and
  `authenticated`, `GRANT INSERT` to `service_role` only. This is the correct
  authority-risk posture, though the table's shape is mismatch-specific and must not be
  repurposed as an artifact store.
- `lib/architecture/importBoundaries.test.ts` — already asserts
  "no production reader cutover to the shadow Project Truth registry."
- `lib/canonical/project/goldenShadowChain.test.ts` — keeps real Golden full-chain proof
  confined to `lib/evaluation/`.

### 1.5 Parity primitive already exists

`lib/evaluation/canonicalProjectTruthShadowHarness.ts` exports
`compareCanonicalShadowBoundary` / `buildCanonicalProjectTruthShadowComparison` with the
classification lattice (`exact_semantic_parity`, `represented_with_richer_typing`,
`represented_but_requires_review`, `not_yet_representable`, `current_source_unavailable`,
`conflicting_current_truth_path`). It is pure and has no evaluation-only dependency, but
it lives under `lib/evaluation/`. Production must not import `lib/evaluation` — see §12.

---

## 2. Candidate invocation points

### Candidate A — `processDocument` document completion
- **File / function:** `lib/pipeline/processDocument.ts` → `processDocument`, at step 12/13.
- **Runtime context:** Next.js Node route handler (`app/api/jobs/process/[jobId]`), Fluid Compute; `registerBackgroundTask` already available.
- **Inputs available:** one document's extraction payload, canonical intelligence result, project id, org id, analysis job id, source bytes + storage object version.
- **Outputs available:** document-scoped only.
- **Transaction boundary:** none; per-statement Supabase round trips.
- **Persistence boundary:** `document_extractions`, `documents.status`, canonical intelligence tables already committed at this point.
- **Retry behavior:** whole document reprocessed on job retry → repeated invocation.
- **Failure behavior:** shadow already proven non-fatal here (step 5 precedent).
- **Level:** document-level.
- **Project truth complete?** **No.** Sibling documents may be unprocessed, validation has not run, findings/exposure/reconciliation do not exist yet.
- **Duplicate publication risk:** high (one publication per document per reprocess).
- **Partial publication risk:** high (guaranteed incomplete project snapshot).
- **Stale publication risk:** high (last document to finish wins; ordering non-deterministic).
- **Verdict:** rejected. Structurally cannot publish a complete project snapshot.

### Candidate B — `runValidationFlow`, after `persistValidationRun` **(recommended)**
- **File / function:** `lib/validator/triggerProjectValidation.ts` → `runValidationFlow` (line 460).
- **Runtime context:** same Node request scope as the triggering handler; sometimes inside the detached `startBackgroundValidation` IIFE. `after()` already used here.
- **Inputs available:** `ProjectValidatorInput` (project row, documents, relationships, precedence families, governing document ids, facts, invoices, invoice lines, `invoiceLineToRateMap`, `manualRateLinkOverrides`, `transactionData.{datasets,rows,rollups}`, `reconciliationContext`, `contractValidationContext`, `projectTotals`, `factLookups`, `validationPhase`) plus `inputsSnapshotHash` and trigger source/entity.
- **Outputs available:** post-`persistValidationRun` effective `ValidatorResult` (derived status, blocked reasons, summary with `exposure`, all four reconciliation summaries, cross-document rate verification) and persisted findings **with database ids**, plus `runId`.
- **Transaction boundary:** none; authoritative writes already committed by `markRunComplete` + `updateProjectValidationState` before publication starts.
- **Persistence boundary:** publication happens strictly after every authoritative write.
- **Retry behavior:** debounced upstream (in-flight 30 s window + unchanged-hash skip). A genuine retry produces a *new* `runId`.
- **Failure behavior:** five sibling side effects already demonstrate log-and-continue.
- **Level:** validation-run-level (which is project-level, by construction).
- **Project truth complete?** **Yes** — this is the only point where contract pricing, invoices, invoice lines, transactions, selected matches, reconciliations, findings, and exposure coexist and agree.
- **Duplicate publication risk:** low, and fully removable by keying identity on `runId` + content hash (§8).
- **Partial publication risk:** low; sections that are genuinely absent are recorded in the gap ledger rather than omitted silently.
- **Stale publication risk:** low; `inputs_snapshot_hash` is already the repository's staleness fingerprint and is embedded in the manifest.
- **Cost:** requires two additive production signature changes (§5.1).

### Candidate C — explicit evaluation/diagnostic command
- **File / function:** new `scripts/evaluation/publishProjectTruthShadow.ts` (peer of `scripts/evaluation/runGoldenTransactionRowDrift.ts`).
- **Runtime context:** local/CI `npx tsx`, service-role credentials.
- **Inputs available:** whatever it re-loads via the exported `loadProjectValidatorInput`.
- **Outputs available:** must re-run `validateProject`, producing a *fresh* result that is not the persisted one.
- **Transaction/persistence boundary:** none; read-only against production tables.
- **Retry behavior:** operator-driven.
- **Failure behavior:** fully isolated by construction.
- **Level:** project-level, manual.
- **Project truth complete?** Yes, but as of *invocation time*, not as of any persisted run.
- **Duplicate / partial / stale risk:** duplicate low; partial low; **stale high** — the re-derived result can disagree with `project_validation_runs`, which is precisely the "conflicting current truth path" the parity report is supposed to detect, not manufacture.
- **Verdict:** does not satisfy "runs on real project processing." Keep as a *supplementary* backfill tool in a later slice, not the first publisher.

### Candidate D — background project-reconciliation job
- **File / function:** none exists. `vercel.json` declares no `crons`; there is no queue worker. `lib/server/operationalQueue.ts` and `executionQueue.ts` are decision/action queues, not artifact jobs.
- **Verdict:** rejected — requires a new orchestration framework, explicitly out of scope.

### Candidate E — inside `persistValidationRun` as a sixth `runValidationSideEffect`
- **File / function:** `lib/validator/persistValidationRun.ts`, after `executeApprovalActions`.
- **Attraction:** the failure-isolation wrapper, `runId`, effective result, and persisted findings are all in scope already; zero new signatures needed there.
- **Blocker:** `ProjectValidatorInput` is **not** in scope — `persistValidationRun` receives only `ValidatorResult`. Passing the full input into the authoritative persistence function widens its contract in the wrong direction and puts canonical concerns inside the authoritative writer.
- **Secondary blocker:** publication would run *inside* the awaited persistence call, extending the authoritative critical path even when it cannot fail it.
- **Verdict:** rejected in favour of B, but B **borrows** this file's `runValidationSideEffect` isolation shape.

---

## 3. Recommended invocation point

**Candidate B — `runValidationFlow`, immediately after `persistValidationRun` resolves,
executed inside `after()` so it runs post-response and never extends the authoritative
critical path.**

```ts
// lib/validator/triggerProjectValidation.ts  (recommended shape)
export async function runValidationFlow(params: {...}): Promise<void> {
  // ... existing freshness shadow, unchanged ...
  const { result, input } = await runProjectValidation(params.projectId);
  const persisted = await persistValidationRun(
    params.projectId, result, params.source, params.userId,
    params.inputsSnapshotHash, params.triggerEntity,
  );

  // Shadow only. Never awaited on the authoritative path. Never throws.
  scheduleCanonicalProjectTruthShadowPublication({
    projectId: params.projectId,
    runId: persisted.runId,
    triggerSource: params.source,
    inputsSnapshotHash: params.inputsSnapshotHash,
    validatorInput: input,
    effectiveResult: persisted.effectiveResult,
    persistedFindings: persisted.persistedFindings,
  });
}
```

`scheduleCanonicalProjectTruthShadowPublication` returns `void`, registers its own promise
with `after()` inside a `try/catch` (mirroring the freshness shadow), and swallows every
error. If the feature flag is off it returns before doing any work — including before
retaining any reference to `validatorInput`.

Rationale, stated as invariants:

1. It is the **only** point where a complete, internally consistent project snapshot
   exists. Every other boundary would publish a partial or re-derived snapshot.
2. Authoritative writes are already committed, so publication cannot influence them.
3. Both stale-run controls the repository already trusts (`inputs_snapshot_hash`,
   in-flight debounce) apply for free.
4. A single insertion point covers all 13 upstream triggers with no per-caller changes.
5. It reuses two existing, reviewed shadow patterns (`after()` + log-only shadow;
   `runValidationSideEffect` isolation) rather than adding a mechanism.

---

## 4. Publisher inputs and authority classifications

Legend — **PA** production authority (persisted authoritative record), **PC** production
compatibility (typed current output the publisher reads but does not own), **DCO** derived
current output (computed this run), **SO** shadow-only (invented by the publisher),
**UA** unavailable at this boundary.

| # | Input | Source (exact) | Class | Notes |
|---|---|---|---|---|
| 1 | project identity | `ProjectValidatorInput.project` (`ValidatorProjectRow`) | PA | org id, code, name; tenancy anchor |
| 2 | validation phase | `input.validationPhase` | PA | `projects.validation_phase` |
| 3 | governing contract documents | `input.documents`, `input.governingDocumentIds`, `input.precedenceFamilies`, `input.documentRelationships` | PA | maps to `CanonicalGoverningDocumentReference` incl. `relationship` + `effectiveAt` |
| 4 | assembled pricing rows **(amended — A1/A11/A12)** | `input.assembledContractPricingRows` — the frozen selected-row view from the single dual-view assembly execution inside `projectValidator`, retained on the validator input | PC | fed straight to validation selected-row consumers and to `adaptAssembledPricingRows` + `buildCanonicalPricingSchedule`. The same execution also produces an internal candidate view keyed by stable source-row identity for contract intelligence and override enrichment. Neither the publisher nor any downstream validation helper reassembles pricing; the publisher consumes selected retained rows only. A12 governs the separate persisted compatibility fallback used by validator rate-schedule normalization only when this selected-row view is empty. |
| 5 | rate-row evidence | `input.contractValidationContext.evidence_by_id` | PA | `Map<string, EvidenceObject>`; source of `CanonicalEvidenceRef` |
| 6 | authored-row quarantine | `authoredRateRowQuarantine` outputs already reflected in (4) | PC | must not be re-decided; record quarantine state as-is |
| 7 | invoice documents | `input.invoices` (`InvoiceRow[]`, post override/review scope resolution) | PC | `adaptCurrentInvoiceRows` |
| 8 | invoice lines | `input.invoiceLines` (`InvoiceLineRow[]`, effective, completed by `completeEffectiveInvoiceLineCanonicalFields`) | PC | same adapter |
| 9 | transaction dataset rows | `input.transactionData.rows` (`transaction_data_rows`, incl. `record_json`, `raw_row_json`) | PA | `adaptProjectTransactionRow`; **5,063 rows for Golden** |
| 10 | transaction datasets + rollups | `input.transactionData.datasets`, `.rollups` | PA | grain-integrity counts for the parity report |
| 11 | selected pricing matches | `input.invoiceLineToRateMap` (`Map<lineId, RateScheduleItem \| null>`) | DCO | the selection already made; `representCanonicalPricingMatch` projects it |
| 12 | manual rate links (human) | `input.manualRateLinkOverrides` | PA | operator-authored; `invoice_line_rate_links` |
| 13 | cross-document rate verification | `effectiveResult.summary.cross_document_rate_verification.validation_units` | DCO | carries `contract_match_source`, `manual_link_resolution`, `source_documents`, `source_rows` |
| 14 | contract↔invoice reconciliation | `effectiveResult.summary.contract_invoice_reconciliation` | DCO | |
| 15 | invoice↔transaction reconciliation | `effectiveResult.summary.invoice_transaction_reconciliation` | DCO | |
| 16 | project reconciliation | `effectiveResult.summary.reconciliation` | DCO | |
| 17 | reconciliation billing groups | `input.reconciliationContext` (`ValidatorBillingGroup[]` with contract items, invoice lines, transaction rows, rate/invoice groups) | DCO | the join evidence behind 13–16 |
| 18 | current findings | `persistValidationRun` persisted findings (with DB ids + evidence) | PA | `mapValidationFindingToCanonicalFacts` |
| 19 | current exposure | `effectiveResult.summary.exposure` (`ProjectExposureSummary` + per-invoice) | DCO | → `CanonicalExposureReference` (`sourceKind: 'exposure_summary'`) |
| 20 | validator/readiness summary | `effectiveResult.summary` (`validator_status`, blockers, open items, `nte_amount`, `total_billed`) | DCO | → `CanonicalExposureReference` (`validator_summary` / `readiness_summary`) |
| 21 | source evidence + hashes **(amended — A2)** | `input.sourceArtifactSnapshot` — frozen during validator-input construction from `documents` + `extraction_source_artifacts`, carrying `documentId`, `documentType`, `documentRole`, `storagePath`, `sourceArtifactId`, `sourceSha256`, `storageObjectVersion`, `mediaTypeSniffed`, `byteLength`, `artifactCreatedAt`, `exactSourceIdentity` | PA | The publisher performs **no** post-validation query against `documents` or `extraction_source_artifacts`. `exactSourceIdentity` is non-null only when artifact id **and** `source_sha256` **and** `storage_object_version` are all present; otherwise the entry yields a deterministic gap (`boundary: 'manifest'`, `reason: 'source_unavailable'`, `rejectingFunction: 'bindPublicationSourceDocuments'`) naming the missing fields, and validation still succeeds. Different storage versions or source hashes therefore produce different exact identities and different publication identities. |
| 22 | human reviews / overrides | `document_fact_reviews`, `document_fact_overrides` already collapsed into `input.allFacts` via `collapseEffectiveFactRecords` | PA | present as *effective* facts, not as discrete review events |
| 23 | run identity | `runId`, `run_at`, `inputs_snapshot_hash`, `triggered_by`, `triggered_by_user_id`, `rule_version` | PA | `project_validation_runs` |
| 24 | pipeline version | `process.env.VERCEL_GIT_COMMIT_SHA` ?? `EIGHTFORGE_BUILD_DIGEST` | PC | may be null locally → gap ledger entry |
| 25 | discrete review-event history per fact | — | UA | only the collapsed effective value reaches the validator; record as a gap, do not reconstruct |
| 26 | pre-assembly raw contract rate rows | — | UA | validator sees persisted trace + assembly output only |
| 27 | approvals / decisions / execution items | — | UA at this boundary (written by sibling side effects *after* our snapshot is defined) | deliberately excluded from v1; see §16 |
| 28 | publication manifest, gap ledger, parity report | publisher | SO | |

**Explicitly forbidden input:** `lib/projectFacts.ts`. Confirmed to be a projection over
`@/types/validator` + `@/lib/contracts/types` that re-derives precedence and readiness for
project-facing surfaces. It is downstream of everything in this table and must never
appear in a publisher import.

### 4.1 Availability caveat that must be honoured

`validateProject` **short-circuits** when required-source rules block
(`projectValidator.ts:2536`): identity, reconciliation, cross-document, financial, and
ticket packs never run, so items 13–17 are `null` and `rulesApplied` is short. Individual
packs may also fail and record `${pack.id}:failed`. The publisher must read
`effectiveResult.rulesApplied`, classify each unexecuted boundary as
`current_source_unavailable` (not `not_yet_representable`), and write a gap ledger entry
naming the pack. It must not treat "the pack did not run" as "the canonical model cannot
represent it."

---

## 5. Canonical adaptation boundary

### 5.1 Retained-input and signature changes — **amended (A1, A2, A11, A12)**

The approved slice modifies seven existing production files and adds ten production source
files under `lib/canonical/parity/` and `lib/canonical/publication/`; §14 is the complete
inventory. This subsection describes the retained-input and signature portion of that
production diff. `ProjectValidatorInput` gains two frozen retained fields, populated on the
authoritative path, so that the publisher is a pure consumer of an already-defined snapshot.

**(0) `lib/validator/shared.ts` + `lib/validator/projectValidator.ts`** — retained input:

```ts
export type ValidatorSourceArtifactSnapshotEntry = {
  readonly documentId: string;
  readonly documentType: string | null;
  readonly documentRole: string | null;
  readonly storagePath: string | null;
  readonly sourceArtifactId: string | null;
  readonly sourceSha256: string | null;
  readonly storageObjectVersion: string | null;
  readonly mediaTypeSniffed: string | null;
  readonly byteLength: number | null;
  readonly artifactCreatedAt: string | null;
  readonly exactSourceIdentity: string | null;
};

export type ProjectValidatorInput = {
  // ... existing fields unchanged ...
  assembledContractPricingRows: readonly ContractPricingAssemblyRow[]; // A1
  sourceArtifactSnapshot: readonly ValidatorSourceArtifactSnapshotEntry[]; // A2
};
```

Both arrays and their entries are frozen. `assembledContractPricingRows` is the *same*
object the rule packs validated against — not a re-derivation. `sourceArtifactSnapshot` is
captured during validator-input construction, so post-validation mutation of `documents`
or `extraction_source_artifacts` cannot retroactively change what a publication claims its
sources were.

Both fields are populated unconditionally, independent of the feature flag: they are
validator-input completeness, not publisher plumbing, and every existing validator fixture
must supply them.

**A11 coordinated-view clarification.** The validation input's
`assembledContractPricingRows` remains the selected, frozen operator-facing view. The
validation construction path calls the dual-view assembler exactly once. The governing
pricing branch policy is:

| Path | Authoritative selected-row input | Selection rescue |
|---|---|---|
| Persisted context, no override | persisted rows | disabled |
| Synthetic/human review, structural wins | structural rows | enabled |
| Synthetic/human review, persisted wins | persisted rows | disabled |
| Project-summary persisted | persisted rows | disabled |

When a richer persisted schedule wins in the synthetic/human-review path, structural rows
enter the separate `structural_candidate` group. Otherwise structural rows are the
`authoritative_rate_schedule` group. The deterministic pre-assembly category resolver
supplies the effective category rescue only for the latter branch, preserving the former
enriched-then-selected structural path when native candidate construction cannot resolve a
category. It is not a persisted-data repair policy: unresolved persisted categories remain
unchanged and cannot become governing rates through this fallback. Candidate construction
uses native structural evidence, while the selected-category override is only a
deterministic selection fallback. Candidate construction, authored correction, filtering,
deduplication, winner selection, and ordering still occur once inside that invocation, so
the fallback is not a second selection authority. Candidate visibility follows the native
structural category and therefore preserves contract intelligence's pre-selection view. No
production output is intentionally expanded beyond pre-refactor behavior.

**A12 persisted-compatibility clarification.** Selection rescue and persisted compatibility
fallback are separate controls. Selection rescue is the A11 structural-wins mechanism used
inside canonical contract-pricing assembly to supply a selected-row category when native
assembly categorization is absent. Persisted compatibility fallback is a secondary legacy
validator path considered only after canonical assembly produces no selected rows. Success
or failure in either control does not authorize the other, and the compatibility path is not
a second canonical pricing authority.

Before A11, no selected assembly rows meant every persisted rate row could fall through to
`normalizeRateScheduleItem`, regardless of category state. A12 intentionally narrows that
governing-pricing behavior to rows where each of `category`, `source_category`,
`material_type`, and `canonical_category` is absent, `null`, `undefined`, empty, or
whitespace-only:

| Canonical assembly result | Persisted alias state | Compatibility fallback |
|---|---|---|
| Selected rows exist | Any | Disabled |
| No selected rows | All four aliases absent or blank | Allowed |
| No selected rows | Any alias nonblank and valid | Disabled |
| No selected rows | Any alias nonblank but invalid or unresolvable | Disabled |

The final row is the A12 behavior change: invalid, unsupported, or unresolvable nonblank
category data no longer becomes a governing rate merely because canonical assembly rejected
it. The same prohibition applies to any other nonblank alias and to every non-string,
non-null alias value. Affected runs may therefore
move from matched or contract-supported results to missing contract rate, `BLOCKED`, and
at-risk exposure. This prevents malformed or unresolved persisted data from silently
bypassing canonical assembly; it does not change publisher behavior or the publisher's
shadow-only authority posture.

Each candidate key contains document id, immutable source-version identity, source kind,
input role, and stable row identity (row id, source anchors plus page, or a coordinated
role-scoped ordinal plus geometry). A duplicate key within one role throws a typed,
deterministic collision error containing no raw row content. Consumer lookup distinguishes
`no_visible_candidate` from `identity_miss`; identity misses fail visibly and never invoke
another assembly. Contract intelligence does not import or invoke an assembler, candidates
are not reconstructed from selected rows, and the candidate view is not added to publisher
input or exposed to a production reader. The compatibility wrapper returns mutable deep
copies, while the coordinated result and its nested authoritative values remain frozen.
The named end-to-end regression proofs in
`lib/validator/projectValidator.categoryRescueParity.test.ts` are (1) the structural-wins
rescued row and (2) the persisted-wins unresolved row that remains dropped. The synthetic
and human-review fixtures in `lib/validator/projectValidator.retainedInput.test.ts` retain
the broader single-assembly compatibility proof.

**(a) `lib/validator/projectValidator.ts`** — expose the input alongside the result
without changing existing behavior:

```ts
export async function runProjectValidation(
  projectId: string,
): Promise<{ result: ValidatorResult; input: ProjectValidatorInput }> { /* current body */ }

export async function validateProject(projectId: string): Promise<ValidatorResult> {
  return (await runProjectValidation(projectId)).result;
}
```

No callback into validator internals, no re-entrancy, no re-load. `validateProject`'s
signature and semantics are unchanged for every existing consumer.

**(b) `lib/validator/persistValidationRun.ts`** — widen the return type additively:

```ts
): Promise<{
  runId: string;
  effectiveResult: ValidatorResult;                       // added
  persistedFindings: readonly PersistableValidationFinding[]; // added
}>
```

`effectivePersistedFindings` and `effectiveResult` are already computed locally
(lines 1206–1215); this only stops discarding them. Sole production caller is
`runValidationFlow`, so blast radius is one file.

All three changes are behavior-preserving and independently testable. Nothing else in the
production tree changes except the single `scheduleCanonicalProjectTruthShadowPublication`
call in `runValidationFlow` and the guard-test extension. Validator fixtures across the
rule-pack and boundary tests must be widened for the two new required input fields; that
fixture churn is expected and is not a behavior change.

### 5.2 Adaptation rules (non-negotiable)

1. **Adapters project, they never decide.** No re-matching, re-normalization, re-pricing,
   re-quarantining, or re-classification. If the current path selected a rate,
   `representCanonicalPricingMatch` records *that* selection and its
   `sourceMatcher`/`sourceMatchStatus`.
2. **Grain rules preserved.** Ticket-grain quantities (CYD, mileage, diameter, tonnage,
   ticket count) come from `transactionData.datasets` / `.rollups` ticket-grain totals.
   Row/invoice-grain amounts (extended cost, billed amount) come from row and invoice
   sources. The publisher never sums transaction rows to derive a ticket-grain quantity
   and never dedupes tickets itself. Conflicting repeated ticket rows become a gap ledger
   entry, never a silent pick.
3. **No fabrication.** An absent field yields a `TruthEnvelope` with `value: null` and a
   machine-readable `stateReason`, plus a gap entry — never a default.
4. **Evidence preserved verbatim.** `observedRaw` / `rawSpan` are never cleaned.
5. **Determinism.** `buildCanonicalProjectTruth` already sorts every collection by stable
   id. All publisher-side maps must be converted to arrays through explicit sorts. No
   `Date.now()`, `Math.random()`, `Object.keys` ordering, or locale-default `sort()`
   anywhere in registry construction. Run metadata (§6.1 fields 6, 12) is the only
   non-deterministic content, and is confined to the manifest.
6. **Relocate the parity comparator, do not import `lib/evaluation` from production.**
   Move `compareCanonicalShadowBoundary` / `buildCanonicalProjectTruthShadowComparison`
   verbatim to `lib/canonical/parity/shadowComparison.ts`, and have
   `lib/evaluation/canonicalProjectTruthShadowHarness.ts` re-export from the new home so
   `canonicalProjectTruthShadowHarness.test.ts` and the Golden harness keep passing
   unchanged. This is a pure move: no logic edit.

---

## 6. Artifact structure

One logical artifact, physically split so that no single value is ever fully materialized
in memory (see §11).

```
project/{projectId}/run/{runId}/{contentHash}/
  manifest.json                  # small, human-readable, the index
  registry.core.json.gz          # documents, pricing, invoices, invoice lines, derived
  registry.transactions.ndjson.gz# one CanonicalTransaction per line
  parity.json.gz                 # parity report
  gaps.ndjson.gz                 # gap / loss ledger, one entry per line
```

### 6.1 Publication manifest

| Field | Source |
|---|---|
| `publicationId` | deterministic content hash (§8) |
| `projectId` / `organizationId` | `input.project` |
| `sourceRun` | `{ runId, runAt, completedAt, triggeredBy, triggeredByUserId, ruleVersion, inputsSnapshotHash, rulesApplied }` |
| `sourceDocuments[]` | `{ documentId, documentType, family, isGoverning, storagePath, sourceSha256, storageObjectVersion, processedAt }` |
| `pipelineVersion` | `VERCEL_GIT_COMMIT_SHA` ?? `EIGHTFORGE_BUILD_DIGEST` ?? `null` (+ gap if null) |
| `canonicalSchemaVersion` | `'canonical-project-truth-v1'` |
| `publicationSchemaVersion` | `'project-truth-shadow-publication-v1'` |
| `generatedAt` **(amended — A6)** | the run's `completed_at ?? run_at`, not wall-clock time, so the artifact set is reproducible from the run — **excluded from the content hash** |
| `inputCounts` | documents, governing documents, assembled pricing rows, invoices, invoice lines, transaction datasets, transaction rows, findings, validation units, billing groups |
| `outputCounts` | canonical pricing schedules/rows, invoices, invoice lines, transactions, pricing matches, reconciliations, validation impacts, exposure references, evidence refs |
| `status` | `complete` \| `partial` \| `failed` |
| `gapSummary` | counts by `boundary` × `reason`, plus `silentLossCount` (must be 0) |
| `parity` | per-boundary classification only (full detail in `parity.json.gz`) |
| `sectionDigests` | sha256 of each object part, so tampering/truncation is detectable |
| `supersedes` **(amended — A8)** | `null` in v1. Populating it requires a cross-run listing the publisher deliberately no longer performs; the field stays in the schema and the linkage is deferred to a consumer or a later slice |
| `nonAuthoritative` | literal `true` |
| `mode` | literal `'shadow_only'` |
| `persisted` | literal `false` (mirrors `construction.persisted`) |

### 6.2 Canonical Project Truth registry

Exactly `CanonicalProjectTruth` as produced by `buildCanonicalProjectTruth`, split for
serialization only: `transactions` streams to NDJSON, everything else
(`governingDocuments`, `contractTermReferences`, `contractPricing`, `invoices`,
`invoiceLines`, `derived.*`, `construction`) goes to `registry.core.json.gz` with
`transactions` replaced by `{ count, digest, part: 'registry.transactions.ndjson.gz' }`.
Round-tripping the two parts must reconstruct the exact registry — asserted by test.

### 6.3 Parity report

One entry per `CanonicalShadowComparisonBoundary` (`contract_pricing`, `invoice`,
`transaction`, `contract_invoice_reconciliation`, `invoice_transaction_reconciliation`,
`cross_document_rate_verification`, `findings`, `exposure`), each with the existing
`CanonicalShadowComparison` shape plus quantitative deltas:

- counts: current vs canonical, `missingCanonicalKeys`, `additionalCanonicalKeys`
- amounts: billed, contract-supported, transaction-supported, unreconciled, at-risk,
  requires-verification — current summary value vs canonical-derived value, with delta
- quantities: ticket-grain totals per dataset, current vs canonical
- selected matches: per invoice line, current selected rate item vs
  `pricingMatch.selectedPricingRowId`
- finding identities: `check_key` set difference between persisted findings and
  `validationImpacts`
- status classifications: `ValidationStatus`, `ValidatorStatus`,
  `ContractInvoiceReconciliationStatus` per boundary, current vs canonical

Comparison keys must be stable ids or typed semantic fingerprints — never formatted
display text (the existing contract).

### 6.4 Gap / loss ledger

Extend the existing `GoldenLossLedgerEntry` shape into a production type:

```ts
type ProjectTruthPublicationGap = {
  readonly gapKey: string;              // stable, deterministic
  readonly boundary: CanonicalShadowComparisonBoundary | 'manifest' | 'publication';
  readonly reason:
    | 'missing_field' | 'unresolved_mapping' | 'rejected_input' | 'lost_evidence'
    | 'unsupported_state' | 'source_unavailable'
    | 'pack_not_executed' | 'pack_failed' | 'publication_error';
  readonly sourceIdentity: string;
  readonly rejectingFunction: string | null;
  readonly detail: string;
  readonly rawValues: Readonly<Record<string, unknown>>;
  readonly sourceCoordinates: Readonly<Record<string, unknown>>;
  readonly evidenceSurvivesElsewhere: boolean;
  readonly canonicalRecoveryPossible: boolean;
  readonly silent: false;               // structurally: no gap may be silent
};
```

`silent: false` as a literal type is the enforcement: a loss that cannot be described
cannot be typed, so it must surface as a `publication_error` gap instead.

---

## 7. Publication destination

| Option | Authority risk | RLS / security | Retention | Discoverability | Size limit | Retry | Deploy complexity | Migration | Operator access | Prod failure coupling |
|---|---|---|---|---|---|---|---|---|---|---|
| Local/server filesystem | none | n/a | none — **ephemeral on Vercel** | none in prod | disk | n/a | none | no | none in prod | none |
| **Private Supabase Storage bucket (recommended)** | **very low** — outside `public` schema, no PostgREST surface, no FK to any authoritative row | private bucket, no `storage.objects` policies ⇒ `service_role` only; `anon`/`authenticated` cannot read | manual/lifecycle policy | manifest path is deterministic + one structured log line | 50 MB/object default (raise or chunk); gzipped parts are 1–5 MB | immutable `upsert: false` writes; trusted `comparisonDigest` metadata suppresses bounded duplicates and every missing/divergent-metadata case fails closed | low — bucket provisioned manually before flag enablement; missing/inaccessible bucket is an isolated destination failure | **no** | signed URL by an admin, or CLI | none (detached + bounded) |
| Object-storage diagnostic object (non-Supabase, e.g. Blob) | very low | separate credential surface | configurable | new console | large | idempotent | new env + provider | no | new console | none |
| Existing diagnostics storage (`extraction_*` compliance ledger) | **high** — it is the Step 0/1 compliance ledger with its own hashes and RPC contract; project-truth rows would corrupt its semantics | good | good | good | good | RPC-keyed | none | no | good | none |
| Dedicated Supabase shadow table | low if RLS mirrors `state_projection_shadow_mismatches` | strong precedent | good | best (SQL) | JSONB ~1 GB but 100+ MB rows are pathological; TOAST churn | unique natural key | **migration + review** | **yes** | best | none |
| Reuse `state_projection_shadow_mismatches` | **high** — repurposes a mismatch sink as an artifact store; text columns cannot hold a registry | good | good | poor | poor | unique key | none | no | poor | none |
| Structured application log | none | log retention ACL | short | poor | line-size truncation ⇒ **would truncate truth** | duplicates | none | no | poor | none |

**Recommendation (amended — A3):** a dedicated **private Supabase Storage bucket**
(`canonical-shadow-artifacts`), **provisioned manually as a deployment precondition**.
Runtime code contains no bucket-creation API call and performs no infrastructure mutation; a
missing bucket surfaces as a normalized `missing_bucket` publication failure and nothing
else. Objects are written with the service-role client, plus **one structured
`console.info` index line** per publication
(`{ mode: 'shadow', blocking: false, projectId, runId, publicationId, status, manifestPath, gapCount }`)
so an operator can find an artifact without listing the bucket.

Why not the shadow table in slice 1: it needs a migration and a migration review, and
§11's measurements show single-row storage of the registry is the wrong physical shape.
Storage keeps slice 1 migration-free while preserving the option to add a small
*index* table later (project_id, run_id, publication_id, content_hash, status, path) —
metadata only, never the registry body.

**Precondition — resolved (A3):** `canonical-shadow-artifacts` is provisioned **manually**
by an operator before the flag is enabled in any environment. No code path creates,
configures, or inspects the bucket's existence. This keeps the slice free of outward-facing
infrastructure mutation entirely, and makes "bucket missing" a diagnosable, contained
failure rather than a silent runtime provisioning event.

---

## 8. Identity and idempotency

```
registryContentHash = sha256( canonical-JSON(
  CanonicalProjectTruth with construction.sourceSnapshotId nulled
))                                                  # transactions hashed as an ordered
                                                    # stream of per-row digests
parityContentHash   = sha256( canonical-JSON(parityReport) )
gapContentHash      = sha256( canonical-JSON(gapLedger sorted by gapKey) )

projectSnapshotIdentity = sha256({
  projectId, inputsSnapshotHash, registryContentHash,
  canonicalSchemaVersion, pipelineVersion,
})

publicationId = sha256({
  publicationSchemaVersion, projectSnapshotIdentity,
  parityContentHash, gapContentHash, sourceRunIdentity,
})

sourceRunIdentity = `validation-run:${runId}`
idempotencyKey    = sourceRunIdentity
objectPrefix      = `project/${projectId}/run/${runId}/${publicationId}/`
```

- `generatedAt` is **not** in any hash. Timestamps never define identity (A6 makes it
  run-derived as well, so the whole artifact set is reproducible).
- **Retry semantics (amended — A4):** same `runId` + unchanged sources ⇒ identical
  `publicationId` ⇒ identical object path. Writes use **`upsert: false`**; on a conflict
  the publisher compares its expected digest with trusted stored `comparisonDigest`
  metadata. It does not download and fully buffer Golden-scale artifact objects for a byte
  comparison. Identical trusted metadata marks the part `duplicate`; all-parts-duplicate
  yields `duplicate_suppressed`. Missing or divergent comparison metadata fails closed at
  the immutable path, never overwrites, and never claims a full-object comparison it did not
  perform. Published objects are immutable by construction, not by convention.
- **Duplicate handling (amended — A4):** before writing, `list()` the run prefix. A
  *different* `publicationId` already present under the same `runId` **fails the
  publication closed** as `idempotency_conflict`; it writes no second artifact or manifest.
  Rationale: divergent canonical content for one
  authoritative run is a defect signal, and the correct response is to refuse to add a
  second competing artifact and to log loudly. A run prefix listing at or above the
  fail-closed limit (100 entries) is likewise an `idempotency_conflict`.
- **Stale-run handling (amended — A7):** the manifest carries `inputsSnapshotHash`. Before
  any write, the publisher re-reads the persisted run row (the *only* post-validation read
  it performs) and requires both `status === 'complete'` **and**
  `inputs_snapshot_hash === input.inputsSnapshotHash`. Either mismatch aborts the
  publication at stage `source_run` with nothing written and a normalized
  `source_unavailable` failure logged.
- **Partial-run handling:** `status: 'partial'` whenever the gap ledger is non-empty;
  `complete` only when it is empty. A publication with gaps is still written — the gaps
  are the diagnostic. `failed` is reserved for the manifest schema and is not written by
  v1, because a stage failure produces no manifest at all (A5).
- **Supersession (amended — A8):** `supersedes` is `null` in v1. Nothing is ever deleted or
  mutated; prior artifacts remain immutable, and the forward link can be derived by a
  consumer from run ordering.

---

## 9. Failure isolation

**Invariant:** a shadow publication failure must not change or fail the authoritative
production outcome — and must not be silent.

**Amended (A5): the manifest is the terminal write, and a stage failure publishes no
manifest.** The original "partial artifact plus a `failed` manifest" model is withdrawn:
an indexed but torn artifact set is more dangerous than absence, because the manifest is
the thing a future consumer would trust. Absence plus a structured, categorized log line
is the safer failure. Sections that are *representable but empty or unavailable* still
publish normally with gaps — that is a `partial` publication, not a failure.

| Failure | Required behavior (amended) |
|---|---|
| source data absent / unrepresentable at one boundary | `current_source_unavailable` parity classification + a gap; publication still written with `status: 'partial'` |
| a rule pack did not run or failed (§4.1) | gap `pack_not_executed` / `pack_failed` naming the pack; `status: 'partial'` |
| canonical adaptation or parity construction throws | abort at stage `adaptation`; **nothing written**, no manifest; one `console.error` with `errorCategory: 'adaptation_error'` |
| run snapshot unavailable, not `complete`, or hash-mismatched | abort at stage `source_run`; nothing written; `errorCategory: 'source_unavailable'` |
| serialization / streaming fails mid-part | the destination stage throws before the manifest is constructed; no manifest exists, so the partial section objects are unindexed and inert; `errorCategory: 'stream_error'` |
| destination fails (missing bucket, denied, upload error) | no manifest written; single `console.error({ mode: 'shadow', blocking: false, stage: 'destination', errorCategory, ... })`; **no retry inside the request** (a later validation run republishes naturally) |
| retry produces a duplicate | suppressed only when the content-addressed path has identical trusted `comparisonDigest` metadata; otherwise fail closed without an object download or overwrite (§8) |
| the same run yields a different `publicationId` | fail closed, `errorCategory: 'idempotency_conflict'`; no second artifact |
| source data changes during publication | the pre-write run re-read (status + `inputs_snapshot_hash`, A7) detects it; abort rather than publish a torn snapshot |
| project processing itself fails | `runValidationFlow` throws before the publisher is scheduled; nothing publishes; `startBackgroundValidation`'s existing catch logs |
| an unclassified defect escapes the publisher | the detached wrapper's last-resort `catch` normalizes and logs it; `after()` never sees a rejection |

Mechanics — all three layers required:

1. `scheduleCanonicalProjectTruthShadowPublication` is `void`-returning, wraps everything
   in `try/catch`, and registers with `after()` inside its own `try/catch` (`after()`
   throws outside a request scope — the freshness shadow already handles this).
2. Bounded stages **(amended — A10)**: source-run read 5 s, destination (all section
   uploads plus the terminal manifest) 60 s, whole publication 90 s hard ceiling.
   Adaptation and parity are synchronous CPU work bounded by the 90 s ceiling only. A
   timeout is normalized to `errorCategory: 'timeout'` and contained, never rethrown to
   the caller.
3. **Non-silence** is achieved three ways **(amended — A5)**, none of which is a production
   dependency:
   - a structured `console.info` line at publication start and at completion carrying
     `{ mode: 'shadow', blocking: false, status, gapCount, silentLossCount, durationMs,
     compressedByteCount, record counts }`, and a `console.error` line on every failure
     carrying `{ stage, errorCategory }` — ids, counts, hashes, and categories only, never
     field values;
   - a `partial` **manifest object** whenever the publication completes with gaps, so
     degraded truth is durable and self-describing. A *stage failure* deliberately leaves
     no manifest — the log line is the record;
   - the gap ledger, whose `silent: false` literal type makes an undescribable loss
     unrepresentable.

No alert, gate, health check, or status column consumes any of this in slice 1. Surfacing
is observation-only.

---

## 10. Security and tenancy

Artifacts **will** contain: contract pricing and rate schedules; invoice headers, lines,
and amounts; vendor and client names; full ticket/transaction rows including
`raw_row_json`; raw authored source spans (`observedRaw`, `rawSpan`); storage paths and
source hashes. `raw_row_json` for debris-hauling tickets can include driver names, truck
numbers, and monitor identities — treat it as potentially containing personal
information.

- **Tenancy:** every object path is prefixed by `projectId`, and the manifest carries
  `organizationId`. The publisher must assert `input.project.organization_id` is non-null
  and use it; a project without an org id is not published (gap:
  `unsupported_state`). No cross-project or cross-org aggregation object is created.
- **Access control:** private bucket, no `storage.objects` policies ⇒ reachable only by
  `service_role`. `anon` and `authenticated` cannot list or read. No signed URL is minted
  by the publisher, ever. Operator access is an explicit admin action outside this code.
- **Redaction:** none in slice 1 — redaction would destroy the evidence fidelity the
  artifact exists to prove, and the storage location is no less protected than the
  `documents` bucket the same bytes already live in. Because this is a judgment call
  rather than a safe default, it is listed as an open question (§17, Q3): if a future
  destination is *less* protected than the documents bucket, a `rawRowEvidence` /
  `rawSpan` redaction mode becomes mandatory before that move.
- **Diagnostic artifacts must not leave existing protected storage.** Same Supabase
  project, same service-role trust boundary. No third-party sink, no external log drain,
  no email/webhook.
- **Production logs are inappropriate for the artifact body.** Contract and ticket data
  must not be written to `console`. Logs carry only ids, counts, hashes, statuses, and
  paths — no field values, no raw spans. This is a review checklist item on every log
  statement the slice adds.

---

## 11. Runtime and performance

Measured, not estimated. `adaptProjectTransactionRow` was exercised against a
representative persisted row shape; per-transaction serialized size scales with the raw
workbook column count:

| raw columns | bytes / canonical transaction | × 5,063 rows (Golden) | gzip / row | gzip total |
|---|---|---|---|---|
| 13 | 25.1 KB | **124 MB** | 198 B | 1.0 MB |
| 25 | 37.7 KB | **186 MB** | 755 B | 3.6 MB |
| 35 | 48.2 KB | **238 MB** | 868 B | 4.2 MB |
| 50 | 64.0 KB | **316 MB** | 1.04 KB | 5.0 MB |

**Root cause of the amplification (new finding).** `buildCanonicalTransaction` stringifies
the *entire raw row* into `CanonicalEvidenceRef.rawSpan` and stores that ref twice per
field (`governingSource` **and** `supportingEvidence[0]`). With ~12 `TruthEnvelope` fields
that is ~24 copies of the raw row per transaction — O(fields × rowWidth) growth. Each
envelope alone measures ~1.3 KB.

This is pre-existing canonical-domain behavior, not something the publisher introduces —
but the publisher is the first consumer to serialize it at project scale, so it is
load-bearing here.

Consequences and required design:

- **Never `JSON.stringify` the whole registry.** A 124–316 MB string plus V8 overhead will
  exhaust a Fluid Compute function well before the 300 s timeout.
- **Transactions stream as gzipped NDJSON**, one `CanonicalTransaction` per line, adapted
  and written incrementally through `zlib.createGzip()` piped to the upload. Peak
  additional memory is one row (~64 KB) plus the gzip window, not the corpus.
- **Everything else fits comfortably**: pricing rows, invoices, invoice lines, matches,
  reconciliations, validation impacts, exposure refs are hundreds of objects, low
  single-digit MB uncompressed.
- **Expected wall time (Golden):** adaptation ~1–3 s (5,063 pure transforms), parity
  ~0.5 s, gzip+upload of ~5 MB ~2–5 s. Total ~5–10 s, entirely inside `after()` and
  therefore off the user-visible response path.
- **Memory overhead:** `ProjectValidatorInput` is already resident during validation
  (transaction rows with `record_json` + `raw_row_json` dominate). Threading it into the
  publisher extends its *lifetime* past `persistValidationRun`, not its size — this is the
  real cost of Candidate B and must be measured on the first Golden run. If retention
  proves problematic, the mitigation is to adapt transactions to NDJSON *before*
  `persistValidationRun` is awaited and hold only the gzipped part, not to sample rows.
- **Synchronous or deferred:** deferred (`after()`), always. Never awaited by
  `runValidationFlow`.
- **Embed or reference transactions:** embed, but as a *streamed part*, so full fidelity is
  preserved without a monolithic value.
- **Chunking (amended — A9):** deferred. v1 writes one
  `registry.transactions.ndjson.gz`; measured Golden gzip size is ~5 MB against a 50 MB
  default object limit, so chunking is not yet load-bearing. The manifest's
  `sectionDigests` map is already per-part, so splitting into
  `registry.transactions.{000n}.ndjson.gz` at a deterministic 5,000-rows-per-part boundary
  remains a purely additive change. Streaming — the property that actually bounds memory —
  is implemented now, not deferred.
- **Two-pass streaming (implementation contract):** pass one incrementally computes the
  transaction count and ordered digest; pass two incrementally serializes, gzips, meters,
  and uploads the identical ordering. Neither pass materializes the full transaction
  payload or the whole registry.

**Hard constraint:** no performance measure may truncate rows, sample truth, drop
evidence, or change deterministic output. Row count in the manifest must equal
`input.transactionData.rows.length` exactly, and a mismatch is a `failed` publication.

The evidence-duplication blowup should be fixed properly — an interned evidence pool with
`CanonicalEvidenceRef` by reference — but that changes canonical output shape and hashes,
so it belongs in its own slice, not this one (§16, §17 Q2).

---

## 12. Reader-isolation guards

**Baseline proven:** a repo-wide scan for `@/lib/canonical/` outside `lib/canonical/**`
and `lib/evaluation/**` returns only lines inside
`lib/architecture/importBoundaries.test.ts` itself. There is no production reader today.

**Static guards (extend `lib/architecture/importBoundaries.test.ts`):**

1. Keep the existing assertion: no production reader imports `lib/canonical/project/**`.
2. **New — frozen single-edge allowlist for the whole canonical tree.** Collect every edge
   from `app/`, `components/`, `lib/` (excluding `lib/canonical`, `lib/evaluation`) into
   `lib/canonical/**` and assert the set equals exactly:
   ```
   lib/validator/triggerProjectValidation.ts -> @/lib/canonical/publication/publishProjectTruthShadow
   ```
   Both directions are asserted, mirroring `LEGACY_LAYER_EXCEPTIONS`: an unexpected edge
   fails, and a *missing* expected edge also fails (so the publisher cannot be silently
   detached).
3. **New — publisher import denylist.** Assert no file under `lib/canonical/publication/**`
   imports `@/lib/projectFacts`, `@/lib/evaluation/**`, `@/lib/execution/**`,
   `@/lib/decisions/**`, `@/lib/server/approval*`, `@/lib/server/decision*`,
   `@/lib/server/executionQueue`, `@/lib/validator/persistValidationRun`,
   `@/lib/validator/approvalGate`, or anything under `components/` or `app/`. Cover alias,
   relative, `require`, and dynamic-`import` forms (the existing `moduleSpecifiers` helper
   already handles all four).
4. **New — no reverse dependency.** Assert nothing outside `lib/canonical/publication/**`
   imports the publication *types* (`projectTruthPublication.ts`) — only the entry point
   is importable, and only by the one allowlisted edge.
5. Reuse the existing `lib/canonical/project/goldenShadowChain.test.ts` boundary so Golden
   full-chain proof stays in `lib/evaluation/`.

**Behavioral guards:**

6. `construction: { mode: 'shadow_only', persisted: false }` is asserted present in every
   published registry, and the manifest carries `nonAuthoritative: true`.
7. No write outside the storage bucket, and **(amended — A2)** a narrower read surface than
   originally planned. Assert (with a mock admin client) that the publisher's only Supabase
   surface calls are `storage.*` plus a single read-only `select()` on
   `project_validation_runs`. Reads of `documents` or `extraction_source_artifacts` from
   `lib/canonical/publication/**` now **fail** the test — that data must arrive via
   `sourceArtifactSnapshot`. Any `insert`/`update`/`delete`/`rpc` against `public` fails,
   as does any bucket-creation API call (A3).
10. **A11 single-assembly and candidate isolation.** Assert the validation production call
    graph contains exactly one dual-view assembly call; `analyzeContractIntelligence`, rule
    packs, overrides, and publication contain no assembler reference; and candidate-view
    types or values have no production reader or publication edge.
8. Findings/exposure/status non-mutation: run a fixture validation with the publisher
   enabled and disabled and assert byte-identical persisted findings, evidence,
   `projects.validation_status`, `validation_summary_json`, approval snapshot, and
   execution items.
9. Publication failure isolation: inject throws at each stage and assert
   `runValidationFlow` resolves and the authoritative outcome is unchanged.

Directionality restated: **the publisher may consume current typed outputs; current
production paths may not consume publisher output.** Guard 2 enforces one direction,
guards 3–4 the other.

---

## 13. Initial rollout strategy

Generic, non-authoritative, temporary — and explicitly **no fixture-specific production
branching**. No project name, no Golden document id, no `302868.6`, no
`'Golden Project'` string anywhere in `lib/canonical/publication/**`. That is asserted by
test (reuse `goldenShadowChain.test.ts`'s literal detectors).

Flag contract:

```
EIGHTFORGE_CANONICAL_SHADOW_PUBLISH        = off | allowlist | all      (default: off)
EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS    = <comma-separated project uuids>
```

- `off` (default, and the value in every environment at merge time): the publisher returns
  before retaining any reference to `validatorInput`. Zero cost, zero risk.
- `allowlist`: publish only for project ids in the list. Ids are opaque configuration, not
  code.
- `all`: publish for every project.

Recommended sequence:

0. **Provision `canonical-shadow-artifacts` manually** as a private bucket (A3). Required
   before any environment moves off `off`; not required to merge.
1. **Merge with `off` everywhere.** Prove by test that production behavior and validation
   output are unchanged.
2. **Local / development, `allowlist` with the Golden project id supplied via env.**
   Confirm the published artifact matches the existing opt-in Golden full-chain parity
   proof (`GOLDEN_CORPUS_ROOT`) on counts, amounts, quantities, matches, and finding
   identities. This is where §11's memory and timing numbers get measured for real.
3. **Staging, `allowlist`, two or three real projects of varying shape** — including at
   least one where required-source rules short-circuit (§4.1) and one with no transaction
   workbook, to exercise `partial` publication.
4. **Production, `allowlist`, one low-risk project.** Watch the structured log line and the
   artifact for a full week of natural validation triggers.
5. **Production, `allowlist` widened progressively.**
6. **`all`** only after the parity report shows no `conflicting_current_truth_path` and no
   unexplained `not_yet_representable` across the allowlisted set.

"Publish only on gap-free success" is *not* the model: a completed publication may be
`partial` and carries its diagnostic gaps. A stage failure is not a publication and writes
no manifest (A5). What is gated is publication *at all*, by flag.

---

## 14. Exact files likely to be added or modified

The approved implementation contains **17 production source files**: nine additive new
publication files under `lib/canonical/publication/`, one relocated production parity file
under `lib/canonical/parity/`, and seven modifications to existing production files. Tests,
evaluation-only support, and this documentation file are listed separately and are not
included in that production count.

**Added — production parity support (1 file)**
- `shadowComparison.ts` — verbatim move of `compareCanonicalShadowBoundary` /
  `buildCanonicalProjectTruthShadowComparison` out of `lib/evaluation/`.

**Added — production publication files (9 files)**
- `projectTruthPublication.ts` — manifest, artifact part, parity report, and
  `ProjectTruthPublicationGap` types.
- `projectTruthPublicationSource.ts` — the typed input contract (§4) the publisher accepts,
  so the publisher never reaches into validator internals ad hoc.
- `projectTruthPublicationIdentity.ts` — canonical JSON, content hashes,
  `publicationId`, object paths (§8).
- `projectTruthShadowAdapter.ts` — production → canonical adaptation + gap ledger
  accumulation; calls the existing adapters only.
- `projectTruthTransactionStream.ts` — per-row adaptation + NDJSON gzip streaming (§11).
- `projectTruthParityReport.ts` — builds §6.3 from source + registry.
- `shadowArtifactDestination.ts` — Supabase Storage writer for a manually provisioned
  bucket: immutable `upsert: false` writes, metadata-based duplicate/conflict detection,
  and per-part digests. It never creates or configures a bucket and never downloads an
  existing object for comparison.
- `shadowPublicationFlag.ts` — §13 flag resolution, pure and unit-tested.
- `publishProjectTruthShadow.ts` — the **only** module production may import; exports
  `scheduleCanonicalProjectTruthShadowPublication` (void, never throws) and an awaited
  `publishProjectTruthShadow` for tests.

**Modified — existing production (7 files) — amended (A1, A2, A11, A12)**
- `lib/contracts/contractPricingAssembly.ts` — expose one dual-view execution returning
  frozen selected rows plus immutable pre-selection candidates keyed by stable source-row
  identity; the existing selected-row API delegates to it.
- `lib/contracts/analyzeContractIntelligence.ts` — consume the candidate view explicitly;
  no assembler import or invocation.
- `lib/validator/shared.ts` — `ValidatorSourceArtifactSnapshotEntry`; two additive
  `ProjectValidatorInput` fields; `document_role` / `storage_path` on
  `ValidatorDocumentRow` (§5.1.0).
- `lib/validator/projectValidator.ts` — add `runProjectValidation`; `validateProject`
  delegates (§5.1a); execute dual-view pricing assembly once, retain its selected rows,
  route its candidates to contract intelligence/overrides, and capture the frozen source
  artifact snapshot during input construction.
- `lib/pipeline/documentPipeline.ts` — invoke the same dual-view API once for its independent
  document-pipeline execution and pass candidates to contract intelligence; no publication
  edge is introduced.
- `lib/validator/persistValidationRun.ts` — additive return of `effectiveResult` +
  `persistedFindings` (§5.1b).
- `lib/validator/triggerProjectValidation.ts` — one call to
  `scheduleCanonicalProjectTruthShadowPublication` in `runValidationFlow`.

**Modified — tests / validator fixtures (separate from production count)**
- Rule-pack and validator boundary tests that construct a `ProjectValidatorInput` literal
  must supply `assembledContractPricingRows` and `sourceArtifactSnapshot`.

**Modified — evaluation-only support / architecture guard (separate from production count)**
- `lib/evaluation/canonicalProjectTruthShadowHarness.ts` — re-export from
  `lib/canonical/parity/shadowComparison`; no logic change.
- `lib/architecture/importBoundaries.test.ts` — guards 2–4 of §12.
- `lib/evaluation/canonicalGoldenFullChainRealFixtureParity.test.ts` — extend the opt-in
  Golden proof to assert the *published artifact* matches the harness registry.

**Added — tests (separate from production count)** (§15)
- `lib/canonical/publication/*.test.ts` (determinism, identity, idempotency, gaps, parity,
  streaming, flag, destination, failure isolation, size).
- `lib/validator/canonicalShadowPublicationIsolation.test.ts` (no findings/exposure/
  persistence change; publication failure does not fail the run).
- `lib/validator/projectValidator.categoryRescueParity.test.ts` (A11 structural-wins and
  persisted-wins semantic branch proof, including publication-off/on parity through the
  real validation-flow scheduler seam).
- `lib/validator/projectValidator.retainedInput.test.ts` (retained selected rows and the
  broader synthetic/human-review single-assembly compatibility proof).

**Added — documentation (1 file; separate from production count)**
- `docs/audits/canonical-production-shadow-publisher-plan-2026-08-02.md` — this contract
  of record.

**Not touched:** `lib/projectFacts.ts`, `lib/validator/exposure.ts`,
`lib/validator/reconciliation.ts`, all rule packs, `lib/execution/**`,
`lib/server/approval*`, `lib/server/decision*`, every UI component, every `app/api` route,
`supabase/migrations/**`, `types/validator.ts`.

---

## 15. Tests and gates

| # | Test | Assertion |
|---|---|---|
| 1 | deterministic registry generation | same source ⇒ byte-identical `registry.core.json` and transactions NDJSON across two runs and across key-insertion permutations |
| 2 | exact Golden parity (opt-in, `GOLDEN_CORPUS_ROOT`) | published artifact matches `executeGoldenFullChainSources()` on pricing rows, invoices 2026-002/003, invoice lines, **5,063** transactions, and the authoritative workbook sha256 |
| 3 | publication identity | `publicationId` stable across differing `generatedAt`; changes when any of registry / parity / gaps / run identity changes |
| 4 | idempotent retry | republishing the same run writes the identical path and identical bytes; no second manifest |
| 5 | duplicate prevention | pre-existing immutable object with identical trusted `comparisonDigest` metadata ⇒ `duplicate_suppressed`; missing or divergent metadata ⇒ fail closed with zero overwrite/download; a divergent `publicationId` under the same `runId` ⇒ `idempotency_conflict`, zero writes and no manifest |
| 6 | failure isolation | injected throw/timeout at each stage (adaptation, parity, serialization, destination, including missing/inaccessible manually provisioned bucket) ⇒ `runValidationFlow` resolves, authoritative outcome byte-identical |
| 7 | partial-source diagnostics | required-sources short-circuit fixture ⇒ reconciliation/cross-document boundaries classified `current_source_unavailable`, gaps name the pack, `status: 'partial'` |
| 8 | no production reader imports | §12 guards 2–4, covering alias / relative / `require` / dynamic import |
| 9 | no Project Facts input | no `lib/canonical/publication/**` file references `projectFacts` (import or identifier) |
| 10 | no finding/exposure changes | flag on vs off ⇒ identical persisted findings, evidence, `validation_status`, `validation_summary_json` |
| 11 | no persistence-authority changes | mocked admin client records only `storage.*` + allowlisted read-only `select`; any `insert`/`update`/`delete`/`rpc` on `public` fails |
| 12 | no migration | `supabase/migrations/` unchanged by this slice (git-diff assertion in review, not a unit test) |
| 13 | feature-flag behavior | `off` ⇒ zero adapter calls, zero storage calls, no `validatorInput` retention; `allowlist` ⇒ only listed ids; `all` ⇒ every project |
| 14 | no fixture branching | no `Golden`, no known Golden document id, no `302868.6` literal in `lib/canonical/publication/**` |
| 15 | large-workbook performance | 5,063 synthetic rows adapt + stream within a bounded budget; peak heap delta stays O(one row), asserted via `process.memoryUsage()` deltas |
| 16 | artifact size and serialization | round-trip `registry.core` + transactions NDJSON reconstructs the exact registry; `sectionDigests` verify; row count equals input row count exactly |
| 17 | grain integrity | ticket-grain totals in the parity report come from dataset rollups, never from summing transaction rows; conflicting repeated ticket rows produce a gap, not a silent pick |
| 18 | log hygiene | no log statement in the slice emits a field value, raw span, vendor name, or ticket detail |
| 19 | **(A1/A11)** single dual-view pricing assembly | the dual-view assembler executes exactly once across ordinary, duplicate/winner-selection, authored-correction, contract-intelligence, synthetic/human-override, and publication-enabled/disabled validation scenarios; selected rows and candidate enrichment come from the same execution; no contract-intelligence, rule-pack, override, or publication path reassembles; selected rows, candidates, ordering, contract-intelligence output, findings, and exposure remain semantically unchanged except for the separately authorized A12 persisted-fallback narrowing |
| 20 | **(A2)** snapshot-only source identity | the publisher issues no `documents` / `extraction_source_artifacts` query; a snapshot entry missing artifact id, sha256, or storage version yields the deterministic `manifest`/`source_unavailable` gap naming the missing fields while validation still succeeds; changing storage version or sha256 changes `exactSourceIdentity` and therefore `publicationId` |
| 21 | **(A4)** immutable fail-closed writes | `upsert: false`; identical trusted `comparisonDigest` metadata ⇒ `duplicate_suppressed`; missing or differing metadata at the same path ⇒ failure with no object download and no overwrite; a divergent `publicationId` under the same run prefix ⇒ `idempotency_conflict`, zero writes |
| 22 | **(A5)** manifest is terminal | injected failure at adaptation / streaming / upload ⇒ no `manifest.json` object exists, and exactly one categorized `console.error` is emitted |
| 23 | **(A6/A7)** run-derived determinism and freshness | two publications of the same run produce identical `generatedAt` and identical bytes; `status !== 'complete'` or a mismatched `inputs_snapshot_hash` aborts at `source_run` with nothing written |
| 24 | **(A12)** persisted compatibility boundary documentation | a focused static guard requires all four category aliases, disables fallback whenever selected rows exist or any alias is nonblank (including invalid/unresolvable values), records possible missing-rate / `BLOCKED` / at-risk impact, and keeps persisted compatibility separate from A11 selection rescue |

Verification gates, in order:

```bash
npx tsc --noEmit
```
```bash
npx vitest run lib/canonical lib/validator lib/architecture lib/evaluation --reporter verbose
```
```bash
npm run build
```
```bash
npx vitest run
```

Golden real-fixture parity stays opt-in via `GOLDEN_CORPUS_ROOT` and must be run manually
before the flag is enabled anywhere.

---

## 16. Explicit non-goals

1. No production reader cutover. Nothing reads the artifact.
2. No change to Project Facts, Validator inputs or rules, findings, exposure, decisions,
   approvals, execution, or UI.
3. No SQL migration, no new table, no RPC, no schema change.
4. No new orchestration framework, cron, queue, or worker.
5. No authoritative persistence of canonical truth; `persisted: false` stays literal.
6. No backfill of historical projects or historical validation runs.
7. No approvals / decisions / execution items in the v1 registry — they are written by
   sibling side effects *after* the snapshot is defined, so including them would make the
   artifact non-deterministic with respect to its own run.
8. No redaction, signed URLs, or operator-facing artifact browser.
9. No fix to the evidence-duplication size amplification (§11) — separate slice.
10. No alerting, gating, or health-check consumption of publication status.
11. No cross-project or portfolio-level artifact.
12. No change to the Golden fixture identity, manifest, or corpus.

---

## 17. Risks and unresolved questions

**Risks**

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Artifact size / memory on Fluid Compute (124–316 MB uncompressed for Golden) | **high** | streamed gzipped NDJSON, per-part digests, deterministic chunking, measured heap assertions (§11, test 15) |
| R2 | `ProjectValidatorInput` retention extended past `persistValidationRun` | medium | measure on first Golden run; fallback is to pre-stream transactions before awaiting persistence — never to sample rows |
| R3 | `after()` unavailable outside a request scope (`startBackgroundValidation` path) | medium | already-proven `try/catch` around `after()`; fall back to a detached promise with the same bounded/caught semantics |
| R4 | Two additive production signature changes touch the Validator surface | medium | both behavior-preserving; single production caller each; covered by test 10 |
| R5 | Parity comparator relocation could disturb existing evaluation tests | low | verbatim move + re-export; existing tests run unchanged as the gate |
| R6 | Storage bucket provisioning is an infrastructure action | low (amended — A3) | removed from code entirely; manual operator provisioning is a rollout precondition (§13 step 0), and a missing bucket is a contained `missing_bucket` failure |
| R10 | **(A1/A2)** two new required `ProjectValidatorInput` fields widen the validator input contract | medium | both additive and frozen; populated unconditionally on the authoritative path; every fixture updated; covered by tests 10, 19, 20 |
| R11 | **(A4/A5)** fail-closed idempotency and manifest-last can suppress a publication that the original plan would have written | low | deliberate: refusing to add a competing or torn artifact is the safer failure, and every refusal is logged with a normalized category |
| R7 | Artifacts contain ticket-level data possibly including personal information | medium | private bucket, service-role only, same trust boundary as the documents bucket, log hygiene (§10, test 18) |
| R8 | Parity report could be read as authoritative disagreement | low | manifest states `nonAuthoritative: true`, `mode: 'shadow_only'`; no consumer exists |
| R9 | Vercel object/function limits could force chunking mid-rollout | low | chunking designed in from the start, not retrofitted |

**Unresolved questions**

- **Q1 — ANSWERED (A3):** manual provisioning. Code never calls a bucket-creation API. Provisioning
  `canonical-shadow-artifacts` as a private bucket is a rollout precondition, tracked in
  §13 step 0, and its absence is a contained `missing_bucket` failure.
- **Q2:** should the evidence-duplication fix (interned evidence pool) be scheduled
  *before* this publisher, given it would change canonical hashes and therefore
  `publicationId`? Recommendation: no — publish first with measured sizes as the evidence
  that the fix is warranted, then fix and bump `canonicalSchemaVersion`.
- **Q3:** is the private Supabase Storage bucket an acceptable resting place for
  `raw_row_json` and raw authored spans without redaction? Recommendation: yes, because it
  is the same trust boundary as the `documents` bucket those bytes already occupy — but
  confirm, because a future move to any less-protected destination makes redaction
  mandatory.
- **Q4:** should the v1 registry populate `derived.pricingMatches` from
  `invoiceLineToRateMap` (available and typed) or leave it empty as the Golden harness
  currently does? Recommendation: populate — it is the highest-value parity signal
  available, and `representCanonicalPricingMatch` is a pure projection of a selection
  already made.
- **Q5:** retention policy for shadow artifacts (unbounded vs 90-day lifecycle)? Not
  blocking; default to unbounded in slice 1 and revisit once real volume is known.

---

## 18. Recommended Codex implementation slice

Sequenced so every step is independently reviewable and each has its own gate. Steps 1–2
are pure refactors that could land alone.

**Step 1 — parity comparator relocation (no behavior change).**
Move `shadowComparison` to `lib/canonical/parity/`; re-export from the evaluation harness.
Gate: `npx tsc --noEmit`; `npx vitest run lib/evaluation lib/canonical`.

**Step 2 — additive production signatures and retained input (amended — A1, A2, A11, A12).**
`runProjectValidation` + widened `persistValidationRun` return + the two frozen
`ProjectValidatorInput` fields (single pricing assembly, source artifact snapshot) + the
coordinated dual-view assembly boundary, candidate injection into contract intelligence,
and the independent document-pipeline caller adjustment + fixture updates. No candidate
view is exposed to publication or readers.
Gate: `npx tsc --noEmit`; `npx vitest run lib/validator`; tests 19, 20.

**Step 3 — publication domain types + identity.**
`projectTruthPublication.ts`, `projectTruthPublicationSource.ts`,
`projectTruthPublicationIdentity.ts`, `shadowPublicationFlag.ts`, all pure.
Gate: tests 1, 3, 13.

**Step 4 — adaptation + gap ledger + transaction streaming.**
`projectTruthShadowAdapter.ts`, `projectTruthTransactionStream.ts`. Pure functions over
the typed source contract; no Supabase, no I/O.
Gate: tests 1, 7, 15, 16, 17.

**Step 5 — parity report.**
`projectTruthParityReport.ts`.
Gate: test 2 structure (synthetic), plus opt-in Golden parity once step 7 lands.

**Step 6 — destination writer.**
`shadowArtifactDestination.ts`: write only to the manually provisioned private bucket;
immutable `upsert: false` writes; trusted `comparisonDigest` metadata for bounded duplicate
checks; missing or divergent metadata and divergent run-prefix publication identity fail
closed before any overwrite or second publication; no existing-object download; per-part
digests; bounded `settleWithin`.
Gate: tests 4, 5, 6, 11, 18 (mocked admin client only — no live bucket).

**Step 7 — publisher entry point + single production insertion + guards.**
`publishProjectTruthShadow.ts`; the one call in `runValidationFlow`; guard extensions in
`importBoundaries.test.ts`; extend the opt-in Golden parity test.
Gate: full sequence — `npx tsc --noEmit`, targeted vitest, `npm run build`,
`npx vitest run`, then manual `GOLDEN_CORPUS_ROOT` Golden parity.

Merge posture: flag `off` in every environment. Rollout proceeds per §13 in separate,
non-code changes.

Reporting requirement for each step: files changed; source-of-truth path used; downstream
consumers affected (expected: none); tests/build run; unresolved manual gates; whether
safe to commit.

---

## 19. Decision

**READY FOR CODEX IMPLEMENTATION.**

The recommended boundary exists, is singular, is already used by two reviewed shadow
precedents, and is the only point in the production pipeline where a complete and
internally consistent project snapshot exists. The canonical adapters needed for
production-shaped inputs already exist. Reader isolation is already guarded and the guard
extends naturally. The approved implementation spans 17 production source files: nine
additive new publication files, one relocated production parity file, and seven
modifications to existing production files. Tests, evaluation-only support, and this
contract-of-record document are separate from that production count. The retained-input
and persistence signatures remain additive and behavior-preserving.

**Amended 2026-08-04 (§0).** The approved contract now includes A1–A12. The production diff
adds the coordinated dual-view assembly boundary and its narrow caller migrations. A12
intentionally narrows the adjacent authoritative validator's persisted-rate-row fallback;
outside that authorized boundary, existing pricing and contract-intelligence semantics are
preserved. The publisher is a pure consumer of a frozen snapshot, holds no second pricing or
source-identity authority, and mutates no infrastructure.

Two qualifications, neither an architecture defect:

1. **§11 is a hard design constraint, not advice.** Full-fidelity canonical transactions
   measure 124–316 MB uncompressed for Golden because raw-row evidence is duplicated
   ~24× per transaction. The publisher must stream gzipped NDJSON per row. Any
   implementation that calls `JSON.stringify` on the whole registry will fail at Golden
   scale, and any implementation that "fixes" it by truncating rows, sampling, or dropping
   evidence must be rejected in review.
2. **Q1 (§7) is answered (A3): manual provisioning.** `canonical-shadow-artifacts` must
   exist as a private bucket before any environment leaves `off`, and the opt-in Golden
   full-chain publication gate (`RUN_GOLDEN_REAL_FIXTURE_TESTS` / `GOLDEN_CORPUS_ROOT`)
   must be executed before `allowlist` is enabled anywhere. Neither blocks merge with the
   flag `off`.

---

## 20. A13 — Canonical Project Truth authority cutover

A13 is the point at which the canonical registry stops being a diagnostic artifact and
becomes selectable runtime authority. A1–A12 kept the publisher from becoming a second
authority. A13 inverts the remaining relationship: the canonical registry becomes the
authority, and publication becomes evidence derived from it.

The canonical layer sits **downstream** of the Phase 3 document-intelligence track. Phase 3
preserves uncertain document structure and evidence before semantic interpretation; the
canonical pivot consumes that preserved evidence and does not reinterpret it:

```text
PDF observations
→ preserved structural evidence      (Phase 3 — upstream, unchanged by A13)
→ normalized canonical facts
→ canonical Project Truth registry
→ validation authority               (A13)
```

A13 does not redesign extraction and makes no schema or migration change.

### 20.1 The contract

1. **Canonical authority is selected explicitly.** `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=canonical`
   is the only way to enable it. The default is `legacy`. Unrecognized values resolve to
   `legacy`, so a typo cannot enable canonical authority.
2. **The authoritative object is the frozen in-memory registry.** `CanonicalProjectTruth`
   with `construction.mode: 'authoritative'` and `construction.persisted: false`. No
   published artifact and no storage object is ever the authority.
3. **Published artifacts remain audit evidence only.** Publication does not gate findings,
   exposure, or clearance, and is not a reader dependency. A publication failure never
   invalidates an otherwise successful canonical validation.
4. **Storage is never read back during validation.** The publisher's only post-validation
   read remains the persisted run row (A2). A13 adds no read path.
5. **Authority and publication are independent controls.**
   `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY` governs authority;
   `EIGHTFORGE_CANONICAL_SHADOW_PUBLISH` governs publication. Canonical authority operates
   correctly with publication `off`; this combination is explicitly supported and tested.
6. **Canonical mode prohibits silent fallback.** When canonical authority cannot establish
   required governing truth it returns an honest terminal state that preserves the reason
   and the implicated source gaps. It never substitutes legacy pricing or inferred facts.
   `blocked` denotes an absent source; `failed` denotes an assembly fault. The distinction
   is load-bearing so an infrastructure error is never reported as a source gap.
7. **One execution has one frozen source snapshot and one canonical registry.** The
   registry is assembled once, at the validator-input boundary, before any rule pack runs.
   The same deeply frozen object is threaded to validator inputs, rule-pack execution,
   findings, exposure, approval/clearance, persistence metadata, and optional publication.
   Prohibited: a second canonical assembly, publisher reassembly, storage readback,
   per-rule-pack reconstruction, an alternate pricing assembly in canonical mode, and mixed
   legacy/canonical authority inside one run.
8. **Results identify their authority.** Every run persists `projectTruthAuthorityMode`,
   `canonicalRegistryVersion`, `canonicalRegistryDigest`, `sourceArtifactSnapshotDigest`,
   `canonicalAssemblyStatus`, and `canonicalAssemblyBlockReason`. These are recorded once
   per run and therefore identify the authority behind that run's findings, exposure, and
   clearance. They are stored inside the existing `projects.validation_summary_json`
   structured field, so A13 requires no migration. `publicationStatus` is operational
   metadata only and is attached by the publication path.
9. **Legacy mode remains the emergency rollback.** The legacy implementation is retained
   and is not deleted by A13. Rollback is `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=legacy`.
10. **Remaining duplicate legacy paths are temporary.** They are scheduled for removal
    after canonical stability, and enumerated in §20.4.

### 20.2 Rule-pack neutrality

Rule packs never read the authority environment variable and never branch on authority
mode. They receive normalized inputs through the existing `RateScheduleItem` interface,
derived from the registry in exactly one projection module. This satisfies A13 without a
rule-pack rewrite. A pack that inspected authority mode would reintroduce per-pack truth
decisions and must be rejected in review.

### 20.3 Implementation status (honest scope)

Implemented and verified:

- authority mode, central resolver, default `legacy`, fail-closed parsing;
- one frozen execution context per run, deeply frozen, threaded downstream;
- canonical **pricing** authority, including categories and units carried on the projected
  rate rows;
- no-fallback `blocked`/`failed` behavior with preserved source gaps;
- single-assembly invariant, including the publisher inversion (publication reuses the
  frozen pricing rows by reference and never re-runs the pricing adapter);
- persisted authority metadata with no migration;
- deterministic canonical registry and source-snapshot digests.

**Not yet canonical as of A13.** The following registry sections were assembled empty and
their validator inputs still came from legacy loaders. This was deliberate and honest — an
empty canonical section states "not yet canonical", whereas a legacy back-fill would mix
authorities inside one run:

- `invoices` / `invoiceLines` — requires the invoice adapter in the single assembly;
- `transactions` — transaction quantity and amount, requires the transaction adapter;
- `governingDocuments` — document relationship truth;
- `contractTermReferences` — source-backed term identity.

**Superseded by A14 (§21).** `transactions`, `invoices`, `invoiceLines`, and the
governing-document relationships are now canonical, and per-domain coverage records which
truth domains a given run actually governed. `contractTermReferences` remains deferred; see
§21.12.

**Structurally deferred.** The `derived` sections (`pricingMatches`,
`contractInvoiceReconciliations`, `invoiceTransactionReconciliations`,
`projectReconciliation`, `validationImpacts`, `exposureReadinessReferences`) are computed
**from** the validation result. They cannot be authoritative *inputs* to the computations
that produce them without circularity. Making the canonical layer own exposure,
reconciliation, and clearance derivation would relocate the validation engine, which is a
larger change than A13 and is not authorized here. They are completed once from the result
and published as evidence.

**Acceptance gate — run and passing.** `lib/canonical/authority/authorityCutoverAcceptanceGate.test.ts`
covers all four required cases plus determinism, 22 cases passing. It runs against
`lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json` — real Golden-derived
contract pricing pinned to `sourcePdfSha256` `922161a5…` of the Williamson corpus PDF and
checked into the repository — so the gate is reproducible on any checkout and does **not**
require `GOLDEN_CORPUS_ROOT`.

| Case | Evidence |
|---|---|
| Golden | Every governing row survives the canonical projection; rate, unit, and description preserved exactly; the A12/F-04 authored-correction quarantine survives, so canonical mode cannot approve rows legacy mode quarantined |
| Cross-document pricing | Every rate row attributed to the governing document; pricing adapter invoked exactly once, so no validator-local rediscovery competes; distinct registry digest per governing document |
| Missing / malformed pricing | Returns `blocked` with the source gap preserved; refuses an available legacy rescue row; never fabricates a rate from malformed input |
| Publication failure | Real `publishProjectTruthShadow` driven with injected failures at the `adaptation` and `source_run` stages; failures are classified (`errorCategory: source_unavailable`, `blocking: false`) rather than propagated; findings, exposure, and clearance unchanged; persisted authority stays canonical; frozen registry uncorrupted |
| Determinism | Repeated runs yield identical registry digests, source-snapshot digests, normalized facts, and persisted metadata; a canonical run never admits a legacy row |

The pre-existing opt-in full-chain parity test (`RUN_GOLDEN_REAL_FIXTURE_TESTS` /
`GOLDEN_CORPUS_ROOT`) remains skipped by default and is unaffected. Note that the Golden
corpus workbook was hand-edited on 2026-06-08, which is the known source of the 5,055 vs
5,063 transaction-row drift; the acceptance gate deliberately does not depend on that
workbook.

### 20.4 Legacy deletion ledger

Retained deliberately as the rollback path. Each entry is removable only after canonical
authority is stable **and** the corresponding canonical section in §20.3 is implemented.

| # | Legacy path | Location | Removal precondition |
|---|---|---|---|
| L1 | Legacy rate-schedule item construction from fact rows | `projectValidator.ts` — `buildRateScheduleItems`, `normalizeRateScheduleItem` | Canonical pricing authority is the only mode; A12 compatibility narrowing folded into canonical resolution |
| L2 | Legacy branch in the authority seam | `projectValidator.ts` — `authoritativeRateScheduleItems` legacy arm | `legacy` mode retired |
| L3 | Publisher self-assembly of pricing | `projectTruthShadowAdapter.ts` — `adaptAssembledPricingRows` arm when no authoritative registry is supplied | `legacy` mode retired; publication only ever runs after canonical authority |
| L4 | Legacy invoice synthesis | `projectValidator.ts` — `synthesizeInvoicesFromLegacyExtractions`, `applyEffectiveInvoiceFacts` | Canonical `invoices` / `invoiceLines` implemented (§20.3) |
| L5 | Legacy transaction rollups as validator truth | `projectValidator.ts` — `validatorTransactionData`; `reconciliation.ts` — `buildValidatorTransactionRollups` | Canonical `transactions` implemented (§20.3) |
| L6 | Legacy governing-document derivation | `projectValidator.ts` — `buildDocumentIdsByFamily`, precedence snapshot fan-out | Canonical `governingDocuments` implemented (§20.3) |
| L7 | Dual `construction.mode` on the registry | `projectTruth.ts` — `'shadow_only'` variant | Shadow-only assembly no longer produced anywhere |

Removing any entry while `legacy` is still a supported mode would eliminate the rollback
and must be rejected in review.

### 20.5 Operator procedure

Enable canonical authority:

```bash
EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=canonical
```

Roll back to legacy authority:

```bash
EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=legacy
```

Publication is controlled separately and independently, using its existing approved
configuration:

```bash
EIGHTFORGE_CANONICAL_SHADOW_PUBLISH=<existing approved value>
```

Notes for operators:

- Unsetting `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY` is equivalent to `legacy`.
- Canonical authority does **not** require publication to be enabled. `authority=canonical`
  with `publication=off` is a supported configuration.
- A canonical run that reports `canonicalAssemblyStatus: blocked` is reporting a real
  source gap, not a transient fault. Read `canonicalAssemblyBlockReason` and the recorded
  source gaps rather than re-running. `failed` indicates an assembly fault and is the state
  to escalate.
- Rolling back to `legacy` does not rewrite already-persisted runs. Each stored run
  identifies the authority that produced it via `projectTruthAuthorityMode`.

---

## 21. A14 â€” Canonical transaction and document-relationship authority

A13 made the canonical registry selectable runtime authority for **pricing**. A14 completes
the cutover for the remaining transaction and document truth domains, and adds the coverage
model that makes "canonical authority governed this run" a checkable claim rather than an
assumption.

A14 makes no schema or migration change and does not redesign extraction. Phase 3 remains
upstream structural-evidence preservation, unchanged and unconsumed by the authority layer:

```text
PDF observations
â†’ preserved structural evidence      (Phase 3 â€” upstream, unchanged by A13/A14)
â†’ normalized canonical facts
â†’ canonical Project Truth registry
â†’ validation authority               (A13 pricing, A14 transactions/invoices/relationships)
```

### 21.1 Canonical invoice identity

The canonical invoice id is a deterministic composite of **project, source artifact, source
document, and invoice number**, assembled from the effective invoice rows validator-input
construction already loaded. No document is re-read, no OCR re-run, no table reconstructed.

Two obvious shortcuts are rejected:

- **The persisted row id is not the identity.** It is generated at insertion, so using it
  would make canonical identity depend on database insertion. It is retained as
  `sourceRecordId` â€” evidence and scoping input, never the id basis.
- **The invoice number alone is not sufficient.** Two documents can each claim `INV-1001`.

The composite excludes every value-bearing field â€” total, billed amount, quantity â€” so a
corrected amount never renames an invoice and a value disagreement can never masquerade as
two different invoices.

`identityConfidence` reports how precisely identity could be scoped:

| Value | Meaning |
|---|---|
| `document_scoped` | project + artifact + document + invoice number. Independent of any generated id. |
| `source_scoped` | the composite could not separate two observations, so source-observation identity was added. |
| `unresolved` | deterministic uniqueness could not be established; input ordinal was the only discriminator left. Surfaced, never silently accepted. |

**Missing invoice number.** Represented explicitly (`invoiceNumberPresent: false`, envelope
state `absent_from_source`), never blanked. Two unnumbered invoices in one document do not
collapse: identity degrades to `source_scoped`, and where even that is unavailable, to
`unresolved`.

**Duplicate invoice number.** Two distinct source documents claiming one number produce two
canonical invoices plus a deterministic `CanonicalInvoiceIdentityConflict`. Both observations
survive, neither is chosen, and the invoices domain is blocked.

### 21.2 Canonical invoice-line identity

Line identity is built from source **location** â€” canonical invoice id, source document,
page, sheet, row, observation id â€” and never from description, quantity, rate, or amount.
Two rendered rows carrying identical business values are two rows; collapsing them would
violate the repository grain rules and understate billed quantity.

A line with no location and no observation id is **preserved, never merged**, and reported
through a deterministic `CanonicalInvoiceLineIdentityIssue` with `identityConfidence:
unresolved`. A line that cannot be attached to any invoice is reported as orphaned rather
than adopted by an arbitrary parent.

### 21.3 Canonical transaction identity, quantity, amount, and grain

Unchanged from the transaction increment and restated here as the A14 contract:

- Ticket identity is scoped by source document, so one ticket number in two documents is two
  tickets. A row without a ticket number is never merged on a null identity.
- Identity is never derived from quantity or amount.
- `distinctIdentityCount` is the correct denominator for ticket-grain counts;
  `rows.length` may exceed it when one ticket appears on repeated physical rows.

**Quantity authority.** Transaction quantity is ticket-grain. Repeated physical rows sharing
one identity are never summed.

**Amount authority.** Extended cost follows the same rule.

**Grain-conflict behavior.** Where repeated rows disagree on a ticket-grain value, the
assembly emits a deterministic `CanonicalTransactionGrainConflict` and refuses to pick a
winner. Both observations survive verbatim, no reconciled third value is fabricated, the
`TRANSACTION_TICKET_GRAIN_CONFLICT` finding is operator-visible with both observations as
separate evidence entries, and the transactions domain is blocked.

### 21.4 Contract and invoice relationships

Relationships are projected from the precedence snapshot and the canonical assemblies;
`lib/documentPrecedence.ts` remains the sole producer of precedence. States reuse the
repository vocabulary:

| State | Meaning |
|---|---|
| `observed` | the source states the relationship directly |
| `derived` | deterministically computed from other canonical truth |
| `operator_asserted` | a human decided it; outranks `derived` |
| `unresolved` | no candidate could be established |
| `conflicting` | two or more candidates compete |

Zero candidates is `unresolved`; two or more is `conflicting`. **Neither picks a winner, and
legacy resolution cannot overwrite either state.** An operator assertion is the only
legitimate way a conflict settles, and the candidates it overrode stay on the record so the
decision remains auditable.

Kinds: `invoice_belongs_to_project`, `invoice_belongs_to_contract_family`,
`invoice_references_governing_contract`, `invoice_line_belongs_to_invoice`,
`transaction_belongs_to_invoice_line`, `pricing_exhibit_belongs_to_contract_family`,
`pricing_exhibit_governs_rate_truth`, `transaction_references_governing_pricing_row`,
`source_artifact_belongs_to_document_family`, `document_precedence`.

**Required vs reported.** Only the relationships that actually govern truth are required:
`invoice_belongs_to_project`, `invoice_references_governing_contract`,
`pricing_exhibit_governs_rate_truth`, and invoice-line attachability. Family membership is
taxonomy and is reported without blocking; rate-key-to-pricing-row matching is left to the
rate rule packs that exist to report it. A **conflicting** relationship blocks its domain
whether or not it is required â€” an unsettled conflict is never a pass.

**Relationship grain is bounded by identity class, not row count.** A 5,000-row workbook adds
relationships per invoice, per billing rate key, and per document â€” not per row. Row-level
identity already lives on the invoice, line, and transaction assemblies, so per-row
relationship records would inflate the registry and its digest without adding truth.

### 21.5 Canonical provenance

Every canonical invoice, line, transaction, and relationship carries a `CanonicalProvenance`:
source artifact id, source document id, page, sheet, row, bounding box, raw span, observation
id, adapter identity, source-family identity, derivation type, and operator assertion id.

`CanonicalEvidenceRef` is reused as the structural record; provenance adds only the four
dimensions it lacks. **No second evidence subsystem exists** â€” provenance projects into the
shape the existing finding-evidence model already accepts, so canonical findings use
`makeFinding` unchanged.

**Geometry is never fabricated.** A missing bounding box stays null. Missing geometry is
acceptable as long as document, page, or observation identity stays honest, which
`provenanceIsLocatable` reports rather than assumes. Repeated runs produce identical evidence
identity, so a persisted finding keeps its id instead of looking new each run.

### 21.6 Domain coverage and blocked states

| State | Meaning |
|---|---|
| `authoritative` | canonical truth governs this domain for this run |
| `blocked` | canonical truth could not be established; the reason is preserved for triage |
| `not_applicable` | the project has no source for this domain, so there is nothing to govern |

There is deliberately **no `legacy` coverage state**. A legacy-loaded domain inside a
canonical run is a block, not a success with a footnote.

**Canonical success rule.** A canonical run is either authoritative for every required domain
(`pricing`, `invoices`, `invoiceLines`, `transactions`, `relationships`, `provenance`) or it
reports `blocked` with `canonicalAssemblyBlockReason: incomplete_domain_authority` and
per-domain reasons. Domain-specific block reasons include
`duplicate_invoice_number_across_source_documents`, `unresolved_invoice_identity`,
`invoice_lines_without_resolvable_invoice`, `ticket_grain_conflict`,
`conflicting_governing_relationship`, `unresolved_required_relationship`, and
`canonical_record_without_source_document`.

On a domain block the validator projection is **retained**. It is the evidence of the block;
dropping it would leave an operator a bare status with no way to see which domain failed. It
is still not authoritative â€” `isCanonicalAuthorityEstablished` requires `assembled`.

### 21.7 No mixed authority

A13 left one hole: a `blocked` or `failed` canonical context emptied the rate rows but kept
**legacy** transaction rows, so a blocked run silently mixed authorities. A14 closes it â€”
transaction truth empties on the same seam as pricing. A canonical run therefore either
governs with canonical truth or reports a block; it never partially rescues from legacy.

Rule-pack neutrality is unchanged and now enforced statically: a rule pack may not read the
authority mode, parse the environment, or import `lib/canonical`, and exactly one
canonical-to-validator projection module may exist.

### 21.8 Exposure and clearance inheritance

Authority is inherited through the canonical validator inputs. **No business algorithm moved
into `lib/canonical`**: `evaluateProjectExposure`, the reconciliation builders, the rule
packs, and `evaluateApprovalGate` are the shipping implementations, called unchanged. Only
the rows they read change authority.

Consequently, in canonical mode: exposure consumes canonical amounts; quantity-dependent
findings consume canonical quantities; reconciliation consumes canonical identities; evidence
references use canonical provenance; and an unresolved grain conflict, invoice identity, or
governing relationship prevents clearance rather than passing on ambiguous truth.

### 21.9 Publication remains audit-only

Publication is still controlled separately, still reuses the frozen registry by reference,
and still never re-enters validation. The A14 gate asserts registry **object identity** â€”
not merely digest equality â€” across an injected publication failure, so a silent reassembly
would fail the gate. Findings, exposure, clearance, coverage, and both digests are unchanged
by a publication failure.

### 21.10 Acceptance gate â€” run and passing

`lib/canonical/authority/canonicalFullChainAuthorityGate.test.ts`, 34 cases, against
`lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json` â€” real Golden-derived
pricing pinned to `sourcePdfSha256` `922161a5â€¦` of the Williamson corpus PDF and checked into
the repository, so the gate is reproducible on any checkout and does **not** require
`GOLDEN_CORPUS_ROOT`.

| Case | Evidence |
|---|---|
| Golden transaction authority | Every required domain authoritative; Golden rate, unit, and description preserved exactly; quantities and amounts verbatim; one identity per invoice, line, and ticket; no legacy row admitted; legacy mode unchanged |
| Cross-document contract + exhibit | Invoice placed in the correct contract family; governing contract and governing pricing exhibit resolved separately; every rate row attributed to the exhibit; a supplied legacy resolution cannot override canonical relationship truth; distinct digest per governing document |
| Ticket-grain conflict | One ticket identity, both observations preserved, observed values exactly `[400, 560]` with no average/max/sum, transactions domain blocked, deterministic conflict identity |
| Missing invoice identity | Two unnumbered invoices stay distinct; invoices domain blocked as `unresolved_invoice_identity`; duplicate number across documents blocked with both observations preserved |
| Relationship conflict | Relationship stays `conflicting` with no winner; both candidates preserved in finding evidence; `invoices` and `relationships` domains blocked |
| Publication failure | Real `publishProjectTruthShadow` with an injected adaptation failure; findings, exposure, coverage, and both digests unchanged; registry object identity preserved |
| Determinism | Identical identities, coverage, digests, and persisted metadata across repeated runs and reversed input ordering |
| Full-chain single assembly | Spy counts: one pricing pass, one invoice pass per invoice, one transaction pass per row, zero publisher calls, zero storage readback; context, projection, coverage, and registry all frozen |

Supporting suites: `canonicalInvoiceAuthority.test.ts` (18),
`canonicalRelationshipAuthority.test.ts` (13), `canonicalDomainCoverage.test.ts` (15),
`canonicalTruthIntegrity.test.ts` (9), `canonicalAuthorityExposureClearance.test.ts` (7).

### 21.11 Persisted metadata

Additive fields inside the existing structured summary object under
`project_truth_authority`. No migration. Preserved from A13: authority mode, registry
version, registry digest, source snapshot digest, assembly status, assembly block reason, and
the separately attached publication status.

Added by A14: `canonicalAuthorityCoverage`, `blockedTruthDomains`, `canonicalInvoiceCount`,
`canonicalInvoiceLineCount`, `canonicalTransactionCount`, `canonicalTransactionConflictCount`,
`unresolvedInvoiceIdentityCount`, `unresolvedRelationshipCount`.

Counts are **null, not zero**, in legacy mode: zero would assert that canonical authority ran
and governed nothing, which is a different claim from canonical authority never having run.
The merge is additive under one reserved key, so every other summary field survives, and a
run without authority metadata writes the summary through unchanged.

### 21.12 Remaining deferred domains

- `contractTermReferences` â€” source-backed contract term identity is still assembled empty.
  An empty canonical section states "not yet canonical"; a legacy back-fill would mix
  authorities inside one run.
- The `derived` sections (`pricingMatches`, `contractInvoiceReconciliations`,
  `invoiceTransactionReconciliations`, `projectReconciliation`, `validationImpacts`,
  `exposureReadinessReferences`) remain **structurally deferred**. They are computed *from*
  the validation result and cannot be authoritative *inputs* to the computations that produce
  them without circularity. Making the canonical layer own exposure, reconciliation, and
  clearance derivation would relocate the validation engine, which is a larger change than
  A14 and is not authorized here.
- Operator relationship assertions are supported by the assembly but have no persisted
  source yet; the input is accepted and honored, and nothing fabricates one.

### 21.13 Updated legacy deletion ledger

Retained deliberately as the rollback path. Each entry is removable only after canonical
authority is stable **and** its canonical domain reports `authoritative` in real runs.

| # | Legacy path | Location | Removal precondition |
|---|---|---|---|
| L1 | Legacy rate-schedule item construction from fact rows | `projectValidator.ts` â€” `buildRateScheduleItems`, `normalizeRateScheduleItem` | Canonical pricing authority is the only mode |
| L2 | Legacy branch in the authority seam | `projectValidator.ts` â€” `authoritativeRateScheduleItems` legacy arm | `legacy` mode retired |
| L3 | Publisher self-assembly of pricing | `projectTruthShadowAdapter.ts` â€” `adaptAssembledPricingRows` arm when no authoritative registry is supplied | `legacy` mode retired |
| L4 | Legacy invoice synthesis | `projectValidator.ts` â€” `synthesizeInvoicesFromLegacyExtractions`, `applyEffectiveInvoiceFacts` | **Narrowed by A14** â€” canonical `invoices`/`invoiceLines` are now assembled from these rows, so the loaders are the canonical INPUT and are removable only when a canonical invoice loader replaces them |
| L5 | Legacy transaction rollups as validator truth | `projectValidator.ts` â€” `validatorTransactionData` legacy arm | **Narrowed by A14** â€” the blocked-context legacy rescue is removed; the remaining legacy arm is reachable only in `legacy` mode |
| L6 | Legacy governing-document derivation | `projectValidator.ts` â€” `buildDocumentIdsByFamily`, precedence snapshot fan-out | **Narrowed by A14** â€” canonical relationships now project this map rather than competing with it; removable when a canonical precedence source exists |
| L7 | Dual `construction.mode` on the registry | `projectTruth.ts` â€” `'shadow_only'` variant | Shadow-only assembly no longer produced anywhere |

Removing any entry while `legacy` is still a supported mode would eliminate the rollback and
must be rejected in review.

### 21.14 Operator procedure

Unchanged from Â§20.5. Canonical authority is enabled with
`EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=canonical` and rolled back with `=legacy`; publication is
controlled separately and independently.

Additional note for A14: a canonical run reporting `canonicalAssemblyStatus: blocked` with
`canonicalAssemblyBlockReason: incomplete_domain_authority` is reporting a real source gap in
a specific truth domain. Read `blockedTruthDomains` and the per-domain reason in
`canonicalAuthorityCoverage` rather than re-running.


## 22. A15 â€” Non-serving legacy versus canonical authority comparison

A13 and A14 made the canonical registry *selectable* runtime authority. A15 answers the
question that must be settled before it becomes the *default* one: on real project data, where
do legacy and canonical actually disagree, and is each disagreement canonical correcting legacy
or canonical regressing?

A15 adds no schema change, no migration, and no extraction change. Phase 3 remains upstream
structural-evidence preservation, unchanged and unconsumed:

```text
PDF observations
â†’ preserved structural evidence      (Phase 3 â€” upstream, unchanged by A13/A14/A15)
â†’ normalized canonical facts
â†’ canonical Project Truth registry
â†’ validation authority               (A13 pricing, A14 transactions/invoices/relationships)
â†’ non-serving authority comparison   (A15 â€” advisory, audit-only)
```

### 22.1 Purpose, and what the comparison is not

The comparison runs both authority modes over one frozen validation input, normalizes both
outputs, classifies every material delta, and emits an operator-reviewable report.

It is **advisory**. It does not change which result production users receive. The canonical
result produced by a comparison is **non-serving**: it is normalized into summaries and evidence
references and then discarded. `runProjectTruthAuthorityComparison` returns a
`ProjectTruthAuthorityComparison` and never a servable validation payload â€” no such type is
imported or named in the orchestrator, and an architecture boundary test fails the build if one
reappears. A caller that wanted to serve a comparison would have nothing to serve.

### 22.2 One frozen input snapshot feeds both runs

`loadValidatorSourceSnapshot` performs every read and every authority-independent derivation for
one execution, exactly once. `buildValidatorInputFromSourceSnapshot(snapshot, { authorityMode })`
is pure and synchronous: given the same snapshot and mode it always produces the same input.

Consequences, all of them load-bearing:

- both runs read the same loaded source data and the same project state;
- neither run can reload documents, reread publication storage, or rerun OCR or extraction;
- the canonical run cannot observe anything the legacy run did.

Mutation isolation is **verified, not trusted**. `inputSnapshotDigest` is computed before either
run and recomputed after each. A change means a run mutated shared source data, and the
comparison reports `comparison_failed` with `input_mutation_leak` rather than publishing deltas
caused by its own contamination.

The digest is an identity of meaning, not of representation: object key order never matters,
array order never matters where it is not semantically meaningful (every collection is reduced to
canonical member strings and sorted), and `Map` values are expanded to sorted entry pairs â€”
without which `JSON.stringify` would render a populated fact lookup as `{}` and the digest would
be blind to every fact in the project. Wall-clock time and per-run identifiers are absent from
the snapshot by construction.

### 22.3 Serving authority remains independently configured

Three controls, three purposes, no coupling:

| Control | Governs | Default |
|---|---|---|
| `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY` | which authority **serves** | `legacy` |
| `EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE` (+ `_PROJECTS`) | whether a **comparison** runs | `off` |
| `EIGHTFORGE_CANONICAL_SHADOW_PUBLICATION` (+ `_PROJECTS`) | whether an artifact is **published** | `off` |

All four authority/comparison combinations are legal and tested:

```text
authority=legacy,    comparison=off   â€” pre-A15 behavior, unchanged
authority=legacy,    comparison=on    â€” the recommended production shadow phase
authority=canonical, comparison=off   â€” canonical serving, no observation
authority=canonical, comparison=on    â€” canonical serving, legacy observed for rollback evidence
```

The comparison direction never flips: `legacy` is always the legacy side and `canonical` always
the canonical side, regardless of which one serves. Enabling comparison does not enable canonical
serving authority, and enabling canonical serving authority does not enable comparison.

**Recommended initial production configuration: `authority=legacy`, `comparison=on`.**

### 22.4 Disabled by default, and cohort-scoped

Comparison is off unless deliberately enabled, and fails closed: an unrecognized value, or
`allowlist`/`on` with no project ids, resolves to `off`. A typo must never silently start running
two validations per project, and "on with no cohort" is a misconfiguration rather than a request
to compare every production project.

The cohort is an explicit operator decision supplied by project id. No production project id is
hardcoded anywhere in the repository. Repository acceptance uses seven owned fixture profiles
covering the required cohort shapes â€” Golden, cross-document, clean, source gap, ticket-grain
duplicate rows, ticket-grain conflict, and exact parity â€” with the Golden profile driven by the
real in-repo `goldenAuthoredTransportPricingRows.json` pinned to the Williamson corpus PDF.

### 22.5 Comparison failure is non-blocking

The comparison runs from `runValidationFlow` **last**, after the serving result is persisted and
publication is already scheduled. It receives the snapshot that execution already loaded, so it
adds no database read, and it receives neither the serving result nor the persisted run â€” it
re-derives both authorities from the frozen snapshot so one authority's output cannot contaminate
the other or be mistaken for it.

Every failure mode is absorbed: a comparator fault, a normalization fault, and a persistence
fault all leave the serving result, project state, publication, and notifications untouched. A
comparison that cannot be stored is a lost audit record; a comparison that failed a validation run
would be a production incident. The former is always preferable.

Comparison cannot run recursively (an explicit in-flight guard, in addition to the structural fact
that the comparator calls only pure validator functions) and cannot trigger a second publication
(it never reaches the publisher at all).

### 22.6 Output normalization contract

There is exactly **one** normalization module, asserted by an architecture test. A second one â€”
even a small test-local helper â€” would let two comparisons of the same run disagree, which is what
makes a shadow phase worthless.

The normalizer reshapes the output of the shared builders; it never becomes a second truth path.
Exposure comes from the exposure builder, clearance from `evaluateApprovalGate`, findings from the
rule packs. Nothing is recomputed.

| Domain | Normalized to |
|---|---|
| Identity | invoice, invoice-line, and transaction identities from source-backed tuples; duplicate identities derived from the identity multiset rather than trusted from an authority's own report; unresolved identities named explicitly |
| Quantity | ticket-grain totals at project, invoice, ticket, category, and unit grain, plus `rowCount`, `distinctTicketCount`, `rowGrainQuantityTotal`, and `conflictedIdentityCount` |
| Amount | project, invoice, category, and governing-pricing-row grain; invoice billed amounts taken from the exposure builder, never re-derived |
| Pricing | governing document, category, description, unit, rate, source artifact, source page, provenance reference |
| Findings | deterministic key of code + affected identity + field; severity, status, blocked reason, evidence sources |
| Exposure | total, contract-supported, transaction-supported, fully reconciled, unreconciled, at-risk, requires-verification, unresolved, blocked, and a readiness state |
| Clearance | approval outcome, validation status, blocking and review counts, unresolved truth domains, approval gate reasons |
| Provenance | source artifact, source document, page, geometry presence, adapter identity, governing relationship evidence |

Four normalization decisions are worth stating because each removes a whole class of false alarm:

- **Ticket grain is deduplicated by ticket identity, and the same rule is applied to BOTH
  authorities.** Repeated rows that agree contribute their single value once; repeated rows that
  *disagree* contribute nothing and are counted as conflicts. Summing them would be the
  double-count the grain rules forbid; picking a winner would discard a real source disagreement.
  Because the rule is symmetric, `rowGrainQuantityTotal` is retained as the diagnostic that makes
  a physical row double-count visible â€” without it, an authority that double-counted would look
  identical to one that did not.
- **Pricing identity excludes internal record ids.** The legacy and canonical adapters assign
  different record ids to the same source row, so including one would report every pricing row as
  changed. Identity is the source-backed tuple an operator can verify against an exhibit.
- **Finding evidence is reduced to `type:document`.** The record-id segment is an internal adapter
  id; comparing it would report evidence loss on every finding that merely passed through a
  different adapter, burying real evidence loss.
- **Amounts round to 2 decimals and quantities to 6, on both sides, before comparison.** A
  surviving difference is real at that precision; a difference below it is equivalent decimal
  representation. `-0` is normalized to `0`.

Geometry presence is recorded; geometry coordinates are not compared. Attributability â€” can this
record name its source document â€” is the provenance requirement. Geometry is not.

### 22.7 Delta classification contract

Delta ids are deterministic: a digest of `(domain, entityKey, field)`, never a counter, never a
position, never a timestamp. Ordering is content-derived. Repeated comparisons of the same input
produce identical ids in an identical order, which is what lets an operator disposition recorded
yesterday still refer to the same delta today.

Classification is conservative and every judgement-bearing outcome is a **candidate**:

| Classification | Assigned when |
|---|---|
| `equivalent_normalization` | different internal ids for the same source identity; ordering, formatting, or decimal representation only |
| `canonical_correction_candidate` | evidence supports canonical: a preserved ticket-grain conflict legacy summed, the governing exhibit selected over a non-governing document, a distinct source row legacy collapsed, a condition legacy resolved silently |
| `regression_candidate` | canonical drops a source-backed record, changes a quantity or amount with no conflict and no block, loses governing provenance, clears what legacy blocked, or introduces a duplicate identity |
| `source_gap` | required truth is absent â€” missing pricing, missing identity, missing relationship, absent provenance |
| `authority_policy_difference` | canonical deliberately refused: no fallback, unresolved relationship blocked, conflict preserved, a value legacy chose that canonical declines |
| `expected_non_semantic_difference` | structural by construction, e.g. legacy always reporting `assemblyStatus: not_requested` |
| `unclassified` | the rules cannot justify a category from the evidence in front of them |

`unclassified` must stay reachable. Forcing every delta into a category would manufacture
confidence. There is deliberately **no** `canonical_correction` or `canonical_regression`
classification: those words belong only to operator dispositions.

A consequence of a canonical *refusal* is classified `authority_policy_difference`, not
`regression_candidate` â€” refusing to guess is designed behavior, and misclassifying it would train
operators to dismiss real regressions. The single exception is clearance loosening, below.

### 22.8 Blocking materiality rules

A delta is `blocking` when:

- clearance changes from blocked to clear, or validation from `BLOCKED` to not-blocked, without
  proven evidence. **This is blocking even when canonical also refused**, because a refusal that
  ends in a clearer gate is self-contradictory;
- exposed, at-risk, or unreconciled dollars **decrease** â€” an unexplained reduction in stated
  financial risk. An increase is conservative and merely informational;
- exposure readiness improves from not-ready to ready;
- canonical loses a source-backed invoice, invoice line, or transaction, or loses source-backed
  quantity or amount;
- governing pricing changes â€” rate or governing document â€” without relationship evidence. A
  governing rate is a financial control point;
- canonical loses governing source provenance, or produces more unattributed records;
- canonical introduces a duplicate identity;
- the two runs report source snapshot digests that do not correspond to the shared input, meaning
  no delta in the comparison is trustworthy;
- deterministic comparison fails.

**An empty blocking-delta count does not authorize promotion.** There is no field on a comparison
by which it can approve anything.

### 22.9 Operator disposition model

The report is Markdown, not JSON. Every blocking and review-required delta arrives with a
plain-language explanation, both authorities' values, the affected entity, its source evidence
(governing document, artifact, page where the source carries one), the automated classification,
the reason for that classification, and a disposition field. Informational deltas are counted but
not itemized: burying six blocking deltas under two hundred structural ones is how a review gets
skipped.

Operators record one of:

```text
canonical_correction | canonical_regression | expected_policy_difference
source_gap           | needs_more_evidence  | accepted_equivalent
```

Recording a disposition is **audit metadata**. It does not rewrite canonical truth, does not alter
a validation result, does not change a delta or its classification, and does not change which
authority serves. Dispositions are excluded from the comparison content digest, so annotating a
comparison does not change the identity of the comparison being annotated.

### 22.10 Comparison artifacts are audit evidence only

Artifacts are written to the existing private `canonical-shadow-artifacts` bucket under their own
top-level prefix:

```text
authority-comparison/project/{projectId}/input/{inputSnapshotDigest}/{contentDigest}.json
```

Deliberately **not** through `writeShadowArtifactParts`. Reusing the publisher's writer would put
comparison objects inside its `project/{id}/run/{runId}/` idempotency scope, where a second
publication id under one run fails closed â€” a comparison could then break, or be mistaken for, a
canonical publication. Separate prefixes make "comparison triggers duplicate publication"
structurally impossible rather than merely avoided. No migration is required.

Paths are content-addressed, so re-running an unchanged comparison lands on the identical path and
is suppressed as a duplicate. Failed comparisons are persisted too: recording only successes would
make a silently broken comparator look like a project with no divergences.

**Comparison storage is never an authority reader.** Nothing in the validation call graph imports
the comparison persistence module, and the architecture boundary test asserts it. The reader exists
for operator tooling only; no authority result may depend on reading storage back, the same rule
that governs canonical publication.

### 22.11 Architecture boundaries added

- comparison may call authority orchestration and the pure validator entry points;
- the authority layer, the publication layer, the canonical project layer, the rule packs, and
  extraction may not reference the comparison layer at all â€” not by import and not by identifier;
- `lib/validator/triggerProjectValidation.ts` is the single authorized production consumer, via
  exactly three frozen edges;
- comparison may not import UI, extraction, or serving persistence;
- the comparison orchestrator may not name a servable validation result type or reach a serving
  side effect;
- exactly one comparison normalization module and exactly one comparison orchestration entry point
  exist.

Existing seals were not loosened. Two narrow additions to the frozen canonical-production edge
list cover the authority-mode vocabulary reaching the validator and the three orchestrator edges.

### 22.12 Controlled rollout sequence

```text
repository fixtures
â†’ selected project cohort
â†’ repeated production comparisons
â†’ operator delta review
â†’ zero unexplained blocking deltas
â†’ controlled canonical serving enablement
â†’ rollback observation
â†’ later default change
```

Promotion requires operator acceptance of every material delta, not automated parity alone.
Legacy rollback remains available at every stage: `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=legacy`.

Operator harness:

```bash
node scripts/run-authority-comparison.mjs <projectId> [<projectId> ...]
```

Read-only with respect to validation. `--no-persist` suppresses even the audit artifact.

### 22.13 Updated deletion and promotion ledger

A15 adds no legacy path and removes none. It **raises the removal precondition** for every entry
in the Â§21.13 ledger: no legacy path may be deleted until the cohort has produced repeated
comparisons with zero unexplained blocking deltas and an operator has dispositioned every material
delta. Removing an entry while `legacy` is still a supported mode would eliminate the rollback and
must be rejected in review.

| # | A15 addition | Removal precondition |
|---|---|---|
| C1 | Comparison layer (`lib/canonical/comparison/`) | Removable once canonical is the only mode and the shadow phase is closed; removing it never affects a serving result |
| C2 | Comparison audit artifacts under `authority-comparison/` | Retained as the evidence trail for the promotion decision |

### 22.14 Operator procedure

Serving authority and publication procedures are unchanged from Â§20.5 and Â§21.14.

To run the shadow phase:

1. Keep `EIGHTFORGE_PROJECT_TRUTH_AUTHORITY=legacy`.
2. Set `EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE=allowlist` and
   `EIGHTFORGE_CANONICAL_AUTHORITY_COMPARE_PROJECTS` to the cohort project ids.
3. Read the report for each project. Disposition every blocking and review-required delta.
4. A comparison reporting `canonical_blocked` is reporting a real source gap in a named truth
   domain, not a comparison failure. Read `blockedTruthDomains` and the per-domain reason rather
   than re-running.
5. A comparison reporting `comparison_failed` means the comparison itself could not complete. The
   serving result for that run was unaffected.
6. Do not treat `equivalent` as authorization to promote.
