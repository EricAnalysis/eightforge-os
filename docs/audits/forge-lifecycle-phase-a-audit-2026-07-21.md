# EightForge Forge Lifecycle — Phase A Architecture & Behavior Audit

**Audit date:** 2026-07-21
**Scope:** Overview, Documents, Validator/Decision & Execution, Audit — full lifecycle: Documents → Facts → Validation → Decisions/Actions → Canonical Truth → Revalidation → Audit.
**Constraints honored:** Audit only. No code implemented, no live data mutated, no Golden Project revalidation, no manual rate links or operator decisions created, no test/fixture changes.
**Evidence basis:** Source reading this session, plus the confirmed live-payload evidence in `invoice-line-normalization-boundary-2026-07-21.md` (§2a) and `financial-rate-code-manual-link-resolution-audit-2026-07-20.md`. Claims that rest on those docs rather than a fresh live query are marked **[carried]**. Claims inferred rather than proven are marked **[inferred]**.
**Working-tree note:** Uncommitted changes exist implementing the invoice-line boundary fix (`lib/validator/effectiveInvoiceLineCompletion.ts` + wiring in `projectValidator.ts`). This audit evaluates both the committed state and that pending change.

---

## 1. Executive verdict: **PARTIAL**

EightForge is architecturally a closed-loop system, and the loop **demonstrably completes end-to-end for several real workflows** (§8 falsification). The infrastructure the Forge invariant requires — effective-fact precedence, canonical relationship tables, decision-triggered revalidation, stale-finding auto-resolution, activity events — all exists and is wired. The failures are boundary and edge failures, not missing architecture:

1. **One canonical boundary substitutes un-normalized data for canonical rows** (the `applyEffectiveInvoiceFacts` invoice-line boundary) — the single confirmed P0, with a fix already in the working tree, uncommitted and unverified.
2. **One decision path closes findings without triggering revalidation** (manual rate link), leaving exposure/Overview stale until an unrelated trigger fires.
3. **Three different "blocked" predicates** still feed different surfaces.
4. **Revalidation-driven finding resolution is under-audited** (aggregate count only, no per-finding event).

None of these justify a rewrite. All are strengthenings of existing infrastructure.

## 2. Forge lifecycle diagram (as built)

```
Documents (upload) ──► pipeline normalizeNode / jobs process
        │ writes: document_extractions (blob + typed_fields), fact rows
        │ triggers: triggerProjectValidation('document_processed')  [jobs/process route:234]
        ▼
Canonical Facts
  effective-fact precedence (lib/effectiveFacts.ts:20-29):
    human_override > human_review > canonical_correction >
    canonical_contract_intelligence > normalized_row >
    legacy_structured_field > legacy_typed_field > legacy_section_signal
  + canonical invoice rows (invoiceParser.buildCanonicalInvoiceRowsFromTypedFields)
  + canonical contract rates (assembleContractPricingRows → buildRateScheduleItems)
  + canonical relationships (invoice_line_rate_links, manual > automated matcher)
        ▼
Validator (lib/validator/projectValidator.ts)
  loads facts + reviews + overrides + manual links per run
  rule packs → findings → persistValidationRun:
    - re-uses open finding rows by check_key (stable identity)
    - markStaleOpenFindingsResolved (:671) — conditions that cleared auto-resolve
    - historical-resolved suppression (:1108-1120) — operator closures survive reruns
    - writes projects.validation_status + validation_summary_json (:921-937)
    - syncExecutionItems, syncValidatorDecisions, approval snapshot, activity events
        ▼
Decisions / Actions
  fact review/override  ──► triggerProjectValidation          [facts/review route:190, facts/override route:195]
  decision resolved/dismissed ──► requestDecisionStatusRevalidation [decisions/[id]/status:145]
  decision feedback     ──► requestDecisionFeedbackRevalidation
  execution outcome     ──► triggerProjectValidation          [execution-items/[id]/outcome:348]
  document precedence   ──► requestDocumentPrecedenceRevalidation
  manual rate link      ──► ✗ NO revalidation trigger         [invoice-line-rate-link route — gap §6.2]
        ▼
Revalidation ──► Overview (validation_summary_json snapshot) / Documents / Audit (activity events, approval snapshots)
```

## 3. Section A — Canonical ownership map

| Concept | Authoritative source | Writers | Readers | Type | Invalidation |
|---|---|---|---|---|---|
| Document extraction | `document_extractions` (blob + `typed_fields`) | pipeline normalizeNode, jobs/process | validator input loading, documentIntelligenceViewModel | authoritative (raw) | reprocess |
| Typed fields | `typed_fields` on extraction row | extractor only | fact assembly (`projectValidator.ts:1269-1281`, source `legacy_typed_field`) | authoritative for extraction-asserted values; lowest-but-one precedence | reprocess |
| Fact reviews (confirm/correct) | `document_fact_reviews` (`reviewed_value_json`) | `app/api/documents/[id]/facts/review` | validator (`human_review`), Documents viewmodel | authoritative operator attestation | review route triggers revalidation |
| Fact overrides | fact override rows | `app/api/documents/[id]/facts/override` | validator (`human_override`, top precedence), Documents | authoritative operator assertion | override route triggers revalidation |
| Effective facts | **derived** per run via `collapseEffectiveFactRecords` (`lib/effectiveFacts.ts:167`) | — (pure function) | validator, Documents viewmodel, Ask | derived; the one permitted merge point | recomputed every run — never persisted, so never stale |
| Canonical invoice rows | `buildCanonicalInvoiceRowsFromTypedFields` + `applyEffectiveInvoiceFacts` boundary | — (derived per run) | all financial rule packs, exposure, reconciliation | derived | recomputed every run |
| Contract rate rows | `assembleContractPricingRows` → `buildRateScheduleItems` (`projectValidator.ts:1398-1476`) | — (derived from contract docs) | rate matching, manual-link picker endpoint | derived, single assembler (confirmed by prior assembler audit) | recomputed every run |
| Invoice↔contract relationship | `invoice_line_rate_links` (supersession chain) **[carried]** | `insertManualRateLink` via rate-link POST | `buildManualRateLinkOverrides` → all consuming rule packs + `exposure.ts:428-433` | **authoritative operator relationship**, outranks automated matcher | reloaded every run; **no immediate revalidation trigger (§6.2)** |
| Findings | `project_validation_findings` (+ evidence) | persistValidationRun, closure services | Validator UI, projectFacts, execution sync, Overview counts | derived-from-truth, persisted with status lifecycle | revalidation reconciles by `check_key` |
| Decisions | `decisions` | forgeDecisionGenerator, syncValidatorDecisions, finalizeDecision | decision routes, Decision & Execution panel | authoritative operator intent | status route triggers revalidation |
| Execution records | `project_execution_items` | `syncExecutionItems` (from findings), outcome route | execution queue, rollups | derived queue projection | outcome route triggers revalidation |
| Audit events | activity events via `logActivityEvent` + `persistApprovalSnapshot` | every write path above | Audit forge, ApprovalHistoryTimeline | authoritative, append-only | n/a |
| Overview metrics | `projects.validation_status` + `validation_summary_json` (`persistValidationRun.ts:921-937`) | persistValidationRun only | `projectOverview.ts:541-542`, `ProjectOverview.tsx:1434` | **derived snapshot (cache)** | refreshed only by a validation run — stale window between decision write and next run |

**Domain objects with more than one active representation (Section A.4):**

- **Invoice lines — three active representations.** (a) presentational blob path (`InvoiceSurface` → `buildInvoiceLedgerLineDisplay`), (b) canonical typed-fields path (`normalizeTypedInvoiceLine`), (c) effective-fact substitution at `applyEffectiveInvoiceFacts` which, on committed main, injects raw `typed_fields.line_items` verbatim — un-normalized, missing 5 of 7 canonical contract fields live **[carried]**. This is the P0 (§6.1). The working-tree `effectiveInvoiceLineCompletion.ts` closes it additively.
- **"Blocked" counts — three predicates** (§6.3).
- **Overview metrics vs live findings** — snapshot vs query; by design, but the snapshot only refreshes on validation runs (§6.2 makes this observable).

**Prohibited parallel paths found:** only the invoice-line boundary above. Rate assembly, effective facts, and relationship resolution each have a single assembler. The Documents blob parser is a permitted *presentational* view but has independently richer recovery than the validator path for thin-blob documents (recovery gap at `projectValidator.ts:1635`, real but inert for Williamson 2026-002 — see `invoice-line-code-recovery-validator-gap-2026-07-21.md` §5).

## 4. Section B — Surface alignment matrix

| Concept | Overview | Documents | Validator | Audit | Aligned? |
|---|---|---|---|---|---|
| Validation status | `validation_summary_json` snapshot | operational status resolver (processing + review + counts) | live findings + run summary | `validation_run_completed` events | Yes, with snapshot lag |
| Invoice line values | via summary (exposure totals) | blob/presentational parser (recovery active) | effective-fact boundary (defective on main; fixed in working tree) | evidence rows per finding | **No on committed main** — Documents shows `5A`/`6A`, Validator reports missing **[carried]** |
| Contract rates | summary rollup | contract surfaces (same assembler) | `buildRateScheduleItems` (same assembler) | evidence anchors | Yes |
| Manual rate link | ✗ not reflected until next run | ✗ not surfaced on Documents | injected every run; suppresses both dependent rules | `override_applied` event w/ old/new (`manualRateLinkClosure.ts:246-261`) | Partial |
| Exposure / blocked amounts | snapshot `exposure` block | n/a | computed per run (`exposure.ts`), manual link honored (:428-433) | not recorded per-change | Partial — stale between link and next run |
| Blocker counts | operationalQueue tier predicate | operational status | `blockerFindingCount` (disposition) | run summary counts | **No — three predicates (§6.3)** |
| Operator corrections | reflected after revalidation | reviews/overrides visible in viewmodel; distinguishes sources | consumed at top precedence | review/override activity events | Yes |

## 5. Section C/E — Decision propagation matrix

| Workflow | Canonical change | Revalidation trigger | Dependent findings | A (close record) vs B (correct truth) |
|---|---|---|---|---|
| 1. Missing invoice rate code (false positive, 2026-002) | none needed — data exists as `line_code`; boundary must complete it | n/a | `FINANCIAL_RATE_CODE_MISSING` ×6 will auto-resolve via `markStaleOpenFindingsResolved` once the boundary fix lands and a run executes | **B** (pending working-tree change) |
| 2. Manual line→rate confirmation | `invoice_line_rate_links` row (supersession chain) | **✗ missing** — direct closure only | both `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` and `FINANCIAL_RATE_CODE_MISSING` closed by closure service; both *suppressed at generation* on rerun (rule packs consult `match_source_kind: 'manual_link'`) | **B for durability, A for immediacy** — the immediate close is a status mutation; correctness restored on next run |
| 3. Contract rate mismatch | operator picks: fix mapping (workflow 2) or correct fact (workflow 8) | per chosen path | rate-verification + financial rules recompute from same canonical inputs | B |
| 4. Missing contract relationship | manual link or document precedence change | precedence route triggers; link route doesn't | relationship-dependent rules recompute | B |
| 5. Corrected quantity/price | `corrected` review with `reviewed_value_json` → `human_review` effective fact | facts/review route:190 | all financial/reconciliation rules recompute; totals recompute | **B — the model path** |
| 6. Corrected identity field | same review path | same | identity_consistency rules recompute | B |
| 7. Confirmed extraction, no payload | review row, `reviewed_value_json = null`; validator skips (`projectValidator.ts:1319-1325`) — zero canonical effect on main | route triggers a run, but nothing changes | none | **Neither on main** — attestation is inert; working-tree completion honors it additively per adopted precedence rule |
| 8. Corrected review with payload | replacement value at `human_review` precedence | yes | recompute; array facts collapse by row identity (`effectiveFacts.ts:113-137`) preserving row IDs | B |

**Cross-finding behavior (Section E):** correct in architecture. Findings reference stable canonical subjects (`check_key`, subject IDs); one canonical correction resolves multiple findings **through shared recomputation** (rule packs independently consult the same manual link / effective fact), not bulk-closure. The manual-link closure service does mutate status directly, but only for the two findings whose shared root cause the link resolves, and generation-time suppression makes the closure consistent with recomputation. Residual risks:
- A finding **can remain open** after correction until a revalidation run fires (workflow 2, because of the missing trigger).
- A finding **can stay closed while its condition persists**: `isSameClearedFinding` (`persistValidationRun.ts:305-319`) deliberately suppresses re-emission of an operator-resolved finding with identical signature. This is operator-precedence by design, but it is exactly the mechanism that would have permanently masked the six false positives had the operator "resolved" them with manual links — validating the operator note in both July audits.
- If a superseding link is later created, the old link is superseded in the chain **[carried]**; findings re-evaluate against the new link on next run. No stale-link consumption path found.

## 6. Broken-loop inventory (ranked)

### P0-1 — Invoice-line normalization boundary (missing normalization boundary / parallel truth)
- **Where:** `projectValidator.ts` `applyEffectiveInvoiceFacts` (committed main); fix present in working tree via `completeEffectiveInvoiceLineCanonicalFields`.
- **Current:** effective `line_items` facts replace canonical rows with raw extractor output; `rate_code`, `invoice_rate_key`, `line_code_resolution`, `canonical_category`, `category_confidence` absent live **[carried]** → six false `FINANCIAL_RATE_CODE_MISSING` findings; Documents and Validator disagree.
- **Expected:** every line entering the Validator satisfies the canonical contract, additively completed, operator values immutable (the §6/§7 invariants of the 2026-07-21 boundary audit — this audit endorses them verbatim).
- **Correction:** the working-tree change is the right shape (additive-only, provenance-carrying, operator > derived). **It is uncommitted and its verification gates have not been run.** Minimal next step: run the required tests (boundary + completion suites, financialIntegrity, exposure, inputLoading), confirm Golden anchors unmoved, commit. Architectural, already scoped.
- **Regression tests:** as listed in boundary audit §7a; both new test files exist in the working tree.

### P1-2 — Manual rate link creates no revalidation (missing invalidation edge)
- **Where:** `app/api/projects/[id]/invoice-line-rate-link/route.ts:143-168` — closes findings, returns; no `triggerProjectValidation`.
- **Current:** exposure, `validation_summary_json`, Overview totals, execution items, and validator status reflect the link only after some *other* trigger causes a run.
- **Expected:** every canonical change invalidates and recomputes dependent outputs.
- **Risk:** operator confirms a mapping, Overview still shows blocked amount/exposure; surfaces disagree about effective state for an unbounded window.
- **Correction (local):** `void triggerProjectValidation(projectId, 'override_applied', actorId)` after closure, mirroring `facts/override/route.ts:195`. Test: link POST → run triggered → exposure/summary reflect link.

### P1-3 — Three "blocked" predicates (cross-surface inconsistency)
- **Where:** `lib/server/operationalQueue.ts:810` (`executionItemIsBlockedTier`: exec status open ∨ severity critical) vs `lib/validator/findingSemantics.ts:689` (`blockerFindingCount`: disposition after normalize) vs `resolveProjectIssueObjects.lifecycleForIssue` (no-decision ∧ isBlocker). Documented with live divergence in `EIGHTFORge_STATE_MACHINE_PHASE_A_AUDIT.md` §4; predicates still present today. **[inferred that live divergence persists — not re-measured this session]**
- **Expected:** one canonical "blocks approval" computation feeding every surface.
- **Correction (architectural, already proposed):** the state-machine audit's Phase B proposal (persist canonical `operational_state`/`blocks_approval`, single derivation site). Adopt rather than redesign.

### P2-4 — Revalidation-resolved findings are under-audited (incomplete audit trail)
- **Where:** `persistValidationRun.ts:671-698` (`markStaleOpenFindingsResolved`) — resolves rows with no per-finding activity event; only the aggregate `resolved_findings` count lands in `validation_run_completed` (:874).
- **Current:** Audit can say "3 findings resolved this run" but cannot reconstruct *which* findings, *what canonical change* resolved them, or the before-state — breaking the required "Audit can reconstruct decision → canonical change → downstream consequences" chain for the system's *best* resolution path (B-style recomputation).
- **Correction (local):** emit a `validation_finding_resolved` activity event per stale finding (mirror of `validation_finding_generated`, :886-919), carrying `check_key`, `rule_id`, prior severity, and the run's trigger source. Test in `persistValidationRun.test.ts`.

### P2-5 — Null-payload confirmation is canonically inert (committed main)
- **Where:** `projectValidator.ts:1319-1325` skip. Resolved conceptually by the adopted precedence rule (boundary audit §7); the working-tree completion honors confirmations additively. Folded into P0-1's landing.

### P2-6 — Validator-side invoice-line recovery disabled for thin-blob documents
- **Where:** `projectValidator.ts:1635` omits `extractionData`. Real gap, **inert for Williamson 2026-002** (recovery declines: `6 <= 6`). Keep the scoped fix from `invoice-line-code-recovery-validator-gap-2026-07-21.md` but do not present it as the false-positive fix.

### P3-7 — Inline rollup reconstruction inside persistValidationRun
- **Where:** `persistValidationRun.ts:1256-1292` hand-builds a "minimal ProjectOperationalRollup" (casts `as unknown as ProjectOperationalRollup`) for the approval snapshot instead of the shared rollup builder.
- **Risk:** snapshot rollup can drift from the real Overview rollup (e.g. `needs_review_document_count: 0` hardcoded). Page-agnostic but a rule-local reconstruction of a shared shape.
- **Correction:** reuse the shared rollup builder or narrow the snapshot's declared type to what is actually computed.

### P3-8 — Observability of decision consequences
- Manual-link audit event records old/new finding status and the chosen rate row (`manualRateLinkClosure.ts:246-261`) but not affected amounts/exposure deltas. Downstream consequences are *reconstructable* (run events + snapshots bracket the change) but not *recorded*. Acceptable; improve opportunistically with P2-4.

## 7. Section G — Golden Project anchors (read-only)

| Anchor | Origin | Propagation | Consumers | Status |
|---|---|---|---|---|
| 2026-002 codes 1A/1B/1E/1F/5A/6A | `typed_fields.line_items[].line_code` **[carried]** | boundary completion (pending) → `rate_code` → financial rules | financialIntegrity, rate matching, Documents ledger | Documents correct; Validator false-positive until P0-1 lands |
| 2026-003 Final Disposal $4.25 | contract row `exhibit_a_table:pdf:table:p8:t31:r3` **[carried]** | matched via description path (contract row's own `rate_code` null) | crossDocumentRateVerification (Resolved) | Legitimate manual-confirmation candidate |
| Vegetative $6.90/CY | contract rate assembler | `billing_rate_key` exact-key match survives the defective boundary **[carried]** | rate verification, exposure | Correct |
| CYD 74,617 (ticket-grain) | transaction dedup by raw Ticket No | ticket-grain guard tests | reconciliation, Overview | Gate green (`transactionQuantityGrainIntegrity.test.ts`) |
| Extended Cost $815,559.35 (row-grain) | invoice rows → exposure `total_billed` | summary snapshot → Overview | `projectFacts.test.ts:874+`, `projectOverview.rollup.test.ts:782` | Gate green |

No Golden expected values changed by this audit.

## 8. Falsification — where the loop already completes correctly

The main diagnosis ("closed loop with boundary defects") was tested against paths that work end to end. These are the **preferred patterns** for fixing the broken ones:

1. **Fact override → revalidation → recomputation → snapshot → audit.** Override route writes canonical override, fires `requestFactOverrideRevalidation`, validator consumes it at top precedence, `markStaleOpenFindingsResolved` clears dependent findings, snapshot and activity events update. This is the complete B-style loop. *Pattern for P1-2: the rate-link route should end the same way.*
2. **Manual rate link durability (Pass 2).** Canonical relationship persisted with supersession, reloaded every run, outranks the matcher, consumed by three independent consumers (two rule packs + exposure) that each recompute rather than trusting closed status. *Pattern for cross-finding propagation generally: shared dependency, independent recomputation.*
3. **Finding identity stability.** `check_key` reuse in `persistFinding` keeps finding IDs stable across runs, preserving decision/execution links and audit continuity through recomputation.
4. **Overlap suppression at generation** (`suppressOverlappingMissingContractRateFindings`) resolves duplicate-root-cause findings by not generating them — not by closing them.

## 9. Proposed system invariants (evaluated)

| Invariant | Holds today? |
|---|---|
| Every extracted fact has one effective canonical representation | Yes except invoice-line boundary (P0-1; fix pending) |
| Every downstream consumer reads effective canonical truth | Yes for validator/Documents/Ask; Overview reads a declared derived snapshot (acceptable if invalidation is complete — see next) |
| Every operator decision writes canonical truth, not merely finding status | Yes (reviews, overrides, links); manual-link path *also* status-closes for immediacy, backed by generation-time suppression — acceptable hybrid |
| Every canonical change invalidates and recomputes dependent outputs | **No — manual rate link (P1-2)**; all other write paths trigger |
| One correction resolves multiple findings only via shared recomputation | Yes (with the bounded closure-service exception) |
| Operator-asserted outranks system-derived | Yes — precedence order + manual-link precedence + additive completion rule |
| Derived values carry provenance | Partial — `line_code_resolution`/`rate_code_origin` (pending), `match_source_kind`, effective-fact `source` all exist; `canonical_category` recomputation is silent |
| Row/subject identity stable through normalization | Yes (`fact:<doc>:line:N` preserved by completion helper; `check_key` stable) |
| Overview/Documents/Validator/Audit cannot disagree about effective state | **No** — snapshot lag (bounded once P1-2 closes) + blocked-count divergence (P1-3) |
| Audit can reconstruct before-state, decision, canonical change, consequences | Partial — decision events strong; revalidation-resolution events missing (P2-4) |

## 10. Recommended phased roadmap

1. **Immediate correctness:** verify + land the working-tree boundary fix (P0-1) with its full test list; run Golden gates. Then a single revalidation of Williamson should naturally resolve the six false positives — *without* manual links.
2. **Canonical boundary:** land the thin-blob recovery threading (P2-6) as its own scoped change per the existing Codex prompt.
3. **Decision propagation:** add the revalidation trigger to the rate-link route (P1-2). One-line change + one integration test.
4. **Surface alignment:** adopt the state-machine audit's Phase B (canonical `blocks_approval`/operational state, single predicate) to close P1-3; replace the inline rollup reconstruction (P3-7).
5. **Observability/audit:** per-finding `validation_finding_resolved` events (P2-4); optionally record exposure delta on manual-link closure (P3-8).
6. **Optional UX:** surface active manual links and completion provenance (`rate_code_origin`) on Documents so operators can distinguish extracted vs derived vs confirmed values in place.

---

*Every conclusion resting on live-payload data is carried from the 2026-07-20/21 audits rather than re-queried, per the no-live-mutation constraint. The persistence of the blocked-count divergence magnitude is inferred from code presence, not re-measured.*
