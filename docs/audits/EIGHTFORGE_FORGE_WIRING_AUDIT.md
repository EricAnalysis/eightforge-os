> Historical: references components removed after 2026-07-16; retained as-is for audit history.

# EIGHTFORGE FORGE WIRING AUDIT

**Date:** 2026-06-21  
**Type:** Read-only architecture and wiring review  
**Scope:** App routes, navigation, project surfaces, data flows, validation/execution/audit wiring, authority classification, database tables, critical operator flows, legacy code, contradictions vs intended model.  
**Constraint:** No code changes, no refactors, no deletions, no renames. Pure audit + report.

---

## 1. Executive Summary

**Verdict: PASS WITH CONCERNS**

The core intended flow **Documents → Facts → Validator → Execution → Audit** is largely present in the implementation:

- Documents are the ingestion/evidence source.
- Facts are derived/canonicalized (primarily via `projectFacts.ts` resolvers + extraction/intelligence traces; not a standalone table).
- Validator (`ValidatorTab` + `triggerProjectValidation` + `persistValidationRun`) consumes facts, produces `project_validation_findings` + summary, drives readiness/blockers.
- Execution (`execution_items` + `/api/execution-items/[id]/outcome`) is the **only** surface permitted to perform approval-impacting final dispositions (approve/confirm/correct/override). Decision status routes explicitly guard against this (`"Approval-impacting outcomes must be finalized through Execution."`).
- Audit (activity_events + project audit timeline) is read-only history.

**Major concerns (not blocking correctness today, but authority/naming/routing risks):**

- Navigation and surface names have not fully migrated to the simplified target model (Overview / Documents / Validator / Audit). "Decision Queue", "Intelligence", "Facts", old "Forge" terminology and legacy project pages remain discoverable and drive mental models.
- Multiple independent projections for "work to do" / decisions / blockers: `operationalModel.decisions` + `execution_items` + `resolveProjectIssueObjects()` (from open findings + execution + decisions) + `project_validation_findings`. Counts and status representations can (and do) diverge.
- Project page internal tabs (`#project-facts`, `#project-decisions`) still exist alongside `#project-validator` and `#project-audit`. "Decisions" tab uses triage/issue objects, not final disposition.
- Global Documents surface (`/platform/documents`) vs project-scoped Documents tab vs document detail experience vs EvidenceInspector create parallel views without a single authoritative "source evidence + correction propagation" surface.
- Several "Forge" components (`ProjectFactsForge`, `ProjectExecutionForge`, `ProjectAuditForge`) exist and contain logic but are not mounted in the primary `ProjectOverview` tab tree (self-contained files only).
- Facts layer is advisory/derived (recomputed via resolvers). No single persisted "facts" table; truth lives in extractions, overrides, intelligence_trace, validation runs, and effectiveFacts builders.
- Prior downstream display audit findings (count drift, lifecycle vs decision.status, routing param mismatches for executionItemId vs decisionId) remain relevant structural risks.
- Ask surfaces are query-only (good), but response adapters surface "create_decision" suggestions that could be misinterpreted.

**No stop conditions triggered** (no evidence of routes that finalize findings outside Execution, no findings resolved without activity events in the audited paths, no direct document correction bypassing fact/validation trigger, no competing authoritative approval state tables).

The system is usable and the wiring mostly honors canonical truth + single final-disposition path, but cleanup of names, nav, and duplicate queue projections is required for operator clarity and to prevent future drift.

---

## 2. Intended Model (from task + architecture docs)

**Core product flow:**
Documents → Facts → Validator → Execution → Audit

**Current simplified app surfaces (target):**
1. Overview (summary + readiness snapshot)
2. Documents (source evidence, extraction, provenance, correction)
3. Validator (findings, blockers, approval gate, readiness, recommendations)
4. Audit (immutable history and evidence trail)

**Rules:**
- Documents = ingestion/evidence layer.
- Facts = extracted/canonicalized from documents.
- Validator consumes facts → findings, blockers, approval readiness, recommendations.
- **Execution is the only place** where approval-blocking outcomes are finalized.
- Decision Queue = triage/routing only; must not approve/correct/override/finalize.
- Audit = what happened, why, who/what, evidence. Not a second validator.
- Ask = query-only read layer over current state; never mutates authoritative records.
- Operator actions: Approve → confirmed; Correct → resolved/corrected; Override → overridden + reason.
- No silent drops, hidden transitions, duplicate truth, orphaned records, or UI implying authority it lacks.

Older surfaces mentioned (Forges, Intelligence, Decision Queue, Execution, Project Decisions, Evidence Inspector, Ask Project/Portfolio, Portfolio, Workspace) are transitional and must not contradict the model.

---

## 3. Actual Current Wiring Map

### 3.1 Routes & Navigation

**Platform shell (components/platform/shell.tsx):**
- Top nav: Portfolio, Command Center (/platform), Projects, Intelligence (/platform/reviews)
- Side rail: Command Center, Portfolio, **Decision Queue** (/platform/decisions), **Intelligence** (/platform/reviews + /issues + /agents + /rules), **Documents** (/platform/documents)
- Upload button → /platform/documents
- "Audit history" icon → /platform/agents (labeled "Activity" internally: "Audit trail of status changes...")

**Project detail** (`/platform/projects/[id]` via `app/platform/projects/[id]/page.tsx` + `ProjectOverview`):
- Uses hash-based tabs via `PROJECT_FORGE_TABS` (`lib/projectForgeNavigation.ts`):
  - Overview (#project-overview)
  - Documents (#project-documents)
  - **Facts** (#project-facts)
  - **Validator** (#project-validator) ← injected `ValidatorTab`
  - **Decisions** (#project-decisions) ← via `ProjectIssueBoard` + `ProjectDecisionQueueFrame`
  - Audit (#project-audit)
- Legacy action hash `#project-actions` → maps to 'decisions'
- Also renders AskProjectSection in default overview.

**Legacy / transitional routes:**
- `app/projects/[projectId]/` (approval-history, decisions)
- `app/platform/workspace/...`
- `app/platform/decisions/[id]`
- Old document intelligence workspace, EvidenceInspector standalone usage.

**Global vs scoped:**
- `/platform/documents` (global document workspace using `documentWorkspace`)
- Project documents tab (project-scoped view)
- Document detail: `/platform/documents/[id]` (heavy use of `buildDocumentIntelligence` + `DocumentDetailExperience`)

### 3.2 Main Surfaces → Components → Data → Actions → Authority

**Overview / Command Center**
- `/platform` (Command Center) + project default tab
- Components: `app/platform/page.tsx` (uses `useOperationalModel`), `ProjectOverview`, `AskProjectSection`
- Hooks/API: `useOperationalModel` → `/api/operations` → `loadOperationalQueueModel` (lib/server/operationalQueue)
- Tables: decisions, execution_items, projects, documents, project_validation_*, activity, rollups derived
- Actions: mostly navigation; some actionable summary
- **Authority:** Dashboard / summary (advisory). Shows rollups, critical actions, pending decisions. Not authoritative for any final state.

**Documents (global + project)**
- `/platform/documents`, project `#project-documents`, `/platform/documents/[id]`
- Components: `app/platform/documents/page.tsx` (documentWorkspace), `ProjectDocumentsForge`, `DocumentDetailExperience`, `DocumentIntelligenceWorkspace`
- Hooks: `buildDocumentWorkspaceItems`, `buildDocumentIntelligence`, `buildDocumentIntelligenceViewModel`
- API: `/api/documents/upload`, `/api/documents/process`, `/api/documents/[id]/review`, `/api/documents/[id]/facts/review`, `/api/documents/[id]/facts/override`
- Tables: `documents`, `document_extractions`, `document_reviews`, `document_fact_*`, intelligence_trace (jsonb)
- Actions: upload, process/reprocess, review status, fact override/correct → trigger validation
- **Authority:** Source / evidence + correction. Corrections propagate (review/override routes call `triggerProjectValidation`).

**Validator**
- Project `#project-validator` (ValidatorTab inside ProjectOverview)
- Components: `ValidatorTab`, `ValidatorFindingsTable`, `ValidatorStatusChip`, `ForgeSectionCard` usage
- Data: `loadValidatorState` (direct + `resolveValidationSummaryFromProjectFacts`), `resolveCanonicalProjectValidatorWorkspace`
- API: manual revalidate via validation-phase PATCH or ValidatorTab trigger
- Tables: `projects` (validation_status, validation_summary_json), `project_validation_runs`, `project_validation_findings`, `project_validation_evidence`
- Actions: Manual Revalidate (creates run), link to execution for resolution
- **Authority:** Validation / finding generation + approval gate. Primary operator surface for findings, blockers, readiness, recommendations. Does **not** finalize outcomes.

**Decisions / Decision Queue**
- `/platform/decisions` (global), project `#project-decisions`
- Components: `app/platform/decisions/page.tsx`, `ProjectDecisionQueueFrame`, `ProjectIssueBoard`
- Data: `useOperationalModel` (current) or direct `decisions` (history); `resolveProjectIssueObjects` (project)
- Actions: confirm/override/needs_review → `/api/decisions/[id]/feedback` (not status for approval actions); triage only
- Status update: `/api/decisions/[id]/status` has explicit guard: approval actions must go through Execution
- Tables: `decisions`, linked to findings via `linked_decision_id`
- **Authority:** Triage / routing (intended). Project decisions tab renders buckets from issue objects (open findings + execution + decisions). Not final disposition.

**Execution**
- Not a top-level route in current simplified model. Embedded via executionHref links from Validator/Decisions.
- Components: `ProjectExecutionForge` (appears unused in main tree), execution outcome controls
- API: `/api/execution-items/[id]/outcome` (approve | correct | override)
- Tables: `execution_items` (source_type: 'validator_finding', status, outcome)
- Post-outcome: closes findings, logs activity, triggers revalidation
- **Authority:** Execution / final disposition. **Sole authorized path for blocking outcome finalization.** Correctly wired as the target of validator/decision links.

**Audit**
- `/platform/agents` ("Activity"), project `#project-audit`
- Components: `app/platform/agents/page.tsx`, `AuditTimeline`, `ProjectAuditForge` (partially used), `ValidationAuditEventSummary`
- Data: `loadProjectActivityEvents`, direct `activity_events`
- Tables: `activity_events` (primary), some legacy decision_feedback
- **Authority:** Audit / history. Read-only. Good.

**Ask (Project / Portfolio)**
- Command bar + `AskInterface`, `AskProjectSection` (embedded in overview), portfolio ask
- API: `/api/ask/project`, `/api/ask/*`, operations ask
- Logic: `retrieveProjectTruth`, `buildAskResponse`, `answerBuilder` (read paths only), selectors over current state (facts, validation snapshot, execution, audit)
- Response adapters surface suggested actions (e.g., 'create_decision') but do not execute mutations.
- **Authority:** Assistant / query-only. Correct.

**Intelligence / Reviews**
- `/platform/reviews`, `/platform/issues`
- Components use operationalModel intelligence aggregates (low trust docs, feedback, needs_review)
- **Authority:** Dashboard / summary signals. Not a validator or execution surface.

**Legacy/Transitional still reachable:**
- Workspace pages, old forge project pages, EvidenceInspector (components/evidence/), platform/agents as "Audit", various document-intelligence subcomponents.

### 3.3 Data Hooks / Server Builders / APIs Summary (key)

- `useProjectWorkspaceData` (central for project): loads project + documents + reviews + decisions + tasks + activity + validationFindings + validationEvidence + executionItems + relationships + transactionDatasets + members.
- `useOperationalModel` → `/api/operations` → server operationalQueue (decisions + actions + rollups).
- `resolveProjectIssueObjects` (lib/): derives IssueObjects from open findings + execution + decisions for project decisions tab.
- `projectFacts.ts` (massive): `resolveCanonicalProjectFacts`, `resolveValidationSummaryFromProjectFacts`, `resolveCanonicalProjectValidatorWorkspace`, truth sections, briefing.
- `triggerProjectValidation` + `projectValidator` + `persistValidationRun`: the validation engine. Writes runs/findings/evidence, then syncs execution_items + validator decisions + snapshots + activity.
- `syncExecutionItems`: projects validator findings into execution_items (idempotent via suppression signatures).
- Document pipelines: `processDocument`, extraction libs → intelligence → facts.
- Activity: `logActivityEvent` called from most mutation paths.

### 3.4 DB Tables (who writes/reads, transitions)

**documents + document_extractions / reviews / fact_* / intelligence_trace:**
- Writes: upload + process pipeline, review/override routes.
- Reads: workspace, validator input loading, document detail, ask retrieval.
- Transitions: processing_status (uploaded → ... → decisioned), review status, fact overrides.

**project_validation_runs / _findings / _evidence:**
- Writes: `persistValidationRun` (via trigger, manual, document_processed, fact_override, etc.).
- Reads: ValidatorTab, issue objects, ask selectors, project overview.
- Statuses on findings: open → resolved / dismissed.
- Linked via run_id, project_id, linked_decision_id, linked_action_id (execution?).

**execution_items:**
- Writes: `syncExecutionItems` (from persist), outcome route (approve/correct/override).
- Status: open / resolvable / resolved. Outcome on terminal.
- Source: primarily 'validator_finding'.
- Suppression/override support.
- Post-write: triggers revalidation.

**decisions + decision_feedback / assertions?**
- Writes: validatorDecisionSync, various decision generators, feedback/status routes (limited).
- Recent migration: decision_assertions (used by validation/decisionAssertionEvaluator).
- Status guard in status route prevents final approval actions here.
- Linked from findings (linked_decision_id).

**activity_events:**
- Writes: most mutation paths (status changes, validation, execution outcomes, document reviews, fact overrides, phase changes).
- Reads: agents page, project audit timeline, various summaries.
- Primary audit source.

**projects:**
- validation_status, validation_summary_json, validation_phase.
- Updated by persist + other syncs.

**Other:** transaction_data_*, approval_snapshots, document_relationships, signals, rules, etc.

**Risks observed:**
- No single persisted "canonical facts" table; facts are recomputed or stored in jsonb traces/summaries.
- `validation_summary_json` is a derived snapshot; live blocker counts can differ from it.
- Linked IDs (decision, action) exist on findings but closure is best-effort in some paths.
- Multiple places compute "blocker_count", "readiness", "open" using different filters (open findings vs execution vs decisions vs rollups).

---

## 4. Surface-by-Surface Authority Classification

| Surface | Classification | Notes / Risk |
|---------|----------------|--------------|
| Command Center (/platform) | Dashboard / summary | Aggregates; multiple bases inside one payload. |
| Portfolio | Dashboard / summary | Portfolio pressure. |
| Documents (global + tabs + detail) | Source / evidence + correction | Correction paths correctly trigger validation. Parallel views risk. |
| Project Facts tab | Advisory / derived truth | Recomputed canonicals. Good for inspection; not a mutation surface. |
| Validator (ValidatorTab) | Validation / finding generation | Correct primary for findings/gate/readiness. Links out to execution for final. |
| Project Decisions tab / Decision Queue | Triage / routing | Uses issue objects or operational decisions. Feedback only. Status guard exists. Labeling can imply more authority than it has. |
| Execution (outcome API + links) | Execution / final disposition | Sole path for approve/correct/override. Good. |
| Project Audit / Agents Activity | Audit / history | Read-only timelines. Correct. |
| Ask Project/Portfolio | Assistant / query-only | Reads current state via selectors/retrieval. No authoritative mutation. Suggested actions are UI only. |
| Intelligence / Reviews | Dashboard / summary signals | Aggregates from operational model. |
| EvidenceInspector | Source / evidence (detached) | Belongs under Documents per task guidance. Currently somewhat standalone. |
| Old Forge* components (Facts/Execution/Audit Forge) | Legacy naming, mixed usage | Primitives (SectionCard/DetailPanel) still used; full *Forge pages/components appear largely unmounted in main project flow. |

---

## 5. Critical Flow Traces

### A. Upload / ingest document
Upload (storage + documents row) → process (`/api/documents/process` or pipeline) → extraction/intelligence/intel trace → set status 'decisioned' → fire-and-forget `triggerProjectValidation(projectId, 'document_processed')` → run created → findings/evidence → sync execution_items + decisions + activity.
**Result:** Wired as expected. No silent drop.

### B. Reprocess document
`/api/documents/[id]/...` or process route with documentId → re-runs pipeline → updates extraction/intel → triggers validation (document_processed or manual).
**Result:** Stale findings handled by validator dedup/sync logic (suppression signatures). Validation requested.

### C. Manual Revalidate
ValidatorTab "Revalidate" or validation-phase PATCH → `triggerProjectValidation(..., 'manual')` → same path as auto: load inputs, validateProject, persist (atomic run + findings), syncs.
Uses inputs_snapshot_hash to skip unchanged. In-flight debounce.
**Result:** Consistent path. No divergent manual-only logic found.

### D. Resolve finding
Finding in Validator → executionHref link → execution outcome (approve/correct/override) → updates execution_item (status/outcome/resolved_at/override_reason), closes linked project_validation_findings (resolved/dismissed), logs activity_event, triggers revalidation.
Alternative path: Decision feedback/status (non-approval) → revalidation request.
Decision status has 409 guard for approval actions.
**Result:** Final disposition correctly routed through Execution. Audit created.

### E. Ask Project
POST /api/ask/project → classify + retrieveProjectTruth (docs, facts via projectFacts, validation snapshot, execution, decisions, audit events) + answerBuilder + guardrails (read-only SQL patterns) → response (no writes to authoritative tables).
**Result:** Query-only. Grounded in current system state. No mutations observed.

---

## 6. Database / Table Wiring Review

- Strong project_id / org scoping via RLS policies (from migrations) on most tables.
- FKs: runs → projects, findings → runs + projects, evidence → findings + (optional) documents, execution_items → projects, decisions have project_id (added in migration).
- decision_assertions (recent) for assertion evaluation.
- activity_events is the cross-cutting audit (written from server action paths).
- validation_summary_json on projects is a convenience snapshot (can lag live counts).
- No obvious missing critical FKs in the validator/execution paths, but linked_decision_id / linked_action_id on findings are set opportunistically.
- Orphan risk: possible for execution_items without open findings (visible in some queues but not others); decisions without current open findings.
- Status overlap risk: 'open'/'resolved' on multiple tables mean different things (finding vs execution vs decision). UI must translate via resolvers.
- Fields assumed by UI (e.g., in issue objects, rollups) sometimes derived client-side or via server builders rather than guaranteed by schema.

---

## 7. Contradictions and Gaps (Ranked)

**High**
- H1. Multiple independent "queue" projections for the same conceptual work (operational decisions vs execution_items vs open-findings issue objects vs rollup pending_actions). Leads to count drift and "where do I go to resolve X?" ambiguity. (See prior DOWNSTREAM_DISPLAY_AUDIT.)
- H2. Navigation + tab names contradict simplified target model (Decision Queue, Intelligence, Facts, legacy Forge labels still primary in side nav / project tabs).
- H3. Project "Decisions" tab (triage via issue objects / lifecycleState) and global Decision Queue both expose "confirm/override" language while final authority lives in Execution. Risk of operator confusion even if backend guards are present.
- H4. Global Documents surface and project documents / detail + EvidenceInspector create parallel evidence views without unified provenance + correction UX.

**Medium**
- M1. "Facts" tab is derived truth display. If operators treat it as editable source of record, drift can occur (corrections go through document fact reviews/overrides instead).
- M2. Validator "Requires Verification" label collapses FINDINGS_OPEN vs NOT_READY (with 0 blockers). Prior audit noted missing explicit CTA tying to Revalidate.
- M3. Some Forge* full components (ExecutionForge, AuditForge, FactsForge) are orphaned from main project tab render tree but still contain significant logic and are importable.
- M4. validation_summary_json vs live open findings + execution_items can disagree on blocker/readiness numbers presented in different surfaces.

**Low / Naming**
- Legacy hash mapping, breadcrumb strings ("Truth"), component names containing "Forge".
- Ask adapters mentioning create_decision without strong "this is a suggestion" labeling everywhere.
- EvidenceInspector usage pattern may imply standalone authority.

**No Critical Stop Conditions Found**
- No route/component found that can finalize approve/correct/override outside the execution outcome path.
- No evidence of findings being resolved without activity logging in the core paths.
- Document corrections do trigger validation.
- Validation persistence uses run-level consistency (persistValidationRun).

---

## 8. Dead / Legacy Code Inventory

**Active but should be renamed/moved (or labels updated):**
- `ProjectDecisionQueueFrame`, `ProjectIssueBoard` (triage decision surfaces)
- `components/forge/*` primitives (still used for cards/panels)
- `ProjectDocumentsForge` (linked from lists)
- Decision Queue page + Intelligence nav items
- "Forge" terminology in filenames, lib/projectForgeNavigation, docs

**Active but contradicts current simplified model (if kept prominent):**
- Full Facts / Decisions tabs as peer surfaces to Validator
- Global Command Center emphasis on "Decision Queue"
- /platform/agents labeled both "Audit history" (icon) and "Activity" (header)

**Unused / dead but harmless (low risk):**
- `ProjectExecutionForge.tsx`, `ProjectAuditForge.tsx`, `ProjectFactsForge.tsx` — defined and contain code but no active imports in main ProjectOverview render path (as of this review). May be used via workspace or direct links.
- Orphaned `mapValidatorAction` in decisions page (explicitly void'ed).
- Various old workspace/project/[id] pages.

**Unknown / needs manual confirmation:**
- Reachability of app/projects/[projectId]/* routes from current nav.
- Any deep links or old bookmarks into old forge stages.
- Whether EvidenceInspector is only reached from document detail or also standalone.

**Recommendation:** Do not delete. Inventory + hide/migrate labels first.

---

## 9. Risk Assessment

- **Operator confusion (medium-high):** Same concept ("block this approval") shown with different counts/labels/statuses in Command Center, Decision Queue, Project Decisions, Validator, and Execution links.
- **Drift between snapshot and live (medium):** validation_summary_json and various derived rollups vs live queries.
- **Authority implication (medium):** UI text and nav labels imply authority (Decision Queue as primary action surface) that is intentionally limited.
- **Maintenance (medium):** Large resolvers (projectFacts, operationalQueue, resolveProjectIssueObjects) duplicate similar logic.
- **No integrity failure observed:** Core state machine (validator run → findings → execution sync → final outcome → reval + audit) is consistent in the paths traced.

---

## 10. Recommended Target Wiring (Clean Model)

- **Overview:** Project summary + readiness snapshot + Ask (query) + critical signals. No decisions or findings list.
- **Documents:** Single authoritative source evidence surface (global list entrypoint + project-scoped + detail). Corrections propagate to facts/validation. Evidence Inspector lives here.
- **Validator:** Findings list, blockers, approval gate, readiness gaps, recommendations. "Revalidate" here. Links **out** to Execution for resolution.
- **Execution:** (May be visually embedded under Validator or a drawer.) The engine that performs confirm/correct/override and records final disposition. Always creates audit + updates findings.
- **Audit:** Immutable activity timeline + provenance. Never shows "open work" as actionable.
- **Ask:** Pure read layer. Answers from canonical resolvers/snapshots. Never mutates.

**Nav target (example):**
- Command Center / Overview
- Portfolio
- Documents
- Validator (per project)
- Audit (global + per project)
- (Ask everywhere as command)

Remove or de-emphasize: Decision Queue (rename or absorb as triage view inside Validator), Intelligence (absorb signals into Overview/Validator), Facts (absorb into Documents or a supporting Facts panel inside Validator), Execution as separate top nav.

---

## 11. Phased Repair Plan (Safe, No Behavior Change First)

**Phase 1: Map + Label (no behavior)**
- Add explicit authority labels/comments in code (e.g., "TRIAGE ONLY — final via Execution").
- Update internal docs / component headers.
- Align prior audit anomalies with current state (many still apply).

**Phase 2: Remove / hide misleading navigation**
- Rename or hide "Decision Queue" / "Intelligence" from side nav (or mark as legacy).
- Collapse or re-label project tabs (keep Facts if valuable but label "Derived Facts / Canonical Truth").
- Make Validator the prominent project work surface.

**Phase 3: Consolidate duplicate read paths**
- Introduce or strengthen shared selectors for "open work items", "blocker count", "approval readiness" consumed by Command Center, Validator, Decisions tab.
- Reconcile issue-object vs execution vs decisions derivations where they represent the same operator concern.

**Phase 4: Enforce single final-disposition path**
- Ensure all approve/correct/override entry points (even future Ask suggestions) route exclusively through execution outcome.
- Add server-side assertion tests that only execution outcome can set terminal approval states.

**Phase 5: Sync audit and lifecycle state**
- Ensure every finding resolution, execution outcome, fact correction, and validation run writes a consistent activity_event with full provenance (document/page/cell where possible).
- Backfill or guard any paths that currently skip audit.

**Phase 6: Add regression tests**
- Flow tests: upload → validation run → finding → execution outcome → closed finding + audit.
- Count consistency tests across surfaces (or explicit labeling of different grains).
- Guard tests for "decision status cannot finalize approval".
- Ask never-mutates tests.

---

## 12. Suggested Tests

- Unit: `persistValidationRun` atomicity + execution sync.
- `triggerProjectValidation` debounce + snapshot hash skip.
- Execution outcome route: only 'approve'/'correct'/'override' allowed; produces activity + finding closure.
- Decision status route: rejects approve/correct/override for terminal statuses (409).
- Integration: document review/fact override → revalidation triggered.
- UI contract: ValidatorTab blocker counts vs live open findings; project decisions tab vs execution_items.
- Ask: POST /api/ask/project returns only read-derived data (no side effects on authoritative tables).
- Cross-surface: after execution resolve, Command Center / Validator / Audit all reflect terminal state (within eventual consistency window).

Run: `npx tsc --noEmit && npm run build && npx vitest run`

---

## 13. Open Questions / Stop Conditions (None Hit)

**Checked and cleared:**
- Multiple competing sources of truth for approval state? → Execution is gated as canonical final; others are projections or historical. Not fully unified in reads, but writes are constrained.
- Route that finalizes finding outside Execution? → No (guard present; outcome route is the writer).
- Findings resolved without audit? → Core paths log activity events.
- Document corrections without fact/validation propagation? → Review and override routes call trigger.
- Validation paths persisting partial findings without run consistency? → persistValidationRun centralizes.
- Cannot determine authoritative table for decisions/execution? → execution_items for final disposition outcomes; project_validation_findings for validator results; decisions for older/triage decision records. Clear enough in code.

**Remaining open (for follow-up, not blocking):**
- Exact usage/reachability of workspace and legacy project pages.
- Whether all evidence anchors in findings/execution carry full page/bbox/row provenance in every rule pack.
- Long-term unification strategy for the various "open item" projections.

---

## Final Verdict

**PASS WITH CONCERNS**

The wiring is mostly correct and honors the Documents → Facts → Validator → Execution → Audit model with Execution as the single final disposition authority. Critical flows are traceable and propagation is present. However, naming, navigation, tab structure, and multiple parallel queue/issue projections create authority ambiguity and operator confusion risk. These are cleanup and labeling issues more than correctness failures today.

**Recommended immediate next step (no code change yet):** Align navigation labels and project tabs with the target simplified surfaces (Overview / Documents / Validator / Audit) and document the single source of truth for each concept (e.g., "blockers" grain and owner).

Report complete. No files were modified during this review.
