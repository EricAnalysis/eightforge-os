# Decision Consequence Auditing — Phase A Audit (Priority 4)

**Audit date:** 2026-07-22
**Scope:** Per-finding and amount-delta consequence auditing — can EightForge reconstruct, for a specific operator decision, which findings were added/changed/resolved and how blocked exposure changed as a result?
**Status:** Audit only. No implementation, no schema, no live mutation. Source read this session. Inferences marked **[inferred]**.
**Origin:** Roadmap item 4; Forge-lifecycle audit P2-4 ("revalidation-resolved findings are under-audited"), concretely reproduced earlier on Williamson invoice 2026-003 line 4.

---

## 1. Executive summary

The loop **mutates and revalidates correctly**; what is thin is the **audit reconstruction** of *why* a downstream number moved. Precisely:

- **Amount deltas are reliably reconstructable.** `project_approval_snapshots` persists real numeric `blocked_amount` / `at_risk_amount` / totals per run, append-only, and `buildApprovalTimeline` already diffs consecutive snapshots into live events on `/projects/[id]/approval-history`. This half works.
- **Finding-level deltas are not reliably reconstructable.** The snapshot's `finding_ids` are pseudo-ids (`finding-<check_key>` from decision-eligible pending actions only), not the canonical open-finding set. `blocking_reasons` and `billing_group_ids` are hardcoded empty (TODOs).
- **Per-finding resolution is unaudited on two of three closure paths.** The manual-rate-link path emits a per-finding `override_applied` event (the good pattern). The **revalidation-driven** path (`markStaleOpenFindingsResolved`) and the **decision-driven** path (`closeDecisionLinkedWork`) bulk-`UPDATE ... status='resolved'` with **no per-finding activity event** — only an aggregate `resolved_findings` count on `validation_run_completed`.
- **Attribution is broken at the trigger boundary.** `triggerProjectValidation(projectId, source, userId)` carries only the trigger *type* (`override_applied`, `relationship_change`, …) and actor — never the triggering decision/link/finding id. Snapshots store only `validation_trigger_source`, no `run_id`, no triggering entity, no actor. So a snapshot delta cannot be joined to the specific decision that caused it.
- **The delta calculator already exists but is dead code.** `compareApprovalSnapshots` (finding-set + amount diff) and `getApprovalHistory` are defined and **called nowhere**.

**Bottom line:** the raw material is ~70% present. The gap is (a) emit the two missing per-finding events, (b) thread the triggering decision/run through to both the finding events and the snapshot, (c) stop deriving snapshot `finding_ids` from pseudo-ids. This is achievable **with at most three nullable additive columns**, and the per-finding events need **no schema at all** (they ride existing `activity_events`).

## 2. The path, end to end (with evidence)

| Stage | Mechanism | Recorded today? |
|---|---|---|
| Operator decision | e.g. decision status → `finalizeDecision` (`decisionClosure.ts:228`); manual link → `insertManualRateLink`; fact override → override route | Decision: one `status_changed` event on the `decision` entity (`decisionClosure.ts:266`, old/new decision status). Manual link: per-finding `override_applied` (`manualRateLinkClosure.ts:246-261`). Fact override: `override_applied` on the fact. |
| Canonical mutation | decision closes linked findings (`closeDecisionLinkedWork:126-136`, bulk `UPDATE` by `linked_decision_id`); manual link writes `invoice_line_rate_links`; override writes fact | Findings updated in place. **No per-finding event on the decision-driven bulk close.** |
| Revalidation trigger | `triggerProjectValidation(projectId, source, userId)` (`triggerProjectValidation.ts:528`) | Trigger *type* + actor only. **No triggering entity id.** |
| Finding recomputation | `persistValidationRun`: reuse-by-check_key, `markStaleOpenFindingsResolved` (`persistValidationRun.ts:671-698`), historical-resolved suppression | `validation_finding_generated` per **new** finding (`:886-919`). **No `validation_finding_resolved` / `_changed` event** — stale-resolve is a bulk `UPDATE`. `diffFindings` (`:331-356`) *computes* the added/resolved identity sets but emits only **counts**. |
| Exposure recalculation | `exposure.ts` in the run → `validation_summary_json.exposure` (canonical current state) | `blocked_amount` / `at_risk` land in the summary and the snapshot. Reliable numerically. |
| Audit persistence | `persistApprovalSnapshot` (`approvalSnapshots.ts:95`) inside the run (`persistValidationRun.ts:1296`); `validation_run_completed` event (`:851-884`) | Snapshot per run (append-only). Run event with aggregate `new_findings`/`resolved_findings`. **Snapshot carries no run_id / decision_id / actor.** |
| Delta reconstruction | `buildApprovalTimeline` (`approvalTimeline.ts:72`) diffs consecutive snapshots → `/approval-history` | Amount/status/invoice-count deltas: **live**. Finding-set deltas: `compareApprovalSnapshots` exists but **dead**; `blocking_reason_added/resolved` event types declared but never produced at project level. |

## 3. What is already recorded (assets to reuse — do not rebuild)

1. **Append-only numeric snapshots** with `blocked_amount`, `at_risk_amount`, `total_billed/supported`, invoice-status counts (`20260602001000_create_approval_snapshots.sql`). Migration header already states the correct contract: *"append-only audit snapshots; no validator truth is derived from them."* — i.e. historical evidence, not canonical state. This is the right home; keep it.
2. **`buildApprovalTimeline`** — a working consecutive-snapshot differ, already wired to a page. Amount deltas are done.
3. **`validation_finding_generated`** per-finding event — the shape to mirror for resolution/change events (`persistValidationRun.ts:886-919`: check_key, rule_id, severity, problem/impact/required_action).
4. **`override_applied`** per-finding event from the manual-link path (`manualRateLinkClosure.ts:246-261`: old `{status, rule_id}` → new `{status, closure_method, contract_rate_row_id, reason}`). **This is the exemplar** — the other two closure paths should emit the analogous event.
5. **`diffFindings`** (`persistValidationRun.ts:331-356`) — already computes the added/resolved open-finding identity sets each run. The per-finding data exists in memory; only the emission is missing.
6. **`compareApprovalSnapshots` + `ApprovalSnapshotDiff`** (`approvalSnapshots.ts:250-289`) — a ready delta type/calculator, currently dead.

## 4. What attribution is missing

| Gap | Location | Consequence |
|---|---|---|
| **G1 — no per-finding resolution event (revalidation path)** | `markStaleOpenFindingsResolved` (`persistValidationRun.ts:671-698`) | Cannot list *which* findings a revalidation resolved; only an aggregate count. This is P2-4, reproduced on 2026-003 line 4. |
| **G2 — no per-finding resolution event (decision path)** | `closeDecisionLinkedWork` (`decisionClosure.ts:125-143`) | A decision that closes 5 findings leaves one decision `status_changed` event and no per-finding trail. |
| **G3 — snapshot has no causal attribution** | `project_approval_snapshots` schema + `persistApprovalSnapshot` call (`persistValidationRun.ts:1296`) | A snapshot delta cannot be joined to its run, triggering decision, or actor. Only `validation_trigger_source` (a type). |
| **G4 — trigger boundary drops the entity** | `triggerProjectValidation(projectId, source, userId)` | The decision/link/fact that caused the run is known at the call site but never propagated into the run or snapshot. |
| **G5 — snapshot `finding_ids` are pseudo-ids** | `persistApprovalSnapshot:118-119,132` (`pending_actions.map(a => a.id)` = `finding-<check_key>`, decision-eligible only) | Finding-set diff is partial and mislabeled; `compareApprovalSnapshots` cannot be trusted for real finding identity. |
| **G6 — snapshot `blocking_reasons` / `billing_group_ids` never populated** | `approvalSnapshots.ts:133,159` (TODOs) | Invoice-level "why blocked" evidence is absent. |
| **G7 — two parallel, uncorrelated audit streams** | `activity_events` vs `project_approval_snapshots` | Per-entity events and amount snapshots share no join key (both keyed only by project + time). |

## 5. Can existing snapshots calculate reliable before/after deltas?

- **Amounts (blocked / at-risk / totals): YES, reliably.** Real numeric columns, append-only, `buildApprovalTimeline` already does it. Caveat: deltas are *per run*, so if two decisions land between runs (or a `manual` full run occurs), the amount delta is real but **unattributable to one decision** without G3/G4.
- **Finding-set (added / changed / resolved): NO, not reliably from snapshots.** `finding_ids` are pseudo-ids limited to decision-eligible pending actions (G5). The *reliable* source is `diffFindings` at run time + the per-finding events that don't yet exist (G1/G2). Reconstruction should come from the **event stream**, not from snapshot `finding_ids`.
- **Attribution to a specific decision: NO.** Blocked at G3/G4.

## 6. Recommended smallest canonical model

**Governing principle (from the brief): historical audit evidence ≠ current canonical state; do not create a parallel truth source.** Current state stays exactly where it is — `project_validation_findings.status` and `validation_summary_json.exposure` remain the single source of truth for "what is blocked now." The consequence record is **append-only historical evidence** that *references* canonical ids; it never re-asserts current state and nothing reads validation truth from it.

Two layers, smallest first:

**Layer 1 — per-finding lifecycle events (NO schema).** Emit, on both bulk closure paths, the resolution/change event that the manual-link path already emits:
- `validation_finding_resolved` (and `validation_finding_changed` for in-place severity/status shifts) on `activity_events`, entity = the finding, mirroring `validation_finding_generated` and `override_applied`.
- Carry `old_value`/`new_value` (status, business_severity, `affected_amount` contribution) plus the correlation keys from Layer 2. Source the identity from the rows already being updated / from `diffFindings`.
- This alone closes G1, G2, and makes finding-set reconstruction reliable from the event stream (retiring reliance on G5's pseudo-ids).

**Layer 2 — causal attribution (≤3 nullable additive columns, no backfill).**
- Thread an optional **triggering-entity descriptor** through `triggerProjectValidation` → `persistValidationRun` → both the finding events and the snapshot: `{ trigger_source, trigger_entity_type, trigger_entity_id, actor_id }`. `trigger_source` and actor already flow; only `trigger_entity_type`/`trigger_entity_id` are new, and callers (`requestDecisionStatusRevalidation`, the manual-link route, the override route) already know them.
- Add nullable `run_id uuid`, `triggering_decision_id uuid` (nullable — not every trigger is a decision), `created_by uuid` to `project_approval_snapshots`. All additive, nullable, no backfill, no CHECK drift. This gives every snapshot a join key to its run, its per-finding events (which carry `run_id`), and its actor — making the amount delta attributable.
- Fix G5 at the same time: populate snapshot `finding_ids` from the canonical open-finding UUID set (available in `persistValidationRun`), not pseudo-ids. Optionally populate `blocking_reasons` (G6) from the same normalized findings.

**Explicitly deferred:** persisting a materialized "decision consequence" row (a joined decision→findings→delta record). It is **not needed** — Layer 1 + Layer 2 make it a pure query over `activity_events` + `project_approval_snapshots` joined on `run_id`/`trigger_entity_id`. Persisting it would be the parallel-truth risk the brief warns against. Revive `compareApprovalSnapshots` as the read-side calculator instead of a new table.

## 7. Exact writers and readers affected

**Writers (Phase B will touch):**
- `lib/validator/persistValidationRun.ts` — emit `validation_finding_resolved` in `markStaleOpenFindingsResolved`; pass canonical `finding_ids` + attribution into `persistApprovalSnapshot`; thread trigger entity.
- `lib/server/decisionClosure.ts` (`closeDecisionLinkedWork`) — emit per-finding resolution events for `closedFindingIds`.
- `lib/server/approvalSnapshots.ts` — accept + persist `run_id`/`triggering_decision_id`/`created_by`; populate real `finding_ids`; optionally `blocking_reasons`.
- `lib/validator/triggerProjectValidation.ts` + `lib/validator/revalidationRequests.ts` — carry an optional trigger-entity descriptor.
- Callers already holding the entity: `app/api/decisions/[id]/status/route.ts`, `app/api/projects/[id]/invoice-line-rate-link/route.ts`, `app/api/documents/[id]/facts/override/route.ts`.
- (Schema, Layer 2) one additive migration for the three nullable snapshot columns.

**Readers (benefit; mostly unchanged):**
- `lib/server/approvalTimeline.ts` (`buildApprovalTimeline`) — can attribute events and surface finding-level added/resolved once events exist.
- `app/projects/[projectId]/approval-history/page.tsx`, `components/ApprovalHistoryTimeline.tsx` — richer, attributed timeline.
- `lib/resolveProjectIssueObjects.ts` `auditChain` — already ingests `activity_events`; the new per-finding events flow in for free.
- `compareApprovalSnapshots` — revived as the delta read helper.
- Not affected / must stay canonical: `projectFacts`, `validation_summary_json`, `project_validation_findings.status`.

## 8. Falsification — the loop is not broken, only under-recorded

The manual-rate-link path already does the right thing end to end: it mutates canonical truth, closes the finding, **and emits a per-finding `override_applied` event with old/new state and the causal `contract_rate_row_id`/`reason`**. And `buildApprovalTimeline` already reconstructs amount deltas live. Phase B is **extending an existing, working pattern to the two paths that predate it**, plus adding the join key — not building a new audit system.

---

*Inferred, not proven this session: that no other caller populates snapshot `blocking_reasons` (grep found only the TODO); that `blocking_reason_added/resolved` timeline event types are never produced at project level (loop inspection, not exhaustive of `getInvoiceTimelineEvents`). Confirm both at Phase B start.*
