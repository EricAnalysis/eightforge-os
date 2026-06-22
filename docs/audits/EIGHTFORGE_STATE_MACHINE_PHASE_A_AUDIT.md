# EIGHTFORGE — EXPLICIT STATE MACHINE CODIFICATION
## PHASE A — AUDIT & ANALYSIS (DERIVATION-MAPPING ONLY)
**Date:** 2026-06-21  
**Branch:** main (clean worktree, fetched, pulled to origin/main 80b2777)  
**Governing Law Observed:** Surfaces read truth. No production of canonical state. `lib/projectFacts.ts` respected. No new semantics invented.  
**Regression Gate:** Williamson Golden Project (437502f2-d46d-447f-81e3-f26fa7ba0c14) baseline confirmed green at start (and re-checked post-updates). No changes made, so unaffected.  
**Scope:** Pure mapping of *existing* derivation logic. STOP if new state values needed to be invented (none were).

---

## STEP 1 — Persisted-Field Inventory per Object Type

### Documents (main state contributors to "what state is this thing in")
Base table exists pre-2025-03 (inferred from ALTERs in earliest relevant migrations; no raw CREATE in listed migration files; referenced in verification checklists and FKs).

State-relevant columns added/used:
- `processing_status` text NOT NULL DEFAULT 'uploaded' (migration: `20250314000000_deterministic_decision_backbone.sql:19`)
  - CHECK constraint declared: `documents_processing_status_check` IN ('uploaded', 'processing', 'extracted', 'decisioned', 'failed') (`:31-32`)
  - Verified in checklist (`20250314_verification_checklist.sql:21`)
  - Also `processing_error` text, `processed_at` timestamptz (`:20-21`)
- `authority_status` text (migration: `20260323000000_document_precedence.sql:11`)
  - CHECK: `documents_authority_status_check` ('active','superseded','draft',...) (`:44-48`)
  - Related: `document_role`, `precedence_rank`, `effective_date`, `operator_override_precedence`
- `deleted_at` (added in `20260620001000_document_management_actions_soft_delete.sql` — soft delete support)
- Other context fields frequently joined for status: `project_id`, `status` (legacy?), `domain`, `document_type`, `intelligence_trace` (jsonb)

**Constraint drift notes:** 
- `documents_processing_status_check` and `documents_authority_status_check` declared with IF NOT EXISTS pattern. No evidence in code of live enforcement drift for documents (unlike findings below). Verification checklist expects the processing one.
- Later migrations (truth governance, soft delete) adjust other checks (e.g. document_subtype) without touching processing/authority.

### project_validation_findings (and related runs)
- `status` text NOT NULL DEFAULT 'open' (migration: `20260401000000_project_validator_phase0_schema.sql:36`)
  - CHECK declared: `project_validation_findings_status_check` IN ('open', 'resolved', 'dismissed', 'muted') (`:144-145`)
- Related:
  - `run_id` (FK to runs)
  - `linked_decision_id`, `linked_action_id` (nullable)
  - `resolved_by_user_id`, `resolved_at`
  - `decision_eligible`, `action_eligible` booleans
  - `blocked_reason`
  - `severity`, `category`
- `project_validation_runs.status` text DEFAULT 'pending' (same migration `:16`)
- `projects.validation_status` text DEFAULT 'NOT_READY' + `validation_summary_json` jsonb (same migration `:81-82`)
  - CHECK `projects_validation_status_check` (NOT_READY, BLOCKED, ...)

**Constraint drift notes:**
- `project_validation_findings_status_check` declared in migration. Per prior wiring audit (and still true based on lack of enforcement patterns in current queries/selects): this CHECK appears absent or not enforced in the live DB schema at the time of previous verification. Code (findings queries, updates) freely uses/sets the values without DB-side enforcement visible in TS layer or recent migrations re-adding it. No "live" direct query possible here, but derivation sites treat status values as open set (no strict enum guard beyond normalize).
- Similar pattern for runs/projects validation_status (declared but usage is derived/snapshot heavy).

### execution_items
- `status` text NOT NULL DEFAULT 'open' (migration: `20260506000000_execution_items.sql:24`)
  - CHECK: `execution_items_status_check` IN ('open', 'resolvable', 'resolved') (`:69-70`)
- `outcome` text (nullable) (same file)
  - CHECK: `execution_items_outcome_check` NULL OR IN ('confirmed', 'resolved', 'overridden') (`:81-82`)
- Related:
  - `severity` (CHECK critical/high/medium/low)
  - `source_type` (CHECK 'validator_finding')
  - `override_reason`, `resolved_at`, `suppression_signature` (added in follow-up `20260506002000...`)
  - `updated_at`, `created_at`

**Constraint drift notes:**
- Status and outcome CHECKs declared with IF NOT EXISTS. No obvious drift reported previously; code in sync/derivation respects the values. No unenforced status check noted for this table in prior audits.

**Cross-cutting:**
- `decisions.status` (CHECK open/in_review/resolved/dismissed/suppressed from backbone)
- Many derived "blocker" concepts live only in jsonb snapshots (`validation_summary_json`) or computed fields.

All state is carried in status-like columns + optional outcome/linked IDs + jsonb summaries. No top-level `state` enum column on any of the three primary objects.

---

## STEP 2 — Exhaustive Derivation Site Map

### Documents — Higher-order states ("review/blocked/clear", operational status, etc.)
1. **lib/documentOperationalStatus.ts:67** `resolveDocumentOperationalStatus(input)`
   - Inputs: `processingStatus`, `reviewStatus`, `reviewedAt`/`processedAt`, counts (unresolvedFindingCount, pendingActionCount, blockedCount, missingSupportCount), `extractionFollowUpRequired`
   - Logic (if/else chain):
     - processing === 'failed' → 'Failed'
     - blockedCount > 0 → 'Blocked'
     - needsLedgerReview (openOperatorReview || staleApproved || extractionFollowUp || (not approved && unresolvedWork)) → 'Needs review'
     - approvedWhileWorkRemains → 'Warning'
     - review === 'approved' → 'Reviewed'
     - processing === 'processing' → 'Processing'
     - processing === 'extracted' → 'Extracted'
     - processing === 'decisioned' → 'Operationally clear'
     - fallback: titleize(processingStatus)
   - Outputs: label + tone + needsReview + approvedWhileWorkRemains flags. Distinct values: Failed, Blocked, Needs review, Warning, Reviewed, Processing, Extracted, Operationally clear + fallbacks.
   - Used by: Documents surface, project tabs, Ask selectors.

2. **components/DocumentProcessingStatus.tsx + callers** (raw + derived)
   - Inputs: raw `processing_status`, `processing_error`, 'status' prop (often from resolve above)
   - Logic: displayStatus = processing ? 'processing' : status; canReprocess if not 'processing'
   - Outputs feed UI badges.

3. **lib/projectOverview.ts** (and snapshot copy) `documentProcessingStatusLabel` + conditions
   - Inputs: `document.processing_status`
   - Logic: 'failed' special; ['extracted','decisioned'] for clear paths; else raw.
   - Also used for rollup document counts.

4. **lib/documentWorkspace.ts** (build/filter/summarize) + global Documents page
   - Combines processing + reviews + decisions/findings for workspace tones/modes.

5. **lib/server/operationalQueue.ts + projectOverview rollups** (augment, document signals)
   - Derives 'failed'/'blocked'/'needs_review'/'attention_required'/'operationally_clear' for intelligence summaries and project rollups using processing + unresolved counts + validator actions.

6. **lib/ask/* (retrieval, answerBuilder, portfolio etc.)**
   - Uses processingStatus directly for "unprocessed" / fallback decisions.

**All sites converge on processing_status raw + review + count signals for the review/blocked/clear family.**

### Findings / Issues — Higher-order states (lifecycle, blocked/open/ready, etc.)
1. **lib/validator/findingSemantics.ts**
   - `isBlockingFinding(f)`: normalize → approval_gate_effect === 'blocks_approval'
   - `blockerFindingCount`: count where finding_disposition === 'blocker' (after normalize)
   - `isReviewFinding`, warning/requires/info counts by disposition.
   - normalize also sets business_severity, impact etc.
   - Used by ValidatorTab, projectFacts, ask, etc.

2. **lib/resolveProjectIssueObjects.ts** (core for Project Decisions tab + issue board)
   - `isBlocker(finding)`: approval_gate_effect==='blocks_approval' || disposition==='blocker' || severity==='critical'
   - `lifecycleForIssue({finding, decision, status})`:
     - status COMPLETE → 'resolved'
     - isEscalated → 'escalated'
     - !decision && isBlocker → 'blocked'
     - !decision → 'open'
     - decision status logic (PENDING_VERIFICATION/in_review/needs_review/flagged → 'needs_verification'; PENDING_OPERATOR/open/pending → 'ready_for_auth'; resolved etc → 'resolved')
     - fallback based on status EXECUTING
   - `queueLifecycleForExecutionItem(item)`: resolved→'resolved'; open→'blocked'; resolvable→'needs_verification'; else 'open'
   - Synthetic findings created from execution items.
   - Outputs (IssueLifecycleState): 'resolved', 'escalated', 'blocked', 'open', 'needs_verification', 'ready_for_auth' (and 'ready_for_auth' variant).

3. **lib/projectFacts.ts + validator/shared.ts** (summary computation)
   - `blocker_count`: from validator_blockers or critical_count or blockerFindingCount(open findings)
   - `validator_blockers`: filtered critical + canonical blockers
   - `buildValidationSummary` uses open findings + isBlocking etc.
   - Also readiness/validator_status from facts.

4. **lib/server/operationalQueue.ts + augmentRollupWithValidatorActions**
   - blockedFindingCount = actions where approval_status==='blocked'
   - reviewFindingCount
   - Influences rollup.status.key = 'blocked'/'needs_review'

5. **ValidatorTab.tsx, ProjectIssueBoard, Command Center etc.**
   - Use the above + direct open findings queries + summary_json.

### Execution Items — Higher-order states (queue_state, blocker, approval_status)
1. **lib/executionItems.ts**
   - `executionItemBlocksApproval(item)`: `item.status === 'open'`
   - `executionItemIsResolvableNow`: `status === 'resolvable'`
   - Status labels and outcome labels (open/resolvable/resolved + confirmed/resolved/overridden)

2. **lib/server/executionQueue.ts:162** `deriveQueueState(executionItem)`
   - if status === 'resolved' → 'resolved'
   - if outcome === 'overridden' → 'needs_verification'
   - if severity==='critical' || blocksApproval(status=='open') → 'blocked'
   - if severity==='high' → 'needs_review'
   - if status==='resolvable' → 'needs_verification'
   - else 'needs_review'
   - **Distinct outputs:** 'resolved', 'needs_verification', 'blocked', 'needs_review'
   - (Also legacy decision derive.)

3. **lib/server/operationalQueue.ts**
   - `executionItemBlocksApproval` + `executionItemIsBlockedTier` (blocks || critical)
   - `statusFromUnresolvedExecutionItems`: blockedTier → 'blocked' status for rollup
   - `executionPendingActionFromItem`: derives approval_status ('approved' | 'blocked' | 'needs_review'), due_label etc from status + blocks
   - `executionItemIsUnresolved`, counts for intelligence (blockingCount, resolvableCount)

4. **lib/execution/executionSummary.ts**
   - unresolved = status !== 'resolved'
   - `executionItemBlockerFlag` = blocksApproval || critical
   - Priority/sort by status

5. **lib/resolveProjectIssueObjects.ts** (see above for queueLifecycleForExecutionItem)

6. **lib/ask/selectors/projectApprovalExecutionState.ts** etc.
   - Use open_execution_items with status + blocker_flag.

**All converge on status + (sometimes) outcome + severity.**

---

## STEP 3 — Canonical Output-State List per Object Type

### Documents (distinct derivable operational/review states)
- Failed (processing='failed')
- Blocked (blockedCount>0 or equivalent)
- Needs review (ledger review needed: open review, stale approved, follow-up required, or not-approved + unresolved work)
- Warning (approved but unresolved work remains)
- Reviewed (approved + no unresolved work)
- Processing
- Extracted
- Operationally clear (decisioned + clear)
- (fallbacks + raw processing values)

All major sites (resolveDocumentOperationalStatus, rollups, workspace) agree on the processing_status + review + count logic for these.

### Findings/Issues (distinct lifecycle + blocker states)
From resolve + semantics:
- 'blocked' (no decision + isBlocker or open + blocks)
- 'open' (!decision && !blocker)
- 'needs_verification' (decision in review/pending verification or execution resolvable)
- 'ready_for_auth' (decision pending operator)
- 'escalated'
- 'resolved' (COMPLETE or terminal decision/execution)
- Blocker vs review vs info (via disposition / gate effect / severity after normalize)

Translation layer exists between raw findings.status ('open'/'resolved'...) and lifecycle states. Not 1:1.

Execution synthetic findings produce the same set.

### Execution Items (distinct queue / approval states)
From deriveQueueState + helpers:
- 'resolved' (status==='resolved')
- 'needs_verification' (outcome==='overridden' or status==='resolvable')
- 'blocked' (critical || status==='open' / blocksApproval)
- 'needs_review' (high or default)

Also:
- approval_status derived: 'approved' | 'blocked' | 'needs_review'
- blocker_flag: blocks || critical
- In rollups: 'blocked' tier vs resolvable

Status + outcome combine predictably in current derivations (no "undefined" pairs observed in logic; if status resolved, outcome may be set). No free combination producing surprise states in the sites.

**Agreement:** High within execution sites; the deriveQueueState is the most complete single source for queue states.

---

## STEP 4 — Explicit Divergence Findings (Data Only)

**Primary H1-style divergence (Goodlettsville / Command Center vs Project vs Validator):**
- **Surfaces involved:** Command Center (platform/page + operationalQueue intelligence/rollups), Project Decisions tab (resolveProjectIssueObjects + ProjectIssueBoard), Validator (validator_blockers / blockerFindingCount + summary), Project Rollups.
- **Root logic differences:**
  1. `blocked_count` in rollups/intelligence (operationalQueue): counts from unresolved execution items where `executionItemIsBlockedTier` (status=='open' via blocksApproval **OR** severity critical) + blocked validator actions. Also augments with validator finding counts.
  2. `blocker_count` / `validator_blockers` (projectFacts + findingSemantics): `blockerFindingCount` = open findings where (after normalize) `finding_disposition === 'blocker'` (or isBlockingFinding = approval_gate_effect==='blocks_approval'). Or falls back to critical_count. Does **not** directly count execution_items.
  3. Lifecycle "blocked" count (resolveProjectIssueObjects + Project Decisions): issues where `lifecycleState === 'blocked'` = (no decision && isBlocker(finding)) **OR** from execution queueLifecycle 'blocked' (status=='open'). Filters only certain open findings; synthetic execution items included but may not match full rollup.
- **Observed effect (per prior audit, logic still present):** e.g. blocked_count ~106 (rollup + exec) vs blocker_count ~62 (validator findings) vs explicit lifecycle 'blocked' count = 0 (narrower filter or different input set at snapshot time). Divergence comes from:
  - Different source sets (exec items vs open validator findings vs filtered issue objects).
  - Different predicates (status=='open' + severity vs disposition/gate_effect vs no-decision + isBlocker).
  - Summary_json snapshot lag vs live open queries.
- No single canonical "is this item blocking approval" computation feeding all surfaces.

Other minor: document 'operationally clear' vs raw 'decisioned'; approvalGateLabel collapsing FINDINGS_OPEN / NOT_READY.

These are recorded as data for future canonical persistence (single computation site).

---

## STEP 5 — Scope Boundary vs Redesign (v2 spec §4.3 Validator three-panel)

Re-read reference: Validator three-panel split (Findings / Evidence & Truth / Decision & Execution).

States **currently derivable** (from Step 2-3) and usable across panels today:
- Open findings (status open + normalized)
- Blocked / review / info dispositions
- Execution open/resolvable/resolved + blocker_flag
- Lifecycle states (blocked/needs_verification/ready_for_auth/resolved)
- Document processing + review states

**Not yet derivable today as distinct, observable states** (would be needed for clean three-panel separation but do not exist as outputs of current logic; defer to later scoped addition per spec sequencing):
- Distinct "evidence reviewed / truth confirmed" state (separating center Evidence&Truth panel confirmation from left Findings).
- Distinct "decision pending / act-ready" state (right Decision&Execution panel readiness vs overall finding open).
- "Audit recorded / immutable" vs active execution resolved (Audit surface vs current resolved).
- Granular per-panel "operator confirmed this panel's truth" without affecting global finding/execution status.

These are **not** produced by any derivation site found. They would be new semantics invented by the redesign. Recorded here as "not yet derivable today — defer to Phase 2 of surface collapse / explicit state addition."

Do not design transitions or values for them here.

---

## STEP 6 — Williamson Baseline
Confirmed green at gate (and re-run post-main update):
```
✓ ... dedups Williamson-shaped CYD and mileage by raw Ticket No while preserving row-grain amounts
✓ ... errors loudly when a repeated ticket has non-uniform raw CYD values
```
2/2 tests passed. Gate (74,617 CYD / $815,559.35) stands.

---

## MINIMAL-DIFF STRATEGY PROPOSAL FOR PHASE B (Proposal Only — No Implementation)

**Goal:** Persist exactly the states discovered in Steps 2-3 as a canonical `state` (or `operational_state`) column per object. Surfaces continue to read (now from persisted + backfilled) without behavior change.

**Per object type (capture the canonical lists from Step 3):**

- **documents:**
  - Add `operational_state` text (or reuse/extend `processing_status` + new `review_state`?).
  - CHECK on values: 'failed', 'blocked', 'needs_review', 'warning', 'reviewed', 'processing', 'extracted', 'operationally_clear' (plus raw processing fallbacks if needed).
  - Canonical computation: centralize `resolveDocumentOperationalStatus` (or extract pure function) to compute it from processing + review + counts.
  - Backfill: run once over existing using the resolver; on write paths (process, review, finding sync) compute + store.

- **project_validation_findings:**
  - Add `operational_state` text.
  - CHECK: 'blocked', 'open', 'needs_verification', 'ready_for_auth', 'escalated', 'resolved' (lifecycle) + perhaps disposition tags.
  - Or separate `lifecycle_state` + keep raw `status`.
  - Canonical: `lifecycleForIssue` + `isBlocker` / normalize. (Reconcile with raw status on write.)
  - Note: findings.status remains for run linkage; new field for UI/queue state.

- **execution_items:**
  - Add `operational_state` (or `queue_state`).
  - CHECK on: 'resolved', 'needs_verification', 'blocked', 'needs_review' (from deriveQueueState).
  - Canonical: `deriveQueueState` (lib/server/executionQueue.ts:162) — single source.
  - Also persist derived `blocks_approval` boolean (from status==='open') if useful.
  - Backfill + update on syncExecutionItems + outcome writes.

**Handling divergence (Step 4):**
- Choose **one** canonical derivation per conceptual state (recommend the most complete: for blockers/exec use the deriveQueueState + blocksApproval central; for findings use normalized isBlocking + lifecycleForIssue).
- Update all surfaces to read the new persisted field (or a shared view/resolver over it) instead of re-deriving.
- Deprecate old inline logic gradually.
- For count divergence: the canonical computation will produce consistent numbers everywhere once persisted (e.g. always use same predicate for "is blocked").
- Migration strategy (minimal): additive columns + backfill script (idempotent using the resolvers) + dual-read period (persisted || derive for safety) → cutover.

**Other:**
- Keep existing status/outcome/processing columns (they are source-of-truth inputs).
- Update projectFacts / validator summary to incorporate the new persisted states for snapshots.
- No behavior change to any surface display in Phase B implementation (per governing law).
- Test against Golden Project + Goodlettsville divergence cases.
- Add enforcement (CHECK + perhaps trigger) matching the declared ones that had drift.

This proposal is derived strictly from the mapping in this audit. Ready for operator approval before any Phase B work.

---

**End of Phase A report.** All steps complete with file:line evidence. No code or schema touched. Waiting for explicit review/approval before Phase B.