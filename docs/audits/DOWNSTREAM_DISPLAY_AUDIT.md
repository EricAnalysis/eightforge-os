# EightForge Downstream Display Audit

## Executive Summary
Short answer: fragmented.

EightForge has the intended downstream concepts in place, but the uploaded project workflow is not yet displayed through one coherent downstream stream. Command Center and Global Decision Queue are mostly driven by `/api/operations` and `loadOperationalQueueModel()`, while Project > Decisions is driven by `useProjectWorkspaceData()` plus `resolveProjectIssueObjects()` over open `project_validation_findings`. Validator reads project validation status/summary plus open findings directly. Execution has a stronger canonical lifecycle around `execution_items`, but it is not consistently the primary source for all action queues.

The biggest coherence risk is that unresolved operator work can be represented as `execution_items`, `project_validation_findings`, `decisions`, project rollup `pending_actions`, and/or derived issue objects. These are not all included by every surface, and status labels are normalized differently. That makes count divergence likely and, in some cases, confirmed by code.

## Surface-to-Data-Source Map
| Surface | Component file | Hook/query/server action | Source table/view/rpc | Filters | Status/severity logic | Shared or inline logic | Notes |
|---|---|---|---|---|---|---|---|
| S1 Command Center summary cards | `app/platform/page.tsx` | `useOperationalModel()` -> `GET /api/operations` -> `loadOperationalQueueModel()` | `decisions`, `workflow_tasks`, `projects`, `documents`, `execution_items`, `project_validation_findings`, `project_validation_evidence`, `document_reviews`, `decision_feedback` | org scoped; decisions `.in(status, DECISION_OPEN_STATUSES)` then `filterCurrentQueueRecords`; execution `.neq(status, resolved)`; findings `.eq(status, open)` | Blocked Projects from rollup status/blocker count; High Risk Projects UI value from `operationalModel.decisions` project ids with critical/high, but subtext from `intelligence.high_risk_count`; Pending Decisions from `intelligence.open_decisions_count` | Mixed shared/inline. Server builds model; page derives cards inline | Confirmed count drift risk: card values and subtexts are not always same basis. |
| S2 Command Center Critical Actions | `app/platform/page.tsx` | Same `useOperationalModel()` payload | `project_rollups.pending_actions` plus `operationalModel.decisions` | Top 2 rollup actions per project; decision actions filtered to blocked/critical/high/needs_correction; dedupe by href/title; cap 6 | Rollup blocker if `approval_status=blocked`, blocked amount, or project blocked; decision blocker if `blocked` or critical | Inline merge in component | Combines rollup pending actions and decision queue items, so it can show action types absent from Decision Queue. |
| S3 Command Center Project Rollups | `app/platform/page.tsx` | Same `useOperationalModel()` payload | `project_rollups` derived by `buildProjectOperationalRollup()`, `augmentRollupWithValidatorActions()`, `mergeProjectRollupWithExecutionItems()` | org/project scoped in server; includes unresolved execution items and selected open validator findings/actions | Blockers from `rollup.blocked_count`; At Risk from only first pending action `primaryRiskAmount()`; Pending Decisions from count of `operationalModel.decisions` by project | Server shared rollup plus inline row shaping | At Risk blank is likely display derivation gap: row ignores non-lead actions and rollup-level amounts do not exist. |
| S4 Global Decision Queue summary counters | `app/platform/decisions/page.tsx` | `useOperationalModel()` unless history mode | `operationalModel.decisions` only by default | Current mode excludes history; optional status/severity/type/assigned/due/age/project filters | `scanSummary` over grouped primaries; blocked via `decisionQueueBucket()`; open excludes resolved/suppressed | Inline grouping/counting | Does not include rollup `pending_actions`; `mapValidatorAction()` exists but is unused. |
| S5 Global Decision Queue item list and filters | `app/platform/decisions/page.tsx` | `useOperationalModel()` current mode or direct Supabase `decisions` in history mode | Current: `operationalModel.decisions`; History: `decisions` table | Current grouped by project/type/queue state; history direct filters; project filter query param | Bucket: resolved/suppressed -> resolved; critical/approval_blocker/blocked -> blocked; in_review/needs_correction -> needs verification | Inline; `mapValidatorAction()` is explicitly orphaned via `void mapValidatorAction` | Confirmed implementation gap: validator rollup actions are not in default list. |
| S6 Project > Decisions summary counters | `components/projects/ProjectDecisionQueueFrame.tsx` via `ProjectIssueBoard` | `ProjectOverview` -> `resolveProjectIssueObjects()` -> `ProjectDecisionQueueFrame` | `project_validation_findings`, `project_validation_evidence`, `execution_items`, `decisions`, `activity_events` | Project scoped; validation findings only `.eq(status, open)` in `useProjectWorkspaceData()` | Open = not resolved/overridden; blocked/escalated/resolvedToday from local lifecycle | Issue object resolver plus frame inline metrics | Counts visible issue cards, not `model.decision_total`. Resolved findings are not loaded, except if represented through open finding state. |
| S7 Project > Decisions decision sections | `components/projects/ProjectDecisionQueueFrame.tsx` | Same issue-object path | Same as S6 | Same as S6 | Buckets: blocked, needs_verification, ready_for_authorization, escalated, overridden, resolved | Inline bucket grouping | Sections are project-scoped issue objects, not the same rows as global `operationalModel.decisions`. |
| S8 Project > Decisions Decision Frame detail panel | `components/projects/ProjectDecisionQueueFrame.tsx` | Selected `IssueObject` or converted `ProjectOverviewDecisionCard` props | Same as S6 | Selection via `decisionId` or `selectedIssue` query param | Detail panel shows lifecycle in "Workflow context"; issue detail shows `Finding type`, `Decision status`, `Execution outcome` | Inline display | Resolved state can be present but visually secondary; if selected state survives local lifecycle changes, detail can feel stale until refresh. |
| S9 Project > Validator Approval Gate | `components/projects/ValidatorTab.tsx` | Direct Supabase client queries | `projects`, `project_validation_findings`, `project_validation_runs`, `project_validation_evidence` | Project id; findings `.eq(status, open)` | `approvalGateLabel()` maps `BLOCKED` to Blocked, `VALIDATED` to Clear, `FINDINGS_OPEN` and `NOT_READY` to Requires Verification | Direct query plus `resolveValidationSummaryFromProjectFacts()` | Requires Verification with 0 blockers is explainable when status is `FINDINGS_OPEN`/`NOT_READY` and blocker count is 0. CTA is too generic. |
| S10 Project > Validator Approval Readiness Gaps | `components/projects/ValidatorTab.tsx` | `resolveCanonicalProjectValidatorWorkspace()` | Derived from project facts, summary, documents, transaction datasets | Project scope through props and loaded summary | Coverage item states: derived/unresolved/resolved/requires_review | Shared `projectFacts.ts` | Support Coverage "Not expected yet" is intentionally generated for `contract_setup`, but appears inside an actionable gap section. |
| S11 Project > Validator Approval Blockers list | `components/projects/ValidatorTab.tsx` | Direct findings query plus canonical blocker matching | `project_validation_findings`, `project_validation_evidence`, `execution_items` for links | Project id; findings `.eq(status, open)`; list requires `isCriticalIssueFinding()` and `isCanonicalValidatorBlockerFinding()` | Critical issue if blocker/high, then only if present in `summary.validator_blockers` | Mixed shared semantics and inline filter | Can show no blockers even when approval gate says Requires Verification for non-blocker review/not-ready conditions. |
| S12 Execution page/source | `components/projects/ProjectExecutionForge.tsx`, `app/api/execution-items/[id]/outcome/route.ts` | Project props from `useProjectWorkspaceData()`; outcome PATCH API | `execution_items`, `project_validation_findings`, `activity_events`; triggers validation | Project scoped; UI includes all statuses; API org scoped | Execution status `open/resolvable/resolved`; outcome `confirmed/resolved/overridden`; open blocks approval | Shared helpers in `executionItems.ts`, route mutation | Most complete lifecycle source, but not currently the sole queue owner. Component appears not mounted in current ProjectOverview tab tree. |
| S13 Audit Trail | `components/projects/ProjectOverview.tsx`, `lib/projectOverview.ts`, `app/api/*` mutation routes | `loadProjectActivityEvents()` plus derived document/validator events | `activity_events`; mutation routes also write legacy `decision_feedback` | Project/document/decision/task/execution/finding scoped | Event type mapped to display label/result/system area | Shared audit mapping in `resolveProjectAuditEvents()` | Execution outcome route writes activity events and updates findings; audit supports lifecycle if events are scoped and loaded. |

## Data Path Groupings
### Group A — Same canonical path
- Command Center summary, Critical Actions, Project Rollups, and the default Global Decision Queue all consume `useOperationalModel()` / `/api/operations`. They share the same payload source, but not the same fields inside that payload.
- Validator Approval Gate, Readiness Gaps, and Approval Blockers share `ValidatorTab` loading plus `resolveValidationSummaryFromProjectFacts()`, but they apply different status/blocker filters.
- Project > Decisions counters, sections, and Decision Frame share `resolveProjectIssueObjects()` through `ProjectIssueBoard`.

### Group B — Same source, different filters
- Command Center Pending Decisions and Decision Queue list both derive from `operationalModel.decisions`, but Command Center also uses rollup pending actions in Critical Actions and rollup blocker counts in project summaries.
- Global Decision Queue current mode uses `/api/operations`; history mode queries `decisions` directly with broader status filters.
- Validator loads only open findings; Execution loads all project execution items. Resolved items are intentionally present in Execution but not in Validator.
- Project > Decisions uses open validation findings and linked execution/decision records; `model.decision_total` uses validator-managed `decisions` only. The subtitle and sections are therefore different counts.

### Group C — Independent/siloed derivation
- Command Center Project Rollups are server-derived from document/decision/task traces plus validator actions plus execution items.
- Global Decision Queue is a separate grouped projection of `operationalModel.decisions`; it excludes rollup pending actions despite having an unused mapper.
- Project > Decisions is an issue-object projection over open validator findings, decisions, execution items, evidence, and audit.
- Validator is a direct project validation view over project summary and open findings.
- Execution is a separate canonical view over `execution_items`.
- Audit is an activity/event history projection.

For Group C surfaces, divergence is partially intentional because each surface has a different job. The implementation gap is that labels imply one queue stream while code uses multiple independent projections.

## Anomaly Findings
### ANOMALY-01 — Command Center vs Decision Queue count mismatch
- Status: confirmed.
- Evidence from code: `app/platform/page.tsx` computes High Risk Projects from project ids in `decisions` but subtext from `operationalModel.intelligence.high_risk_count`; Pending Decisions uses `intelligence.open_decisions_count` while subtext uses `decisions.length`. Decision Queue displays `filteredDecisions.length` after grouping `operationalModel.decisions`. Server `loadOperationalQueueModel()` computes `high_risk_count` as unresolved execution high/critical plus persisted decision high/critical, then returns `decisions: commandCenterDecisionQueueItems`. `app/platform/decisions/page.tsx` also has `mapValidatorAction()` but never includes it.
- Root cause classification: Totals reconciliation issue; duplicate derivation issue; UI consumption issue.
- Operator impact: The same "decision queue" appears to have different open counts and severity counts depending on page.
- Recommended remediation: Define one current actionable item selector for Command Center and Decision Queue. If rollup-only validator actions remain separate, label them "project rollup actions" and exclude from decision counts.

### ANOMALY-02 — Project Rollups "At Risk" column is blank
- Status: likely.
- Evidence from code: `app/platform/page.tsx` sets At Risk from `primaryRiskAmount(leadAction)` only. `leadAction` is `rollup.pending_actions[0]`. If no lead action amount exists, `formatRiskLabel(null)` displays the empty placeholder. No rollup-level at-risk aggregate is read in the row.
- Root cause classification: UI consumption issue; totals reconciliation issue; duplicate derivation issue.
- Operator impact: Projects can have blocker or decision work elsewhere but still show no At Risk value in the rollup table.
- Recommended remediation: Use a rollup-level exposure field if available, or derive from all pending actions consistently with Critical Actions. Avoid showing "--" when the intended meaning is "not calculated".

### ANOMALY-03 — Global Decision Queue blocked items do not appear in Project > Decisions
- Status: confirmed as a structural risk; needs live data for the exact Golden Project rows.
- Evidence from code: Global queue is rebuilt around unresolved `execution_items` in `loadOperationalQueueModel()` lines around the execution queue mapping. Project > Decisions uses `resolveProjectIssueObjects()` over open `project_validation_findings`; it does not render a queue item for an execution item unless it matches an open finding. `buildProjectOverviewModel()` separately filters `model.decisions` to validator-managed `decisions` only. Route links from execution items use `/platform/projects/{projectId}?executionItemId=...#project-decisions`, but `ProjectDecisionQueueFrame` only honors `decisionId` and `selectedIssue`, not `executionItemId`.
- Root cause classification: Lifecycle coupling issue; state synchronization issue; routing/deep-link issue.
- Operator impact: Review from global queue may land on project decisions without selecting or showing the exact blocked execution item.
- Recommended remediation: Make Project > Decisions include canonical execution-backed issue objects or route execution queue items to a mounted Execution surface that honors `executionItemId`.

### ANOMALY-04 — Validator says Requires Verification but shows 0 blockers
- Status: likely labeling issue; needs live summary to classify final cause.
- Evidence from code: `approvalGateLabel()` maps `FINDINGS_OPEN` and `NOT_READY` to "Requires Verification". Blocker count is `summary.blocker_count ?? summary.critical_count ?? summary.validator_blockers.length`; blocker list requires both `isCriticalIssueFinding()` and `isCanonicalValidatorBlockerFinding()`. Therefore a non-blocking open finding, not-ready state, or missing readiness data can show Requires Verification and 0 blockers.
- Root cause classification: Copy/labeling issue; state-machine clarity issue; possible stale rollup issue if summary says `NOT_READY` after findings clear.
- Operator impact: Operator sees a held approval state but no concrete item to resolve.
- Recommended remediation: Split "Blocked", "Needs Review", and "Not Ready / Run Validation" copy. Show the exact non-blocker verification condition or a revalidate/upload CTA.

### ANOMALY-05 — Resolved item persists in Decision Frame
- Status: likely.
- Evidence from code: Project > Decisions can show lifecycle `resolved` when execution is complete, and selected detail remains selected unless the item disappears. `ProjectDecisionQueueFrame` displays lifecycle in a workflow row but the right panel title remains generic "Decision Frame"; resolved state is not a primary banner. Also `useProjectWorkspaceData()` only loads open findings, so fully resolved findings should disappear unless still open or held in local state.
- Root cause classification: UI consumption issue; copy/labeling issue; possible stale selected state.
- Operator impact: Operators can inspect a closed item without an obvious "resolved/history" framing.
- Recommended remediation: Add an explicit resolved banner/state in the Decision Frame and clear selection if an item leaves the active list after refresh.

### ANOMALY-06 — "3 linked decision records" vs "Resolved Today: 1"
- Status: likely expected behavior with bad labeling.
- Evidence from code: `model.decision_total` is `forgeDecisions.length` from validator-managed persisted decisions. `Resolved today` counts rendered decisions whose lifecycle is `resolved` and `updated_at` is after local start-of-day. Visible list may contain multiple resolved items from issue objects, not the same set as `forgeDecisions`.
- Root cause classification: Totals reconciliation issue; copy/labeling issue.
- Operator impact: The subtitle reads like the same scope as counters, but it is not.
- Recommended remediation: Rename subtitle to "linked validator decision records" and counters to "visible project issue stream", or make both derive from the same issue stream.

### ANOMALY-07 — "Truth" vs "Facts" naming inconsistency
- Status: confirmed labeling mismatch.
- Evidence from code: `ProjectOverview.tsx` breadcrumb renders `Documents -> Truth -> Validator -> Decisions -> Audit`; `projectForgeNavigation.ts` tab label is `Facts` and tab key is `facts`. Both use the same component tree.
- Root cause classification: Copy/labeling issue.
- Operator impact: Low functional impact, but it weakens the downstream mental model.
- Recommended remediation: Pick one term. Given the product vision says Documents -> Facts / Truth, use "Facts" for tab and "Facts / Truth" only in explanatory copy, or rename both to "Truth".

### ANOMALY-08 — Support Coverage appears as readiness gap but says Not Expected Yet
- Status: confirmed intentional data state with questionable placement.
- Evidence from code: `resolveCanonicalProjectValidatorWorkspace()` sets support coverage value to "Not expected yet" and state `derived` when `validation_phase` is `contract_setup`. `ValidatorTab` always renders top three coverage items under "Approval Readiness Gaps".
- Root cause classification: Copy/labeling issue; UI consumption issue.
- Operator impact: A non-actionable phase note appears in a section titled "What still needs coverage before approval can settle."
- Recommended remediation: Move derived/not-expected items into informational readiness context or label the section "Readiness Context" when no actionable gaps exist.

### ANOMALY-09 — Internal rule names and technical text leak to user-facing screens
- Status: confirmed.
- Evidence from code: `resolveProjectIssueObjects()` uses `finding.check_key || finding.rule_id` for title and issue type. `ProjectDecisionQueueFrame` shows `Finding type`, `Rule applied`, and raw source keys. `ValidatorTab` falls back to `findingSourceReference()` and raw rule ids. `ProjectExecutionForge` displays `Validator Rule: {validatorRule}`. There is a formatter layer in `truthToAction.ts` and `validator/findingSemantics.ts`, but not every surface uses it for titles.
- Root cause classification: Copy/labeling issue; UI consumption issue.
- Operator impact: Normal users see implementation identifiers instead of what is unresolved, why it matters, and where to act.
- Recommended remediation: Create/use a shared display contract for issue title, explanation, why it matters, recommended action, destination, and evidence label.

## Count Mismatches
| Display | Current count logic | Expected count logic | Why mismatch happens | Recommended fix |
|---|---|---|---|---|
| Command Center High Risk Projects | Unique project ids among `operationalModel.decisions` with critical/high; subtext uses `intelligence.high_risk_count` | Either high-risk projects or high-risk items, not both | Card value and subtext use different metrics | Separate "High Risk Projects" from "High Risk Queue Items" or derive both from same selector |
| Command Center Pending Decisions | `intelligence.open_decisions_count` | Count of current actionable decision/execution items shown when clicking queue | Server includes execution and persisted decision queue items; Project Rollups may add validator actions | Use same grouped queue selector as Decision Queue or label as raw open item count |
| Decision Queue items | Grouped `operationalModel.decisions` after filters | Same current actionable stream Command Center promises | Rollup pending actions are excluded; `mapValidatorAction()` unused | Include validator rollup actions or remove them from Command Center decision copy |
| Project Rollups At Risk | First pending action only | Highest or total unresolved exposure for the project | No project rollup aggregate consumed | Add/display canonical rollup exposure; otherwise "Not calculated" |
| Project > Decisions linked records | `model.decision_total` from validator-managed persisted decisions | Same stream shown in sections | Sections render issue objects from open findings; subtitle counts persisted decisions | Align subtitle with issue stream or add separate "linked records" row |
| Project > Decisions Resolved Today | Rendered decisions with lifecycle resolved and updated today | Clearly labeled date-filtered count | Other resolved visible items may be older or from different stream | Rename to "Resolved today" with all-resolved count beside it |
| Validator Critical Mismatches | `blocker_count ?? critical_count ?? validator_blockers.length` | Count of actual blockers shown in Approval Blockers list | Gate can be Requires Verification for non-blocker status | Add separate "Open review items" and "Approval blockers" metrics |

## State Machine / Lifecycle Problems
- `validation_findings`: persisted statuses are `open`, `resolved`, `dismissed`, `muted`. Display also derives `blocker`, `warning`, `info`, `requires_review`, `business_severity`, and `approval_gate_effect`.
- `execution_items`: persisted statuses are `open`, `resolvable`, `resolved`; outcomes are `confirmed`, `resolved`, `overridden`. UI treats `open` as approval-blocking.
- `decisions`: persisted statuses include `open`, `in_review`, `resolved`, `dismissed`, `suppressed`; some UI also references `needs_review`, `flagged`, and `draft` as open-like.
- `project rollup / approval state`: persisted/project-derived `validation_status` includes `NOT_READY`, `BLOCKED`, `VALIDATED`, `FINDINGS_OPEN`; `validator_status` includes `READY`, `BLOCKED`, `NEEDS_REVIEW`.
- Display-only labels overlap: "Requires Verification" can mean `BLOCKED`, `FINDINGS_OPEN`, `NOT_READY`, `execution_items.open`, or a finding with `approval_gate_effect=blocks_approval`.
- Suppressed/stale semantics are incomplete in downstream displays. `filterCurrentQueueRecords()` only removes superseded generated records via metadata; execution suppression is represented by `suppression_signature` after resolution, not a first-class visible state in all queues.
- Project > Decisions uses issue lifecycle states (`open`, `blocked`, `needs_verification`, `ready_for_auth`, `escalated`, `resolved`) that are not persisted as such.

## Operator Journey Break Analysis
STEP 1: Command Center -> Decision Queue.
- Classification: CONFIRMED BREAK.
- Counts do not necessarily reconcile because Command Center mixes rollup actions, execution items, persisted decisions, and intelligence counters, while Decision Queue lists grouped `operationalModel.decisions` only.

STEP 2: Global blocked Golden Project item -> Review -> Project context.
- Classification: LIKELY BREAK.
- Execution item links include `executionItemId` and `#project-decisions`; project Decision Frame selection honors `decisionId` and `selectedIssue`, not `executionItemId`. If the item does not correspond to an open finding in `resolveProjectIssueObjects()`, it will not be selected or visible.

STEP 3: Project > Validator Requires Verification.
- Classification: LABELING ISSUE, with NEEDS DATA for stale rollup.
- Code supports Requires Verification with no blockers for `FINDINGS_OPEN`/`NOT_READY`. The screen does not always identify the exact verification condition.

STEP 4: Project > Decisions count reconciliation.
- Classification: LIKELY BREAK.
- Subtitle counts `model.decision_total`; counters count rendered issue cards; resolved today is date-filtered. These are related but not identical concepts.

STEP 5: Resolve/correct/override lifecycle.
- Classification: PARTIALLY SUPPORTED.
- Execution outcome route updates `execution_items`, updates linked `project_validation_findings`, logs `activity_events`, and triggers validation. Decision status route prevents approval-impacting outcomes from bypassing Execution. The display refresh path exists, but not all downstream surfaces consume the same execution-owned lifecycle.

## User-Facing Copy Problems
| Current internal/system text | Problem | Better user-facing title | Better explanation | Why it matters | Recommended action | Destination screen/action |
|---|---|---|---|---|---|---|
| `FINANCIAL_RATE_CODE_MISSING:fact:...:line:4` | Raw rule/check key leaks | Missing invoice rate code | This invoice line does not include a billing code EightForge can match to project pricing truth. | The line cannot be tied confidently to authorized contract pricing. | Review the invoice line and add/confirm the correct billing key or mark not applicable. | Project > Decisions or Execution item detail |
| `TRANSACTION_MISSING_INVOICE_LINK` | Internal rule id; unclear action | Transaction row not linked to invoice | A transaction/support row is not connected to the invoice line it supports. | The billed work may not have auditable support. | Link the row to the invoice or exclude it from approval support. | Project > Decisions, Execution, or evidence inspector |
| `Rate Code does not match the expected project truth` | Abstract and system-centric | Invoice rate code needs review | The billed rate code does not match the contract or project billing structure currently resolved as truth. | Payment could be approved against the wrong rate schedule. | Compare the invoice line to governing contract pricing and correct or override with a reason. | Validator blocker or Execution detail |
| `Activation trigger detected but status unresolved` | Technical contract parser language | Contract activation needs confirmation | The contract appears to reference an activation or authorization step, but EightForge does not know whether it applies here. | Approval may require a notice to proceed or similar authorization. | Confirm whether authorization is required; attach it or document that it is not applicable. | Validator > Readiness / Documents |
| `Pricing schedule present, applicability unresolved` | Missing operator destination | Pricing schedule applicability unclear | A rate schedule exists, but EightForge cannot confirm it governs the billed work. | The project may use the wrong pricing basis. | Confirm the governing rate schedule or document the alternate pricing clause. | Validator > Approval Blockers |
| `Support Coverage / DERIVED / Not expected yet` | Non-actionable item in gap section | Support coverage not required for this phase | The project is in contract setup, so ticket/transaction support is not expected yet. | This should not block current phase approval. | No action until execution or billing review begins. | Informational readiness context |
| `Validator Rule: X` | Exposes implementation id as primary label | Rule reference | Internal rule used to create this item. | Useful for audit, not primary operator guidance. | Keep in secondary metadata only. | Execution detail metadata |
| `Finding type` showing check key | Type is not human-readable | Issue category | Plain category such as Invoice, Contract, Support, or Cross-document. | Operators scan categories faster than rule ids. | Use semantic formatter from finding semantics. | Project Decision Frame |

## Recommended Downstream Display Contract
`validation_findings`:
- Own raw rule outputs, technical evidence, and validator semantics.
- Can be active/resolved/dismissed/muted.
- Should not be the primary operator queue unless routed into an action item.

`execution_items`:
- Own operator-actionable work.
- Should power active queues, blockers, "needs verification", next actions, and exact deep links.
- Should be the canonical lifecycle owner for approval-impacting work.

`decision_records` / `decisions`:
- Own judgment, disposition, and resolution history.
- Should record approve/correct/override/verify outcomes or link to execution outcomes.
- Should support detail panels and audit context, not independently create active queue state once execution item exists.

`project_rollup`:
- Derived project-level state.
- Should not independently invent counts.
- Should derive from unresolved execution items plus unresolved validator/decision state through one selector.

`command_center`:
- Cross-project action summary.
- Should show current actionable work only.
- Every item should deep-link to the exact actionable item.

`project_decisions`:
- Project-scoped view of the same actionable/resolution stream.
- Should clearly separate active execution work from resolved/history.

`validator`:
- Approval readiness explanation.
- Should show why approval is held and link to the exact action.
- Should distinguish Blocked, Needs Review, Not Ready, and Informational.

`audit`:
- Historical trace.
- Should include resolved, corrected, overridden, suppressed, and stale lifecycle events.

## Ranked Fix Plan
| Priority | Anomaly | Recommended fix | Likely files | Fix type | Blast radius | Operator approval required | Suggested verification |
|---|---|---|---|---|---|---|---|
| P0 | 03 | Route/open global execution queue items to a project surface that renders and selects the exact `executionItemId`; or include execution-backed issue cards in Project > Decisions | `components/projects/ProjectOverview.tsx`, `ProjectDecisionQueueFrame.tsx`, `ProjectIssueBoard.tsx`, `resolveProjectIssueObjects.ts`, maybe `ProjectExecutionForge.tsx` | routing/state-machine/display | High if shared issue resolver changes | Yes | Click global blocked item; exact item appears selected with same status |
| P0 | 01 | Unify current actionable queue selector used by Command Center and Decision Queue | `lib/server/operationalQueue.ts`, `app/platform/page.tsx`, `app/platform/decisions/page.tsx` | query/display | High; shared hook used by multiple surfaces | Yes | Command Center count equals Decision Queue count under no filters |
| P1 | 04 | Split Validator gate states into Blocked / Needs Review / Not Ready; show exact CTA for non-blocker Requires Verification | `components/projects/ValidatorTab.tsx`, `lib/projectFacts.ts` | display/state-machine | Medium | Yes | Project with 0 blockers explains remaining verification or validation requirement |
| P1 | 06 | Align Project > Decisions subtitle and counters to one scope | `components/projects/ProjectOverview.tsx`, `ProjectDecisionQueueFrame.tsx` | display-only | Low | Yes | Linked records, open, blocked, resolved totals reconcile with sections |
| P1 | 02 | Replace At Risk first-action display with canonical aggregate or explicit "Not calculated" | `app/platform/page.tsx`, possibly `lib/server/operationalQueue.ts` | display/query | Medium | Yes if adding aggregate | Rollup At Risk matches highest/total exposure on action cards |
| P2 | 05 | Add resolved/history banner in Decision Frame and clear stale selection after refresh | `ProjectDecisionQueueFrame.tsx` | display-only | Low | No | Resolved selected item visibly reads as resolved/history |
| P2 | 08 | Move "Not expected yet" Support Coverage out of readiness gaps or mark informational | `ValidatorTab.tsx`, `projectFacts.ts` | display-only | Low | Yes for product wording | Contract setup phase no longer implies an actionable gap |
| P3 | 09 | Introduce shared issue display formatter and replace raw title/check-key fallbacks | `truthToAction.ts`, `findingSemantics.ts`, `resolveProjectIssueObjects.ts`, `ValidatorTab.tsx`, `ProjectExecutionForge.tsx`, `ProjectDecisionQueueFrame.tsx` | display-only | Medium | Yes | All listed rule ids render plain-English title, explanation, action, evidence label |
| P4 | 07 | Normalize "Truth" vs "Facts" label | `ProjectOverview.tsx`, `projectForgeNavigation.ts` | display-only | Low | Yes | Breadcrumb and tab use same term |

## Open Questions for Operator
- Should `execution_items` be the single owner of current operator queue state across Command Center, Decision Queue, and Project > Decisions?
- Should non-actionable readiness context such as "Support Coverage: Not expected yet" remain visible on Validator, and if yes, should it move out of "gaps"?
- Should Project > Decisions show resolved history by default, or should resolved items move to Audit/History with an explicit filter?
- Should the user-facing downstream label be "Facts", "Truth", or "Facts / Truth"?
- Is "Pending Decisions" intended to count persisted decisions only, execution items only, or all current actionable work?

## Files Reviewed
- `app/platform/page.tsx`
- `app/platform/decisions/page.tsx`
- `app/platform/projects/[id]/page.tsx`
- `app/projects/[projectId]/decisions/page.tsx`
- `app/api/operations/route.ts`
- `app/api/execution-items/[id]/outcome/route.ts`
- `app/api/decisions/[id]/status/route.ts`
- `app/api/decisions/[id]/feedback/route.ts`
- `components/projects/ProjectOverview.tsx`
- `components/projects/ProjectIssueBoard.tsx`
- `components/projects/ProjectDecisionQueueFrame.tsx`
- `components/projects/ProjectExecutionForge.tsx`
- `components/projects/ValidatorTab.tsx`
- `lib/useOperationalModel.ts`
- `lib/useProjectWorkspaceData.ts`
- `lib/server/operationalQueue.ts`
- `lib/projectOverview.ts`
- `lib/projectFacts.ts`
- `lib/resolveProjectIssueObjects.ts`
- `lib/issueObjects.ts`
- `lib/executionItems.ts`
- `lib/projectExecutionResolution.ts`
- `lib/projectDecisionResolution.ts`
- `lib/truthToAction.ts`
- `lib/currentWork.ts`
- `lib/projectForgeNavigation.ts`
- `lib/validator/queueFindingActions.ts`
- `lib/validator/findingSemantics.ts`
- `types/validator.ts`
- `supabase/migrations/20260401000000_project_validator_phase0_schema.sql`
- `supabase/migrations/20260506000000_execution_items.sql`
- `supabase/migrations/20250314000000_deterministic_decision_backbone.sql`
- `supabase/migrations/20250313000000_add_activity_events.sql`
