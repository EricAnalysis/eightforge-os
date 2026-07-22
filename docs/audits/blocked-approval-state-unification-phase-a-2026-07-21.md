# Blocked / Approval State Unification — Phase A Audit

**Audit date:** 2026-07-21
**Scope:** The divergent "is this blocked / is this an approval blocker" computations across Overview, Command Center, Validator, and the Project Decisions issue board.
**Status:** Audit only. No implementation, no schema, no live mutation. All conclusions are from source read this session; anything inferred rather than proven is marked **[inferred]**.
**Origin:** Roadmap item 2 after `16ee7f8`. Extends `EIGHTFORGE_STATE_MACHINE_PHASE_A_AUDIT.md` §4 (which measured the live ~106 vs ~62 vs 0 divergence in June) and the Forge-lifecycle audit P1-3.

---

## 1. Executive summary

"Blocked" is computed **four** ways, not three. They fall into two groups:

- **Group A — already converged (the success pattern).** `isBlockingFinding` / `blockerFindingCount` (findingSemantics) → `buildValidationSummary` → persisted `validation_summary_json` → `approvalBlockerCountForProjectFacts` / `commandCenterApproval.is_blocked`. Overview header and Command Center **already read the same persisted summary on purpose** (`commandCenterApproval.ts:13-17` documents this explicitly). This is the reference pattern; do not disturb it.

- **Group B — the two survivors that still diverge from Group A:**
  - **B1 — execution-item tier** (`executionItemIsBlockedTier`, `operationalQueue.ts:810`): a *second, additive* blocked count merged into the rollup on top of the findings-based one, over a **different persisted representation** (`project_execution_items`) that can drift from the findings it was synced from.
  - **B2 — issue-board lifecycle** (`isBlocker` + `lifecycleForIssue`, `resolveProjectIssueObjects.ts:239-255`): uses a **wider predicate** (adds raw `finding.severity === 'critical'`) but a **narrower scope** (only counts as `blocked` when the finding has **no decision**).

The core defect is not the predicate expression — Group A is a fine predicate. It is that **three different subject sets** (open findings / execution items / issue objects) each re-answer "blocked" with slightly different rules, and two of them are not fed by the converged Group A summary.

**Recommended canonical model:** one persisted, per-finding `approval_gate_effect` already exists on the finding contract and is already the Group A basis. The fix is **not a new schema column** — it is to make B1 and B2 *derive from the same finding-level `approval_gate_effect`* rather than re-deriving from raw severity (B2) or from a parallel execution-item representation (B1). A new persisted `operational_state` column (the June proposal) is **larger than necessary** and is not recommended as the first move. See §5.

---

## 2. The four computations, precisely

| # | Function | File:line | Subject | Predicate basis | Status filter |
|---|---|---|---|---|---|
| A1 | `isBlockingFinding` / `blockerFindingCount` | `findingSemantics.ts:676, 689` | a `ValidationFinding` | `normalize(f).approval_gate_effect === 'blocks_approval'` ⟺ `finding_disposition === 'blocker'` ⟺ `business_severity === 'critical'` (all three are the same signal after `normalizeValidationFinding`) | caller filters `status === 'open'` |
| A2 | `approvalBlockerCountForProjectFacts` / `commandCenterApproval.is_blocked` | `projectFacts.ts:1423`, `commandCenterApproval.ts:31` | persisted `validation_summary_json` facts | `validator_blockers.length` (built from A1's `isBlockingFinding`), then fallbacks to `blocker_count`, `critical_count`, or MISMATCH/MISSING invoice count | reads persisted open-derived summary |
| B1 | `executionItemIsBlockedTier` | `operationalQueue.ts:810` | a `project_execution_items` row | `status !== 'resolved' && (status === 'open' \|\| severity === 'critical')` | `status !== 'resolved'` |
| B2 | `isBlocker` + `lifecycleForIssue` | `resolveProjectIssueObjects.ts:239, 254` | an issue object (finding, or synthesized-from-execution-item/decision) | `normalize(f).approval_gate_effect === 'blocks_approval' \|\| finding_disposition === 'blocker' \|\| **finding.severity === 'critical'**`, **but** lifecycle `blocked` only when `!decision` | operates over issue objects |

A third structural blocker path exists in `approvalGate.ts:321` (`isBlocked = hasCriticalFinding || reconciliation MISMATCH || at-risk > tolerance || …`). It **reuses A1** (`isBlockingFinding`, line 309) and adds exposure/reconciliation structure. It is internally consistent with Group A and is **not** a fourth divergent predicate — it is a richer gate built on the same finding signal. Note it for completeness; it is not in scope to change.

## 3. Why they diverge — three independent axes

**Axis 1 — subject double-representation (B1 vs A).** `syncExecutionItems` creates an execution item **only** for findings where `action_eligible && isBlockingFinding(finding)` (`syncExecutionItems.ts:335-339`), each inserted `status: 'open'` with `severity` derived from the finding. So execution items are a **persisted mirror of a subset of A1's blockers**. The rollup then **adds** `blockedTierCount` (B1) *on top of* the findings-derived `blocked_count` in `mergeProjectRollupWithExecutionItems` (`operationalQueue.ts:891-894`). The same root cause is counted once as a finding and again as its execution item — the mechanical source of the June "~106 (rollup+exec) vs ~62 (findings)" gap. **[inferred that the live gap persists at that magnitude — not re-measured this session; the additive code path is confirmed present.]**

**Axis 2 — predicate width (B2 vs A).** B2's `isBlocker` adds `|| finding.severity === 'critical'` (raw legacy severity) to A1's normalized signal. `normalizeValidationFinding` maps raw `severity: 'critical'` → `business_severity: 'critical'` **unless** a `RULE_SEMANTIC_OVERRIDES` entry downgrades it (e.g. a rule that pins `business_severity: 'medium'` while the row's raw `severity` is still `critical`). In that specific case **B2 says blocker, A1 says not** — the surfaces disagree on the same finding. This is a latent, rule-override-dependent disagreement, not a guaranteed-on-every-finding one.

**Axis 3 — decision gating (B2 vs A/B1).** B2's `lifecycleForIssue` returns `blocked` only when `!decision && isBlocker(finding)` (`:254`). Once any decision row exists for the issue, its lifecycle moves to `needs_verification` / `ready_for_authorization` and it **drops out of the `blocked` count** — even though A1 still counts the underlying finding as a blocker and B1 still counts its execution item as blocked-tier until resolved. This is why the June snapshot showed issue-board `blocked = 0` while the other two were non-zero: decisions existed. The three are answering **different questions** ("has an unresolved blocking finding with no decision yet" vs "does a blocking finding exist" vs "is there an open/critical execution item"), all under one word.

## 4. Exact affected readers

**Group A (already aligned — verify, do not rewrite):**
- `lib/validator/shared.ts:1140,1147` — `buildValidationSummary` → `critical_count`, `validator_blockers`.
- `lib/validator/persistValidationRun.ts:186,1290` — `summarizeFindings.critical_count`; inline rollup `blocked_count` (note: this inline rollup is also Forge-audit P3-7).
- `lib/projectFacts.ts:978,986,993,1423` — `blocker_count`, `critical_count`, `validator_blockers`, `approvalBlockerCountForProjectFacts`.
- `lib/projectOverview.ts:230,582,617,1694,1842,2065` — `approval_blocker_count` throughout the Overview model.
- `components/projects/ProjectOverview.tsx:1011,1525,1733` — Overview header "Approval Blockers" tile + critical-findings display.
- `components/projects/ValidatorTab.tsx:819-821` — `summary.blocker_count ?? critical_count ?? validator_blockers.length`.
- `lib/commandCenterApproval.ts:31` + `app/platform/page.tsx:373,423` — Command Center `is_blocked` / blocked-projects KPI.

**Group B (the readers that must be brought onto the same basis):**
- **B1:** `lib/server/operationalQueue.ts:810,818,885,893` — rollup `status.key === 'blocked'` and additive `blocked_count`. Consumed by Command Center project rows and any Overview surface reading the merged rollup.
- **B2:** `lib/resolveProjectIssueObjects.ts:239-255,375-380,443` — Project Decisions tab / issue board lifecycle `blocked` bucket, plus the synthesized-issue `approval_gate_effect` it stamps from lifecycle. Consumed by `components/projects/ProjectDecisionExecutionCard.tsx` and the issue board **[inferred consumer — confirm exact component in Phase B]**.

## 5. Recommended canonical state model

**Principle:** one finding-level answer to "does this block approval," computed once, persisted once, read everywhere. That answer already exists: `ValidationFinding.approval_gate_effect ∈ {blocks_approval, requires_operator_review, informational}`, set by `normalizeValidationFinding` and persisted with each finding's derived semantics. Group A already uses it. The model is therefore:

> **Canonical blocker = an `open` finding whose `approval_gate_effect === 'blocks_approval'`.**
> Every surface's "blocked" count is a *view* over that set. Execution items and issue objects must **not** re-derive blockedness; they inherit it from their source finding.

Two derived, clearly-named view-concepts sit on top (these are labels, not new truth):
- **`approval_blocker` (project/finding health):** count of open blocking findings. Overview, Command Center, Validator. = Group A today.
- **`unactioned_blocker` (operator worklist):** blocking findings with no decision yet. The issue board's legitimate, *distinct* need — but it should be named as a different concept, not a second definition of "blocked." B2's `!decision` gate is a real product requirement; the fix is to stop calling it "blocked" interchangeably and to source its blocker test from `approval_gate_effect`, dropping the raw-severity fallback.

**Execution-item blockedness (B1)** should be expressed as *"open work items linked to blocking findings,"* not a second independent tally added into the same `blocked_count`. The rollup should either (a) count execution items **or** their source findings, never both, or (b) treat the execution item's blockedness as `isBlockingFinding(sourceFinding)` rather than `status === 'open' || severity === 'critical'`.

**Why not a new `operational_state` column now (the June proposal):** it is not required to make the four agree, and it adds a backfill + dual-read + drift-enforcement burden. The finding already carries the canonical signal; persisting a *derived* state column risks a fifth representation that can itself drift from `approval_gate_effect`. Recommend deferring the column unless Phase B proves the read-side unification insufficient (e.g. if a surface genuinely cannot reach the finding's `approval_gate_effect` at read time). This keeps the change reversible and small.

## 6. Migration implications

- **No schema change** in the recommended path. `approval_gate_effect` is already computed and persisted via the finding's normalized semantics; `project_validation_findings` already stores `severity`/`decision_eligible`/`action_eligible`. No new column, no backfill, no CHECK-constraint drift to manage.
- **Count values will change on affected surfaces.** Removing B1's double-count will **lower** Command Center `blocked_count` for projects with synced execution items; aligning B2's predicate/scope will **change** issue-board `blocked` bucket membership. These are corrections, but they are **visible metric shifts** — every test asserting a specific `blocked_count` / `blocked`-lifecycle number must be reviewed, and the Golden Project's expected counts must be confirmed unmoved before/after (do not edit fixtures to make them pass — if a Golden count moves, that is a finding, not a rebase).
- **Execution-item resolution semantics unaffected.** This audit does not touch how items resolve; only how their blockedness is *counted* into rollups.
- **`persistValidationRun` inline rollup (P3-7)** intersects here: its hand-built `blocked_count` (`persistValidationRun.ts:1290`) should be brought onto the same view helper in the same change, or it becomes a fifth path.

## 7. Bounded Phase B plan

Ordered, each step independently shippable and reversible:

1. **Extract one shared view helper.** Add `isApprovalBlocker(finding)` (thin alias of the existing `isBlockingFinding`) and `countApprovalBlockers(findings)` as the single sanctioned entry points, and a documented `isUnactionedBlocker(finding, decision)` for the worklist concept. No behavior change yet — pure consolidation with tests pinning current Group A numbers.
2. **Retarget B2 (issue board).** Replace `isBlocker`'s body (`resolveProjectIssueObjects.ts:239-243`) with `isApprovalBlocker`, dropping the raw `finding.severity === 'critical'` fallback; keep the `!decision` gate but rename the lifecycle intent to the `unactioned_blocker` concept in comments/labels. Regression test: a finding with a rule-override-downgraded `business_severity` is treated identically by board and Overview.
3. **Retarget B1 (rollup).** In `mergeProjectRollupWithExecutionItems`, stop adding `blockedTierCount` on top of the findings-derived `blocked_count`; instead derive execution-item blockedness from the source finding's `approval_gate_effect` (or count items xor findings). Regression test: a project with N blocking findings and their N execution items reports `blocked_count === N`, not `2N`.
4. **Unify the `persistValidationRun` inline rollup (P3-7)** onto the same helper in the same PR as step 3.
5. **Golden guard.** Re-run the full suite and confirm no Golden count moved; if any surface count changes, document the before/after and the reason in the PR, and confirm with the operator that the new number is the correct one before landing.
6. **(Deferred, only if needed)** Persist a derived `operational_state` per the June proposal — *only* if Phase B step 1-4 surfaces a reader that cannot reach `approval_gate_effect` at read time. Treat as a separate, later audit.

**Non-goals for Phase B:** do not change `approvalGate.ts` structural blocking; do not change execution-item resolution/outcome logic; do not add a state column preemptively; do not rename persisted finding fields; do not bulk-close or re-status any finding.

## 8. Falsification — the pattern to copy

Group A already proves the loop can be single-sourced: `commandCenterApproval.ts` was written specifically so "both surfaces agree on blocked-ness" by reading the same persisted `validation_summary_json`. Phase B is not inventing unification — it is **extending the Group A pattern to the two readers (B1, B2) that predate it**. That is the strongest evidence this is a bounded read-side consolidation, not an architectural rebuild.

---

*Inferred, not proven this session: the live magnitude of the B1 double-count (code path confirmed, numbers not re-measured); the exact issue-board component consuming B2. Both should be confirmed at the start of Phase B before changing counts.*
