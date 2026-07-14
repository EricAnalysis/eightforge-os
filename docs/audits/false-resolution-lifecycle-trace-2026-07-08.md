# False Resolution Lifecycle Trace - 2026-07-08

Scope: read-only investigation of the Golden Project false-resolution mismatch where `resolveProjectIssueObjects.findingBacked` computes `legacy_value = 'resolved'` while `project_validation_findings.lifecycle_state = 'open'`.

Confirmed input facts accepted as given:

- `state_projection_shadow_mismatches` contains exactly 5 rows for Golden Project `437502f2-d46d-447f-81e3-f26fa7ba0c14`, all `record_type = project_validation_finding`, `surface = resolveProjectIssueObjects.findingBacked`, `legacy_value = 'resolved'`, `persisted_value = 'open'`.
- Finding IDs: `3dbfbda2-bd0c-433e-93bc-344cee0d8962`, `01e98db7-8f49-49a6-856c-dc751195f2a3`, `385da71a-b530-454d-b805-b91a4aba8bcd`, `08f050fc-8661-4b93-9cb8-df577e9799ce`, `8598921a-217c-4685-8800-d2b364cbfa27`.
- All 5 are persisted `status = 'open'`, `lifecycle_state = 'open'`, `linked_decision_id = null`, `resolved_at = null`.

## Verdict

Authoritative value is persisted `project_validation_findings.lifecycle_state = 'open'` because the persisted write path only makes these findings legitimately resolved by changing finding `status` away from `open` and stamping resolver evidence (`resolved_by_user_id` and/or `resolved_at`), or by linking a decision whose persisted status/details derive a terminal lifecycle. These 5 rows have none of that evidence. The legacy computed `resolved` value is a stale execution projection caused by resolved `execution_items` rows whose `source_id` still equals the open finding ID.

## Proof 1 - Where `resolved` Comes From

### Current matcher is not fuzzy

The suspected fuzzy clauses do not exist in the current `lib/resolveProjectIssueObjects.ts` implementation. `decisionMatchesFinding(candidate, finding)` only checks:

```ts
if (finding.linked_decision_id && decision.id === finding.linked_decision_id) return true;
return decisionFindingIds(decision).includes(finding.id);
```

Evidence: `lib/resolveProjectIssueObjects.ts:164-166`.

`decisionFindingIds(decision)` reads only `details.source_finding_ids`, `details.validator_finding_ids`, and `details.validator_finding_id` (`lib/resolveProjectIssueObjects.ts:152-161`). There is no check-key match, subject match, category heuristic, or invoice-context fuzzy match in this path.

### Step trace for finding `3dbfbda2-bd0c-433e-93bc-344cee0d8962`

Persisted finding values:

- `rule_id`: `FINANCIAL_RATE_CODE_MISSING`
- `check_key`: `FINANCIAL_RATE_CODE_MISSING:fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:4`
- `subject_type`: `invoice_line`
- `subject_id`: `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:4`
- `severity`: `info`
- `status`: `open`
- `lifecycle_state`: `open`
- `linked_decision_id`: `null`
- `linked_action_id`: `null`
- `resolved_by_user_id`: `null`
- `resolved_at`: `null`

Decision matching:

| Decision | Status | Detail finding IDs | Matcher result |
|---|---:|---:|---|
| `18df4ecf-c3f8-474f-9c12-4de0559b9d41` | `resolved` | `[]` | `false` |
| `aa2704f0-c80b-4729-971a-f644dd76feb3` | `resolved` | `[]` | `false` |
| `b4783705-3ec6-4198-99bd-38946e39840c` | `resolved` | `[]` | `false` |
| `1dfa01d2-7e09-4e5b-a419-2eec9b8aaa74` | `dismissed` | `[]` | `false` |
| `f0fad384-78bf-4a6a-a068-ae16793b3797` | `resolved` | `[]` | `false` |
| `f3ebe42e-f741-42ec-b091-238e0c808ef3` | `dismissed` | `[]` | `false` |

So `decision = null` and `decisionId = null`.

Execution matching:

`executionMatchesFinding(candidate, finding, decisionId)` returns true through this clause:

```ts
if (item.source_type === 'validator_finding' && item.source_id === finding.id) return true;
```

Evidence: `lib/resolveProjectIssueObjects.ts:176`.

Matching execution row:

- `id`: `1bd629a4-a471-4a28-89fc-8cd89cf88b3a`
- `source_type`: `validator_finding`
- `source_id`: `3dbfbda2-bd0c-433e-93bc-344cee0d8962`
- `source_key`: `FINANCIAL_RATE_CODE_MISSING:fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:4`
- `validator_rule_key`: `FINANCIAL_RATE_CODE_MISSING`
- `status`: `resolved`
- `outcome`: `resolved`
- `resolved_at`: `2026-06-02T14:56:33.756+00:00`

`statusForRecords(decision, executionItem)` computes `COMPLETE` because `isExecutionComplete(executionItem)` returns true for `executionItem.status === 'resolved'`.

```ts
if (isExecutionComplete(executionItem)) return 'COMPLETE';
if (executionItem) return 'EXECUTING';
if (decision) return 'DECIDED';
return 'FINDING';
```

Evidence: `lib/resolveProjectIssueObjects.ts:189-196`.

`lifecycleForIssue({ finding, decision, status })` then returns `resolved` from its first branch:

```ts
if (status === 'COMPLETE') return 'resolved';
```

Evidence: `lib/resolveProjectIssueObjects.ts:214-220`.

### All 5 mismatch rows follow the same execution-item path

| Finding | Subject | Matching resolved execution item | Execution clause |
|---|---|---|---|
| `8598921a-217c-4685-8800-d2b364cbfa27` | `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:2` | `bfe58369-bbef-489f-a2df-064ea9386755` | `source_type/source_id` |
| `01e98db7-8f49-49a6-856c-dc751195f2a3` | `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:3` | `1c088b15-f92e-490c-b97d-04e4ad1a3362` | `source_type/source_id` |
| `3dbfbda2-bd0c-433e-93bc-344cee0d8962` | `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:4` | `1bd629a4-a471-4a28-89fc-8cd89cf88b3a` | `source_type/source_id` |
| `08f050fc-8661-4b93-9cb8-df577e9799ce` | `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:5` | `8e5a6bd6-410b-4537-a1c9-5f058f430638` | `source_type/source_id` |
| `385da71a-b530-454d-b805-b91a4aba8bcd` | `fact:aa3b36ac-05cd-45f4-849b-e6e40f37be28:line:1` | `8327da71-71b5-4f9e-9236-cda289105307` | `source_type/source_id` |

### Why 5, not 8

Golden has 8 open `FINANCIAL_RATE_CODE_MISSING` findings. The other 3 are:

| Finding | Subject | Difference |
|---|---|---|
| `af5e9536-f02f-4174-a7a5-e3d33121ef94` | `fact:aa3b36ac-05cd-45f4-849b-e6e40f37be28:line:2` | No matching execution item by `source_id` |
| `ea1766eb-17a1-421c-8129-8e82edc63e10` | `fact:aa3b36ac-05cd-45f4-849b-e6e40f37be28:line:3` | No matching execution item by `source_id` |
| `8b6efdf2-b5d8-45cf-a2d5-e0f8cbbb81c7` | `fact:aa3b36ac-05cd-45f4-849b-e6e40f37be28:line:4` | No matching execution item by `source_id` |

For those 3, decision matching still returns false, execution matching returns false, `statusForRecords(null, null)` returns `FINDING`, and `lifecycleForIssue` reaches:

```ts
if (!decision) return 'open';
```

Evidence: `lib/resolveProjectIssueObjects.ts:223`.

## Proof 2 - Authoritative Value

### Persisted lifecycle write path

Migration `20260623000002_add_findings_lifecycle_state.sql` adds and maintains `project_validation_findings.lifecycle_state`.

The database function derives lifecycle from persisted finding fields and linked persisted decision/action references:

```sql
WHEN p_finding_status != 'open' THEN 'resolved'
...
WHEN p_decision_id IS NULL AND p_finding_severity = 'critical' THEN 'blocked'
WHEN p_decision_id IS NULL THEN 'open'
```

Evidence: `supabase/migrations/20260623000002_add_findings_lifecycle_state.sql:78-107`.

The trigger writes `NEW.lifecycle_state := public.compute_finding_lifecycle_state(...)` before insert or update of `status`, `severity`, `linked_decision_id`, or `linked_action_id`.

Evidence: `supabase/migrations/20260623000002_add_findings_lifecycle_state.sql:162-179`.

Legitimate persisted resolution paths update the finding itself:

- Stale validator findings: `persistValidationRun.ts` updates `status: 'resolved'`, `resolved_by_user_id`, `resolved_at`, `updated_at` (`lib/validator/persistValidationRun.ts:688-691`).
- Execution outcome route: when an execution item is finalized, it updates `project_validation_findings.status = resolution.findingStatus`, `resolved_by_user_id`, and `resolved_at` for `executionItem.source_id` (`app/api/execution-items/[id]/outcome/route.ts:294-300`).
- Decision closure cascade: linked findings are updated to `terminalFindingStatus` with `resolved_by_user_id` and `resolved_at` (`lib/server/decisionClosure.ts:125-131`).
- Manual rate-link closure: direct no-decision path updates `status: 'resolved'`, `resolved_by_user_id`, and `resolved_at` (`lib/server/manualRateLinkClosure.ts:247-252`).
- Execution sync can link findings to new execution items through `linked_action_id`, but it does not make a still-open finding resolved just because an existing execution row is resolved (`lib/execution/syncExecutionItems.ts:306-314`, `lib/execution/syncExecutionItems.ts:525-530`).

### Verdict on these 5

Persisted `open` is correct for the 5 findings.

Evidence:

- `status = 'open'`
- `lifecycle_state = 'open'`
- `linked_decision_id = null`
- `linked_action_id = null`
- `resolved_by_user_id = null`
- `resolved_at = null`
- `decision_eligible = false`
- `action_eligible = false`

Under the persisted SQL function, an open, non-critical finding with no linked decision derives `open`. Four of the five are `severity = 'info'`; one is `severity = 'warning'`; none are `critical`.

### Could legacy computation be right while persistence missed a write?

Ruled out for the available evidence.

The only legacy evidence for `resolved` is a resolved execution item whose `source_id` equals the finding ID. The persisted resolution paths would have updated `project_validation_findings.status` and `resolved_at` if the execution item resolution legitimately finalized the finding. Since all 5 findings still have `status = 'open'`, `linked_action_id = null`, and `resolved_at = null`, the resolved execution rows are stale or orphaned relative to current finding truth.

The only plausible missed-write scenario would be: an execution item outcome route resolved the execution item but failed after updating `execution_items` and before updating `project_validation_findings`. That would still leave no persisted finding resolver evidence. The authoritative model intentionally requires the finding row to carry its own terminal state, so this scenario would be a failed cascade, not evidence that legacy `resolved` is correct.

## Proof 3 - UI Consumption

| Surface | Field consumed | Source | Shows wrong state today? |
|---|---|---|---|
| Overview Required Reviews count | `issueObjects.filter(isIssueRequiringReview).length`; `isIssueRequiringReview` is `lifecycleState !== 'resolved'` | Legacy computed `IssueObject.lifecycleState` from `resolveProjectIssueObjects` | Yes. The 5 open findings are excluded from the open-review count because they compute as `resolved`. They are not shown as explicit resolved cards here; they are hidden from the count. Evidence: `components/projects/ProjectOverview.tsx:1166-1221`, `lib/issueObjects.ts:141-142`. |
| Overview Required Reviews cards | `model.decisions` / `ProjectOverviewDecisionCard.status_key` | Persisted decision rows transformed by `buildProjectOverviewModel`, not finding lifecycle | No for these 5 findings. The cards are decision-backed, and the 5 findings have no `linked_decision_id`. Evidence: `components/projects/ProjectOverview.tsx:1217`, `components/projects/ProjectOverview.tsx:1761-1770`, `lib/projectOverview.ts:2363-2391`. |
| Validator Findings panel | `issue.lifecycleState` and `getIssueLifecycleLabel(issue.lifecycleState)` | Legacy computed `IssueObject.lifecycleState` | Yes. The 5 open findings display a `Resolved` lifecycle pill. Evidence: `components/validator/ValidatorFindingsPanel.tsx:79-80`. |
| Validator 3-panel Decision & Execution | `issue.executionItem`, `executionItem.status === 'resolved'` | Mixed: selected `IssueObject` plus matched execution row | Yes. For these 5, the panel sees a resolved execution item and renders `Resolved - history record` even though the persisted finding is open. Evidence: `components/validator/ValidatorDecisionExecutionPanel.tsx:78`, `components/validator/ValidatorDecisionExecutionPanel.tsx:136-143`. |
| Validator Evidence & Truth drawer | `selectedFinding` from `selectedIssue.finding`; `executionItemId` from `selectedIssue.executionItemId` | Mixed: persisted finding row embedded in legacy issue object, plus matched execution item ID | Partially. The finding details remain persisted-open, but the linked execution context points at the stale resolved execution item. Evidence: `components/projects/ValidatorTab.tsx:1030-1056`. |
| Audit tab / Audit Forge | Project documents, decisions, tasks, `activityEvents`; labels from event payloads/status | Activity/events and decision/task/document read model, not `IssueObject.lifecycleState` | No. It may contain historical execution-resolution events, but it does not recompute these findings as resolved. Evidence: `lib/projectOverview.ts:2731-2860`, `lib/projectOverview.ts:3252`. |
| Old `model.decisions` decision cards path | `ProjectOverviewDecisionCard.lifecycle_state`, `operator_status`, `status_label` derived from decision rows | Persisted decisions and latest decision activity, not finding lifecycle | No for these 5 findings. They have no linked decision and no decision detail finding IDs. Evidence: `lib/projectOverview.ts:2322-2391`, `components/projects/ProjectDecisionExecutionCard.tsx:121-178`. |
| Platform decision detail pages | Decision row status and linked validator evidence by `linked_decision_id` / detail fallback | Persisted decisions plus explicitly linked findings | No for these 5 findings because `linked_decision_id = null` and the approval decisions do not contain their IDs. Evidence: `app/platform/decisions/[id]/page.tsx:210-241`. |
| Operational queue / command center | Open findings from `project_validation_findings.status = 'open'` and persisted `lifecycle_state`; unresolved execution items only | Persisted finding state and unresolved execution rows | No. Resolved execution items are excluded by `.neq('status', 'resolved')`, while open findings are loaded by persisted `status = 'open'`. Evidence: `lib/server/operationalQueue.ts:1745`, `lib/server/operationalQueue.ts:1805-1810`. |
| Portfolio command center | `project_approval_snapshots`, `decision_detections`, `workflow_events` | Separate persisted aggregate sources | No direct consumption of this legacy lifecycle path. Evidence: `lib/server/portfolioCommandCenter.ts:94-180`. |

## Affected Scope

Do not expand the fix search into all `decisionMatchesFinding` usage. In this lifecycle path, `decisionMatchesFinding` is not the cause. The affected scope is the finding-backed resolver's decision to treat any matched resolved execution item as authoritative over a still-open finding, even when the finding lacks `linked_action_id` and resolution evidence.

The stale execution rows are also relevant operational debt because they share `source_id` with current open findings, but the false UI state is produced by `resolveProjectIssueObjects.ts`, not by the persisted finding lifecycle.

## Proposed Fix - Not Implemented

NOT IMPLEMENTED in this phase.

Minimal proposal:

1. In `resolveProjectIssueObjects.ts`, do not allow an execution item matched only by `source_type = 'validator_finding'` and `source_id = finding.id` to mark a finding `COMPLETE` when the persisted finding is still `status = 'open'`, `lifecycle_state = 'open'`, and `linked_action_id` is null.
2. Prefer persisted finding lifecycle for finding-backed issue lifecycle when `finding.lifecycle_state` is present, or at minimum gate the `status === 'COMPLETE'` branch behind persisted finding terminal evidence (`finding.status !== 'open'`, `finding.resolved_at != null`, or `finding.linked_action_id === executionItem.id`).
3. Add a regression test covering an open finding with a stale resolved execution item sharing `source_id`; expected `IssueObject.lifecycleState = 'open'` and no `resolved/open` shadow mismatch.
4. Separately investigate whether stale resolved execution items should be unlinked, superseded, or ignored by source-key generation after validation reruns. That cleanup should be a follow-up, not part of the read-path fix.
