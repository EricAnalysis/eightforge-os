# EightForge Downstream Display Audit — Phase A (Verified)

Status: READ-ONLY. No files modified. No Phase B work performed.
Scope: code-path verification only — exact counts ("2/8", "6 items", "3 linked records")
were not re-checked against live Supabase data; findings below are mechanism-level and
hold regardless of the specific numbers in the screenshots.

Note: `git status` shows ~650 files as "modified," all CRLF/LF line-ending churn only
(byte-identical content otherwise — confirmed via `git diff` on `app/platform/page.tsx`).
Not a Phase-B-already-happened situation; safe to ignore for this audit. A stale
`.git/index.lock` exists and may need manual cleanup before any future commit.

A pre-existing file `DOWNSTREAM_DISPLAY_AUDIT.md` (untracked, repo root) already covers
this exact ground. This document independently re-verifies its claims against current
code, confirms most of them, and corrects two (see ANOMALY-01).

---

## Section 1 — Surface-to-Data-Source Map

| Surface | Component file | Hook / query | Tables | Filters | Shared vs inline | Fetch pattern |
|---|---|---|---|---|---|---|
| S1 Command Center summary cards | `app/platform/page.tsx:295-366` | `useOperationalModel()` → `GET /api/operations` → `loadOperationalQueueModel()` (`lib/server/operationalQueue.ts:1700`) | `decisions`, `execution_items`, `projects`, `documents`, validation tables (org-scoped) | `decisions.in(status, DECISION_OPEN_STATUSES)` + `filterCurrentQueueRecords`; `execution_items` filtered to `status !== 'resolved'` | Server payload shared; card derivation (project-count vs item-count) inline | fetch-on-mount via hook |
| S2 Critical Actions | `app/platform/page.tsx:369-394` | same payload | `project_rollups.pending_actions` + `operationalModel.decisions` | top-2 rollup actions/project; decision actions filtered to blocked/critical/high/needs_correction; capped at 6 | Inline merge | same fetch |
| S3 Project Rollups table | `app/platform/page.tsx:437-441` | same payload | `project_rollups` (server-built via `buildProjectOperationalRollup` etc., `lib/projectOverview.ts:380-428`) | At Risk = `primaryRiskAmount(rollup.pending_actions[0])` only | Inline; no rollup-level aggregate exists in the type | same fetch |
| S4 Decision Queue counters | `app/platform/decisions/page.tsx:242-294,706-721` | `useOperationalModel()` (current mode) | `operationalModel.decisions` | grouped via `groupDecisionQueueItems()` by `(project_id, decision_type, queue_state)`; `scanSummary` over groups | Inline grouping | same fetch; history mode queries `decisions` table directly |
| S5 Decision Queue item list | `app/platform/decisions/page.tsx` | same | same | `mapValidatorAction()` defined (407-491) but neutralized via `void mapValidatorAction` (492) — never included | Inline; confirmed orphaned function | same |
| S6 Project Decisions counters | `components/projects/ProjectOverview.tsx:1167-1191` → `ProjectIssueBoard` → `ProjectDecisionQueueFrame.tsx:296-309` | `useProjectWorkspaceData()` → `resolveProjectIssueObjects()` | `project_validation_findings` (`.eq('status','open')`, lines 405-409), `execution_items` (no status filter, 416-420), `decisions` (4 queries, no status filter, 544-589), `project_validation_evidence` | Counters computed from `lifecycleState`/`updated_at` over open-findings-derived issue objects | Shared issue-object pipeline | fetch-on-mount |
| S7 Project Decisions list (Blocked/Needs Verification/Resolved) | `ProjectDecisionQueueFrame.tsx:393-585` | same | same | bucketed by `lifecycleState` (`resolveProjectIssueObjects.ts:209-233`) | same shared pipeline | same |
| S8 Decision Frame detail panel | `ProjectDecisionQueueFrame.tsx:67-222` (`IssueDetailSurface`) | same | same | selection via `decisionId` / `selectedIssue` query params (228-229); **not** `executionItemId` | same shared pipeline, but "Decision status" field (line 136) reads raw `decision.status`, a *different* field than the bucket's `lifecycleState` | same |
| S9 Validator Approval Gate | `components/projects/ValidatorTab.tsx:1064-1196` | `loadValidatorState()` (queries 756-774) | `projects` (`validation_status`, `validation_summary_json`), `project_validation_findings.eq(status,'open')` | `approvalGateLabel()` (409-420): `BLOCKED`→Blocked, `VALIDATED`→Clear, `FINDINGS_OPEN` & `NOT_READY`→"Requires Verification"; blocker count = `summary.blocker_count ?? summary.critical_count ?? summary.validator_blockers.length` (1082-1085) | `resolveValidationSummaryFromProjectFacts()` shared | fetch-on-mount |
| S10 Approval Readiness Gaps | `ValidatorTab.tsx:1073-1079,1210-1235` | `resolveCanonicalProjectValidatorWorkspace()` (`lib/projectFacts.ts:~4588-4667`) | derived from project facts/summary | top-3 `coverage_items` by `order`, filtered only by `COVERAGE_ITEM_CONFIG[item.key] != null` — no actionability filter | Shared `projectFacts.ts` | same |
| S11 Approval Blockers list | `ValidatorTab.tsx:1055-1063,1237-1303` | same `loadValidatorState()` | `project_validation_findings`, `project_validation_evidence` | `isCriticalIssueFinding()` AND `isCanonicalValidatorBlockerFinding()` (509-544) against `summary.validator_blockers` | Mixed shared/inline | same |

---

## Section 2 — Data Path Groupings

**GROUP-A (same path, compatible filters — count consistency guaranteed)**
- S1 "Pending Decisions": headline (`intelligence.open_decisions_count`) and subtext (`decisions.length`) both equal `commandCenterDecisionQueueItems.length` (`operationalQueue.ts:2034,2038`) — **identical array, identical length**. (This corrects the prior audit, which implied a basis mismatch here — see ANOMALY-01.)
- S6+S7+S8: all three render from one shared `issueObjects`/`renderedDecisions` array via `ProjectDecisionQueueFrame`. Internally consistent *as an array*, though S8 surfaces a second, independently-sourced field (Group C).
- S9 findings query and S11 findings query both start from the same `project_validation_findings.eq(status,'open')` result set from `loadValidatorState()`.

**GROUP-B (same source, different filters/aggregation — divergence expected, must be labeled)**
- S1 "High Risk Projects": headline = unique project_ids (from `commandCenterDecisionQueueItems`) with severity critical/high; subtext = item count with severity critical/high. Same source array, different grain (projects vs items).
- S4/S5 vs S2: S4/S5 group `commandCenterDecisionQueueItems` via `groupDecisionQueueItems()` (collapsing by project/type/queue-state) and exclude validator-rollup `pending_actions` (orphaned `mapValidatorAction`); S2 includes rollup `pending_actions` directly and is uncapped by grouping. Same root array, different transforms → different totals by design, but not labeled as such.
- S9 vs S11: both start from open findings, but S11 applies two extra filters (`isCriticalIssueFinding` + `isCanonicalValidatorBlockerFinding` against `validator_blockers`). S9's blocker count comes from `validation_summary_json`, a precomputed aggregate that may not match S11's live filtered list 1:1.

**GROUP-C (independent/siloed derivation — architectural drift risk)**
- S3 "At Risk": sourced solely from `pending_actions[0]`; `ProjectOperationalRollup` (`lib/projectOverview.ts:380-428`) has **no rollup-level exposure/at-risk aggregate field at all**. Independent of S2, which iterates *all* pending actions.
- S4/S5 (global queue: `execution_items` + `decisions` via `loadOperationalQueueModel`) vs S6/S7/S8 (project queue: `project_validation_findings.eq(status,'open')` via `resolveProjectIssueObjects`) — **entirely different tables/derivations** for what reads as "the same queue at two scopes." Root of ANOMALY-03. **Confirmed unintentional gap** (no shared selector, no scope-mapping contract).
- S6 header ("N linked decision records" = `model.decision_total`, count of validator-managed `decisions` rows, all statuses, `lib/projectOverview.ts:3254`) vs S6 counters (Open/Blocked/Escalated/Resolved Today, derived from open-findings issue objects). Two independent derivations in one panel. Root of ANOMALY-06. **Confirmed unintentional** — looks like one metric, isn't.
- S8 "Decision status" (raw `decisions.status`) vs S7 bucket placement (`lifecycleState`, derived from `execution_items` completeness, `resolveProjectIssueObjects.ts:177-233`). Two independently-computed status fields shown together with no reconciliation. Root of ANOMALY-05. **Confirmed unintentional.**
- S10 Support Coverage item: derived independently in `projectFacts.ts` from `validation_phase`, unconditionally injected into "Approval Readiness Gaps" with no actionability filter. Root of ANOMALY-08. **Intentional data state, unintentional placement** (see Section 4).
- ANOMALY-07: not a data-path issue — two hardcoded string literals (`ProjectOverview.tsx:1515` breadcrumb "Truth"; `lib/projectForgeNavigation.ts:12` tab `label: 'Facts'`) for the same `facts`/`project-facts` tab. **Confirmed unintentional** copy drift.

---

## Section 3 — Operator Journey Break Analysis

| Step | Description | Classification | Evidence |
|---|---|---|---|
| 1 | Command Center "Pending Decisions"/"High Risk Projects" → Decision Queue | **CONFIRMED BREAK** (mechanism differs from initial hypothesis) | "Pending Decisions" headline/subtext are NOT a basis mismatch (Group A, refuted). "High Risk Projects" headline (project-count) vs subtext (item-count) IS a real grain mismatch (Group B). Decision Queue's lower total vs Command Center is driven by `groupDecisionQueueItems()` collapsing duplicates + `mapValidatorAction` exclusion — a transform difference, not a different table. |
| 2 | Click REVIEW on a blocked Golden Project item → Project Decisions tab | **CONFIRMED BREAK — HIGHEST PRIORITY** | `?executionItemId=...#project-decisions` deep link is read only by `ProjectExecutionForge.tsx`/`ValidatorTab.tsx`; `ProjectDecisionQueueFrame.tsx:228-229` reads only `decisionId`/`selectedIssue`. Additionally, an `execution_item` with no matching **open** `project_validation_findings` row produces **no issue object at all** in `resolveProjectIssueObjects()` — it's invisible to S6/S7/S8 regardless of routing. |
| 3 | Validator "Requires Verification" with 0 blockers | **LABELLING ISSUE + missing CTA** (not a state-machine bug) | `FINDINGS_OPEN` and `NOT_READY` both render as "Requires Verification" (`ValidatorTab.tsx:409-420`). "Revalidate Project" button exists (always rendered, 1115-1140) but is not contextually tied to this state, and gate explanation text doesn't reference it. |
| 4 | Project Decisions "3 linked decision records" vs "Resolved Today: 1" | **CONFIRMED BREAK** | Three independent count bases in one panel: `model.decision_total` (all-status validator-managed `decisions` rows, =3), open/blocked/escalated counters (open-findings issue objects), and "Resolved Today" (date-filtered subset of those, `updated_at >= startOfToday`). 3 resolved items with only 1 updated today is internally consistent but the label "linked decision records" doesn't telegraph a different scope than the counters below it. |
| 5 | Select a Resolved decision → Decision Frame panel | **CONFIRMED BREAK** (not staleness) | Decision Frame's "Decision status" row reads raw `decisions.status` (`ProjectDecisionQueueFrame.tsx:136`), while the list bucket uses `lifecycleState` (can be `'resolved'` via `execution_items` completeness without `decisions.status` itself being `resolved`/`dismissed`/`suppressed`). Diverges on every render for the same item — no refresh needed to reproduce. |

---

## Section 4 — Root Cause Classification

| Anomaly | Classification | Notes |
|---|---|---|
| 01 | Totals reconciliation issue + UI consumption issue + duplicate derivation issue | "Pending Decisions" headline/subtext pairing is fine (refuted divergence); "High Risk Projects" project-vs-item grain and Decision-Queue-vs-Command-Center grouping/exclusion are the real issues. |
| 02 | UI consumption issue + totals reconciliation issue | No canonical rollup-level "at risk" aggregate exists in `ProjectOperationalRollup` — this is a genuine missing-field gap, not just a display bug. A full fix likely needs a new derived field; an interim fix is display-only ("Not calculated" instead of "--"). |
| 03 | Lifecycle coupling issue + state synchronization issue + relationship/governance (routing) issue | Highest-priority. Two independent derivation paths (global execution/decisions vs project open-findings) plus a deep-link param mismatch. |
| 04 | Validation rule issue (label-mapping collapse) + UI consumption issue (no CTA) | Underlying `validation_status`/`validator_blockers` computation is correct; the gap is presentation — two distinct statuses (`FINDINGS_OPEN`, `NOT_READY`) share one label and neither gets an explanatory CTA. |
| 05 | State synchronization issue + UI consumption issue | Two status fields (`lifecycleState` vs `decisions.status`) rendered in the same component without reconciliation. |
| 06 | Totals reconciliation issue + UI consumption issue | Header metric and counters below it are different streams; needs either relabeling or unification. |
| 07 | Copy/labeling issue only | Two hardcoded string literals for the same tab. Trivial. |
| 08 | UI consumption issue + copy/labeling issue | Underlying data (`state: 'derived'`, `value: 'Not expected yet'`) is correct for `contract_setup` phase; placement under "Approval Readiness Gaps" with no actionability filter is the issue. |

---

## Section 5 — Ranked Remediation Candidates

| Rank | Anomaly | Fix type | Files | Blast radius | Notes |
|---|---|---|---|---|---|
| P0 | 03 | routing/state-machine + display | `ProjectDecisionQueueFrame.tsx`, `resolveProjectIssueObjects.ts`, `ProjectIssueBoard.tsx`, possibly `ProjectExecutionForge.tsx` | **High** — `resolveProjectIssueObjects()` feeds S6+S7+S8 (3 surfaces); per repo guardrails ("if a fix requires touching a shared hook used by more than 3 surfaces, STOP"), this is at/near the threshold and should be scoped with the operator before starting. | Two viable directions: (a) broaden issue-object resolution to include execution items without matching open findings, or (b) route global "Review" links for execution-item-only blockers to a surface that already honors `executionItemId` (Execution tab). Needs an open-question decision (Section 6) before implementation. |
| P0 | 06 | display-only (label) or query alignment | `ProjectOverview.tsx`, `ProjectDecisionQueueFrame.tsx` | Low | Cheapest high-impact fix: rename "N linked decision records" to specify its scope (validator-managed `decisions` rows) distinct from the issue-stream counters, or compute both from one stream. |
| P1 | 04 | display/copy | `ValidatorTab.tsx` | Low-Medium | Split "Requires Verification" into distinct labels for `FINDINGS_OPEN` vs `NOT_READY`, and surface "Revalidate Project" as the explicit next action when blockers=0. No state-machine change. |
| P1 | 05 | display-only | `ProjectDecisionQueueFrame.tsx` | Low | Show `lifecycleState`-derived resolved badge in the Decision Frame, or reconcile the "Decision status" field with `lifecycleState` before display. |
| P1 | 01 | display/labeling (+ optional grouping alignment) | `app/platform/page.tsx`, `app/platform/decisions/page.tsx` | Low for labeling; Medium-High if unifying grouping/`mapValidatorAction` across S2/S4/S5 | Minimum fix: label "High Risk Projects" card as "X projects / Y items" explicitly. Full reconciliation of Decision Queue vs Command Center totals requires touching shared grouping logic — flag per guardrails if it spans >3 surfaces. |
| P2 | 02 | display-only (interim) / schema+query (full) | `app/platform/page.tsx`, `lib/projectOverview.ts` | Low (interim) / Medium (full) | Interim: replace silent "--" with "Not calculated". Full fix needs a new canonical at-risk aggregate — schema-adjacent, requires explicit scoping per CLAUDE.md ("Do not add schema changes unless explicitly scoped"). |
| P2 | 08 | display-only | `ValidatorTab.tsx` | Low | Filter `state==='derived'`/non-actionable items out of "Approval Readiness Gaps", or move to a separate "Readiness Context" section. |
| P3 | 07 | copy-only | `ProjectOverview.tsx:1515` or `lib/projectForgeNavigation.ts:12` | Minimal | Pick one term ("Facts" recommended, matches tab key/route `project-facts`) and align the breadcrumb literal. |

---

## Section 6 — Open Questions for Operator

1. **ANOMALY-03 (P0):** Should `resolveProjectIssueObjects()` (shared by S6/S7/S8, and possibly other consumers — needs a grep for all callers before scoping) be broadened to surface execution items without a matching open finding? Or should the global queue's "Review" action for execution-item-only blockers route to the Execution tab (which already reads `executionItemId`)? This determines whether the fix is "shared-hook" (>3-surface, needs explicit go-ahead per repo guardrails) or "routing-only."
2. **ANOMALY-01:** Is "High Risk Projects" intended to count distinct projects or queue items? Pick one for the headline and label the other explicitly.
3. **ANOMALY-01/05:** Should Decision Queue (S4/S5) wire up the orphaned `mapValidatorAction()` so validator-rollup actions appear there too (matching Command Center's Critical Actions), or should Critical Actions stop showing rollup-only actions that never appear in the Decision Queue?
4. **ANOMALY-02:** Is a canonical project-level "at risk" / exposure aggregate planned (schema addition), or is "Not calculated" an acceptable interim label until one exists?
5. **ANOMALY-06:** Should "N linked decision records" be relabeled to reflect its actual scope (validator-managed `decisions` table rows), or should the header and counters be unified onto one stream?
6. **ANOMALY-07:** Is "Facts" or "Truth" the canonical product term? (Tab key/route is `facts`/`project-facts`, suggesting "Facts" — but "Truth" appears elsewhere in `ProjectOverview.tsx`, e.g. "Project Truth Snapshot".)
7. **Process:** A stale `.git/index.lock` exists in the repo. Should this be cleared before any future commit work? (Read-only audit was unaffected, but `git add`/`commit` will fail until removed.)

DO NOT PROCEED TO PHASE B until these are resolved and the ranked list above is approved.
