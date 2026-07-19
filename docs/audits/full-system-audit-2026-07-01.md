> Historical: references components removed after 2026-07-16; retained as-is for audit history.

# EightForge Full System Audit - 2026-07-01

Phase A read-only audit. No fixes, commits, merges, migrations, or data writes were performed.

Live Supabase project: `jpzeckefppmiujwajgvk`

## 1. Executive Summary

- Critical - Manual Rate Link Pass 2 is not active on `main`: Golden invoice `2026-002`, line 6 has an active `invoice_line_rate_links` override to the exact contract row and amount `$80`, but the latest validator run still emits an open critical `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` blocker for the same subject. Evidence: active link `2a976e57-b648-4343-8b51-dde452b8e285`; latest run `31256419-283d-46ae-9bdd-0c1cbf7c54f9`; open finding `805bd323-7913-4459-a597-7d98d526b851`.
- Critical - Completed-but-unmerged work is systemic, not isolated. The exact missing reader appears to exist on local/remote branch `feat/manual-rate-link-pass2-and-2.1` (ahead of `main` by 1, behind by 0, +547/-20 across validator files/tests), while the live DB already contains the writer table and active data. Several other branches/worktrees/stashes show the same pattern.
- High - Validator/execution state can drift after reruns. Golden invoice `2026-002`, line 5 has an open latest validator finding `08f050fc-8661-4b93-9cb8-df577e9799ce`, but execution item `8e5a6bd6-410b-4537-a1c9-5f058f430638` for the same source id remains `resolved`.
- High - Project/document persisted summaries can be stale. MDOT project `445c7376-659a-4261-a445-d99585114b21` has `validation_summary_json.open_count = 1`, while its only project validation finding `757111b2-...` is currently `resolved`; the document remains `Blocked` because separate deterministic decisions are still open.
- High - Live schema and `main` are out of sync. `contract_upload_guidance` exists in production with 0 rows, but the corresponding migration/code is not present on `main`; it exists on unmerged branch `claude/angry-clarke-82eda7`.
- High - Runtime surfaces silently degrade when querying missing tables. Live schema has no `decision_detections` and no `approval_action_log`, but `portfolioCommandCenter.ts`, `aiDecisionPersistence.ts`, workflow outcomes, approval action history, and approval action engine still query/write them.
- Medium - The prior "RLS disabled on 6 tables" note is stale: all public base tables now have RLS enabled. Current exposure risk is instead "RLS enabled with no policy" on `document_relationships` and `state_projection_shadow_mismatches`, plus permissive/always-true policies on several tables per Supabase advisor.
- Medium - Goodlettsville remains blocked by rate matching/normalization. Invoice and transaction support data exist for picked lines, but cross-document contract-rate matching still reports "No confident contract rate-row match found."
- Medium - H1 shadow adoption is merged and the shadow sink exists, but the mismatch table currently has zero rows. That means no live mismatch evidence is currently persisted, not that legacy/persisted projections are proven equivalent.
- Medium - Four-surface Forge resurface is partial. Overview is new, Validator is an embedded old `ValidatorTab`, and Documents/Audit are still rendered inline inside `ProjectOverview.tsx`; exported `ProjectDocumentsForge` and `ProjectAuditForge` exist but are not wired into the project detail page.

## 2. Part 0 Findings - Repo State

### Main Worktree

- Current worktree: `C:/Dev/eightforge-os`
- Branch: `main...origin/main`
- Dirty state: untracked `docs/prompts/`
- Audit file did not exist in this worktree before this report.

### Worktrees

`git worktree list --porcelain` showed 21 worktrees. Non-main worktrees and classifications:

| Worktree / branch | Head | Divergence / contents | Classification |
|---|---:|---|---|
| `.claude/worktrees/amazing-heisenberg-14c873` / `claude/amazing-heisenberg-14c873` | `51c33a7` | Contains branch work also containing PR #35 history. No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/angry-clarke-82eda7` / `claude/angry-clarke-82eda7` | `5870b0a` | Ahead 1, behind 0. Commit `feat: add contract upload guidance`, 13 files, +664/-7, including migration `20260701000000_create_contract_upload_guidance.sql`, API, UI, validator code. | Completed-but-unmerged; live DB table already exists. |
| `.claude/worktrees/dreamy-jepsen-af85da` | `7459abb` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/elated-khorana-61cf5f` | `597bf34` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/epic-morse-32eb3a` | `23a5769` | Dirty: `lib/server/ai/orchestratorSystemPrompt.ts` modified (+1 line). | Active/stranded local edit. |
| `.claude/worktrees/feat+disposal-treatment-override-propagation` / `worktree-feat+disposal-treatment-override-propagation` | `d7227cd` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/festive-hermann-c69e9f` | `597bf34` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/gracious-pascal-5faa9b` | `21be2ac` | Dirty: `lib/useProjectWorkspaceData.ts`, approx. 83-line deletion. | Active/stranded local edit. |
| `.claude/worktrees/happy-wescoff-0ec989` | `main` head | Dirty: untracked `docs/audits/full-system-audit-2026-07-01.md` in that worktree. | Stranded duplicate audit output. |
| `.claude/worktrees/interesting-cerf-8b9956` | `cd6e230` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/loving-black-b13406` | `aa501aa` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/nervous-wilbur-bcc6c1` | `main` head | No dirty files reported. | Idle main worktree. |
| `.claude/worktrees/silly-galileo-d56930` | `23a5769` | No dirty files reported. | Unknown/stale worktree. |
| `.claude/worktrees/silly-herschel-6bb0fd` | `main` head | No dirty files reported. | Idle main worktree. |
| `.claude/worktrees/upbeat-darwin-f8263f` | `23a5769` | No dirty files reported. | Unknown/stale worktree. |
| `C:/Dev/eightforge-os-ask` / `feat/claude-project-ask-mvp` | `ac631cb` | Ahead 2, behind 36. Clean variant appears merged. | Likely abandoned duplicate. |
| `C:/Dev/eightforge-os-orchestrator` / `feat/improvement-orchestrator-ai` | `2dec2ef` | Ahead 2, behind 36. Clean variant appears merged. | Likely abandoned duplicate. |
| `C:/Dev/eightforge-os-remove-ai-enrichment` / `chore/remove-ai-enrichment-subsystem` | `477f5f2` | Large dirty deletion set, approx. 8 files and ~749 deletions. | Active/stranded uncommitted work. |
| `C:/tmp/eightforge-gitattributes-fix` / `chore/fix-gitattributes-encoding-and-rule` | `7dfaebd` | Ahead 1, behind 21; `.gitattributes` binary-size change. | Completed/stale small fix. |
| `C:/tmp/eightforge-os-pricing-audit` / `codex/audit-pricing-applicability` | `cd6e230` | No dirty files reported. | Unknown/stale audit branch. |

### Local Branches Not Merged to Main

| Branch | Divergence | Evidence | Classification |
|---|---:|---|---|
| `audit/ai-optional-dependency-check` | ahead 1 / behind 36 | Diff only `package-lock` deletion. | Stale/abandoned. |
| `chore/fix-gitattributes-encoding-and-rule` | ahead 1 / behind 21 | `.gitattributes` encoding/rule adjustment. | Completed-but-unmerged or stale. |
| `claude/angry-clarke-82eda7` | ahead 1 / behind 0 | Adds `contract_upload_guidance` migration/API/UI/validator code. | Completed-but-unmerged; live DB already ahead of main. |
| `feat/claude-project-ask-mvp` | ahead 2 / behind 36 | Project Ask MVP; clean variant appears merged. | Likely abandoned duplicate. |
| `feat/document-management-actions` | ahead 1 / behind 79 | Normalizes unit fields in `lib/server/intelligenceAdapter.ts` plus test. | Completed-but-unmerged/stale. |
| `feat/extraction-mode-and-rate-row-structure` | ahead 2 / behind 103 | 12 files, +327/-32; rate row structure and origin/destination extraction. | Completed-but-unmerged or stale. |
| `feat/improvement-orchestrator-ai` | ahead 2 / behind 36 | Orchestrator AI work; clean variant appears merged. | Likely abandoned duplicate. |
| `feat/manual-rate-link-pass2-and-2.1` | ahead 1 / behind 0 | Adds validator manual-link injection; changes `projectValidator.ts`, `crossDocumentRateVerification.ts`, shared types/tests; +547/-20. | Critical completed-but-unmerged work. |
| `fix/vision-trigger-suspect-table` | ahead 3 / behind 89 | Disables paid vision fallback. | Completed/stale. |

Remote branches not merged to `main`: `origin/chore/fix-gitattributes-encoding-and-rule`, `origin/claude/angry-clarke-82eda7`, `origin/claude/decision-status-dismissed-constraints-pc13bx`, `origin/claude/elegant-mirzakhani`, `origin/claude/fix-document-page-performance-397Wy`, `origin/cursor/application-issue-resolution-400c`, `origin/feat/deterministic-rule-backbone`, `origin/feat/extraction-mode-and-rate-row-structure`, `origin/feat/manual-rate-link-pass2-and-2.1`, `origin/feat/openai-provider-swap`, `origin/feat/unified-eightforge`, `origin/fix/vision-trigger-suspect-table`, `origin/merge-deterministic-backbone`, `origin/vercel/install-vercel-web-analytics-yroj4u`.

The local audit deeply inspected local/worktree branches above. Remote-only branches need a follow-up branch-content audit before deletion or merge decisions.

### Stashes

| Stash | Contents | Classification |
|---|---|---|
| `stash@{Thu Jun 25 12:41:13 2026}` on `feat/extractor-diagnostic-agent` | `ProjectDocumentsForge.tsx` 693-line rewrite plus `ProjectOverview.tsx`, `lib/projectOverview.ts`, `lib/useProjectWorkspaceData.ts`; total +253/-553. | Likely stranded four-surface UI work. |
| `stash@{Wed Jun 17 11:55:42 2026}` on `feat/vision-rate-table-supplement` | No stat shown by stash summary. | Unknown/stale. |
| `stash@{Tue Jun 16 15:31:07 2026}` on `main` | `lib/projectOverview.ts` +17/-2. | Stranded validator/pass AB work. |
| `stash@{Tue Jun 16 15:31:05 2026}` on `main` | `components/projects/ValidatorTab.tsx` +35/-37. | Stranded validator/pass AB UI work. |
| `stash@{Tue Jun 16 15:31:03 2026}` on `main` | `components/projects/ProjectDecisionQueueFrame.tsx` +1/-1. | Stranded small UI work. |

Part 0 conclusion: the failure mode is systemic. There are multiple completed or plausibly completed implementation fragments outside `main`, including the exact missing Manual Rate Link Pass 2 validator reader.

## 3. Part 1 Findings - Canonical Pipeline Walk

### Anchor A - Golden Project Invoice `2026-002`, Line 6

Subject: project `437502f2-d46d-447f-81e3-f26fa7ba0c14`, invoice document `53d74340-4d00-4d55-a937-4d0eca9c1573`, line subject `fact:53d74340-4d00-4d55-a937-4d0eca9c1573:line:6`.

Raw extraction:

- Latest invoice extraction is successful: document `53d743...`, extractor `gpt-4o`, created `2026-05-26 17:20:37.494682+00`.
- Extracted line 6 exists: code `6A`, description `Tree Operations Hazardous Hanging Limb Removal>2"per tree`, quantity `994`, unit price `80`, total `79520`, `billing_rate_key = 6A`, `description_match_key = tree operations hazardous hanging limb removal 2 per tree`.

Assembly:

- Manual-link assembly exists in live DB. Active row `2a976e57-b648-4343-8b51-dde452b8e285` maps line 6 to contract row `exhibit_a_table:pdf:table:p9:t33:r8`, rate description `Trees with Hazardous Limbs Hanging Removal >2" per Tree`, unit `Tree`, amount `80`.
- Historical superseded rows also exist for line 6: `e6e2d...` and `be0cae...`, both inactive.

Validator:

- Latest Golden validation run `31256419-283d-46ae-9bdd-0c1cbf7c54f9` completed at `2026-07-01 19:26:45.388+00`, with `findings_count=9`, `critical_count=1`, rules applied: `required_sources`, `identity_consistency`, `contract_invoice_reconciliation`, `invoice_transaction_reconciliation`, `cross_document_rate_verification`, `financial_integrity`, `ticket_integrity`.
- Despite the active link, validator emitted open critical finding `805bd323-7913-4459-a597-7d98d526b851`, rule `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT`, expected `Confirmed contract schedule row for this billed line`, actual `6A`, lifecycle `ready_for_authorization`.
- Evidence rows on the finding cite the invoice line (`invoice_number=2026-002`, `rate_code=6A`) and contract rate schedule presence (`rate_row_count=51`, pages `8, 9, 11`), but not the active manual link.

Decision / Execution:

- Linked decision `b4783705-3ec6-4198-99bd-38946e39840c` is open critical, source `project_validator`, source run `31256419...`, validator finding ids `["805bd323-..."]`.
- Linked execution item `82e4760e-7cf4-470a-99ec-9a01cb786a1b` is open, queue state `blocked`, source id `805bd323-...`.

UI persisted summary:

- Golden project summary is `BLOCKED` with `open_count=9`, `critical_count=1`, `blocker_count=1`, first blocker subject line 6.
- UI state matches latest validator/execution, but not the human override. That proves the override writer landed but the downstream validator reader did not consume it.

Finding:

- Critical: `invoice_line_rate_links` writer works, but `main` validator does not read it. `loadValidatorInput` on `main` loads documents, extractions, fact overrides, reviews, rule state, structured ticket rows, canonical invoices, and transaction rows; it does not load `invoice_line_rate_links`. `app/api/projects/[id]/invoice-line-rate-link/route.ts` explicitly says "Pass 2 will consult invoice_line_rate_links during validation to prevent reopening."

### Anchor B1 - Golden Project Invoice `2026-002`, Line 1

Subject: line `1`, code `1A`, vegetative removal / haul category.

Raw extraction:

- Extracted line 1 exists: code `1A`, description `Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15`, quantity `43894`, unit price `6.9`, total `302868.6`.

Assembly:

- No manual link rows exist for line 1.
- Contract rate schedule evidence exists in validator history; previous cross-document finding `f8f3e6...` was resolved.

Validator:

- Prior line 1 findings are resolved: `82a964...` and `54f0d36...` for `FINANCIAL_RATE_CODE_MISSING`, plus `f8f3e6...` for `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`.

Decision / Execution:

- Execution items for line 1 are resolved, including `aea40d...` for cross-document rate existence.

UI persisted summary:

- No current open line 1 finding appears in latest Golden summary. This anchor behaves as a clean/resolved comparison case.

Finding:

- None for this line in current state.

### Anchor B2 - Golden Project Invoice `2026-002`, Line 5

Subject: line `5`, code `5A`, hazardous tree removal.

Raw extraction:

- Extracted line 5 exists: code `5A`, description `Tree Operations Hazardous Tree Removal 6-12 in`, quantity `5`, unit price `95`, total `475`.

Assembly:

- No manual link rows exist for line 5.

Validator:

- Latest finding `08f050fc-8661-4b93-9cb8-df577e9799ce` from run `31256419...` is open/info, rule `FINANCIAL_RATE_CODE_MISSING`, subject `fact:53d743...:line:5`, expected `invoice line rate code`, actual `missing`, updated `2026-07-01 19:26:49.004157`.
- Older `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` finding `ce2702...` is resolved.

Decision / Execution:

- Execution item `8e5a6bd6-410b-4537-a1c9-5f058f430638` has `source_id = 08f050fc-...` but remains `resolved`, outcome `resolved`, queue state `resolved`, updated `2026-06-23 14:05:05.747618`.

UI persisted summary:

- Because this finding is info-level, it contributes to open count but not the critical blocker. The execution queue will not accurately represent the reopened finding because the stale execution item is resolved.

Finding:

- High: finding/execution sync is not idempotent across reruns for at least some reopened findings.

### Anchor C1 - Goodlettsville, GOD-H01 Line 6

Project: `e7185c5f-f532-4886-9022-2e449ced9445`.

Subject: invoice document `35083bf5-d6d7-4c76-9c0b-31c3dba486a7`, line 6.

Raw extraction:

- Extracted line exists: code `Unit`, description `Hazardous Limb (Hangers) Cutting (greater than 2" diameter)`, quantity `135`, unit price `null`, line total `135`, `billing_rate_key=UNIT`, description key `hazardous limb hangers cutting greater than 2 diameter`.

Assembly:

- No `invoice_line_rate_links` rows exist for Goodlettsville.
- Transaction support evidence exists from `Goodlettsville ticket_query_20260616_150734.xlsx`: canonical category `tree_operations`, source descriptor `6 - Hangers`, quantity `1`.

Validator:

- Latest Goodlettsville run `8d13dcfc-d131-487a-a704-09762a6935bb` completed `2026-06-21 10:24:11.801+00`, findings `96`, critical `62`, warning `33`, info `1`.
- Finding `a249c82d-3911-45f1-b2bb-67e498ba9112`, rule `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`, is open critical / `ready_for_authorization`, actual `No confident contract rate-row match found`.
- Related findings: `daef4428...` and `c71e3ad8...` resolved; `8909698d...` warning open for missing rate code.

Decision / Execution:

- Project decision `8ebc4773-17e9-463f-9c29-4be14e426fcd` is open critical and includes this finding id.
- Execution item `a32f9729...` for `a249...` is open/blocked.

UI persisted summary:

- Project summary is `BLOCKED`, `open_count=96`, `critical_count=62`. This matches the validator and execution state.

Finding:

- Medium: support data is present and category-normalized, but confident contract-rate matching is still missing.

### Anchor C2 - Goodlettsville, GOD-H02 Line 1

Subject: invoice document `6bd2872e-1ed7-4720-a079-496427e6809f`, line 1.

Raw extraction:

- Extracted line exists: code `null`, description `Loading and Hauling Vegetative Debris`, quantity `29`, unit price `null`, line total `29`, description key `loading and hauling vegetative debris`.

Assembly:

- Transaction support evidence exists with canonical category `vegetative_removal`, quantities `43`, `34`, `38`, source descriptor `Vegetation`.

Validator:

- Finding `5b31f9f7-e762-414a-9c3c-4f1829982794`, rule `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`, is open critical / `ready_for_authorization`, actual `No confident contract rate-row match found`.
- Related support finding `3ce9a2d3...` is resolved; `8da6ebeb...` warning open for missing rate code.

Decision / Execution:

- Same project decision `8ebc4773-...` includes this finding.
- Execution item `0ddca155...` for `5b31...` is open/blocked.

UI persisted summary:

- Project remains `BLOCKED`, matching validator/execution.

Finding:

- Medium: this reproduces the Goodlettsville rate-collision/rate-resolution issue on a vegetative category line.

### Anchor D - MDOT Blocked Document

Project: `445c7376-659a-4261-a445-d99585114b21`

Document: `6866832f-5126-435d-9329-f09bade970a8`, `310225302000_Executed_Contractor.pdf`

Raw extraction:

- Document is `processing_status=decisioned`, `operational_status=Blocked`, no `processing_error`, processed at `2026-06-16 14:59:28.81+00`.
- Extraction `de921227...` succeeded. Data includes typed fields, but the extracted vendor name is OCR-wrong and the rate table is empty.

Assembly:

- Missing/empty rate-table assembly led to deterministic decisioning and validation findings.

Validator:

- Only project validation finding `757111b2...`, rule `FINANCIAL_NTE_FACT_MISSING`, is currently `resolved`, severity `info`, updated `2026-06-24`.

Decision / Execution:

- Deterministic decisions are still open critical: pricing applicability unresolved, documentation prerequisites unclear, missing contract ceiling. No execution items exist for the project.
- Validator project approval decision `dd1cf1a7...` is resolved/low.

UI persisted summary:

- Project `validation_summary_json` still reports `open_count=1` even though the only project validation finding is resolved.
- Document remains `Blocked` because deterministic decisions remain open. This is a mixed-source status: document status is explainable, but project validation summary is stale.

Finding:

- High: persisted validation summary can be stale relative to finding lifecycle; document operational status can be correct for a different reason, masking the stale validator summary.

## 4. Part 2 Findings - Produced vs Consumed Cross-Reference

| Resolver / map / table | Writer | Reader | Status |
|---|---|---|---|
| `invoice_line_rate_links` | `lib/server/manualRateLinkClosure.ts` inserts/supersedes active rows; API `app/api/projects/[id]/invoice-line-rate-link/route.ts` calls it. Live DB has 3 rows, including one active Golden line 6 link. | No reader on `main` in `loadValidatorInput`; validator still reopens line 6. Branch `feat/manual-rate-link-pass2-and-2.1` appears to add reader/injection. | Broken: writer exists, reader absent on `main`. |
| `manualRateLinkOverrides` | No exact symbol found on `main`. The actual persisted mechanism is `invoice_line_rate_links`. | No exact symbol found on `main`. | Naming drift/dead design term; maps to missing `invoice_line_rate_links` consumption. |
| `invoiceLineToRateMap` | `projectValidator.ts` builds it from effective invoice lines and `factLookups.rateScheduleItems`. | `financialIntegrity.ts`, `contractInvoiceReconciliation.ts`, `invoiceTransactionReconciliation.ts`, `rateBasedContractValidation.ts`, exposure logic. `crossDocumentRateVerification.ts` independently uses `factLookups.rateScheduleItems`. | Partially wired. It does not include manual links on `main`; cross-document pack bypasses it. |
| `factLookups.rateScheduleItems` | `buildFactLookups` derives from persisted `contractValidationContext.analysis.rate_schedule_rows`, extraction fact rows (`rate_table`, `hauling_rates`, `tipping_fees`), and canonical contract facts. | Cross-document rate verification, financial integrity, exposure, invoice/rate map. | Wired but lossy for Anchor A: exact row id `exhibit_a_table:pdf:table:p9:t33:r8` is not present in current consumed rate items, so the active link points to a row the validator cannot see. |
| `document_fact_overrides` | Document fact override/anchor routes and execution outcome route. Live DB: 7 total, 7 active, 3 documents. | `loadDocumentFactOverrides`, document detail, Ask retrieval, project validation trigger. | Wired. Supabase advisor flags duplicate/permissive policy concerns separately. |
| `document_fact_reviews` | Review routes. | `loadDocumentFactReviews`, document detail, validation input. | Wired. |
| `contract_upload_guidance` | Live DB table exists with 0 rows; migration/code not present on `main`. Unmerged branch `claude/angry-clarke-82eda7` contains migration/API/UI/validator writer/reader. | No reader/writer present on `main`. | Schema ahead of code; completed-but-unmerged branch. |
| `document_relationships` / precedence snapshot | Project document precedence API writes relationships. | `loadValidatorInput`, document precedence, project admin/use workspace data. | Wired, but advisor/current policy query shows RLS enabled with 0 policies, meaning normal clients may not be able to read it unless service role is used. |
| `mobile_tickets` / `load_tickets` | `supportTicketPersistence.ts` targets these legacy tables and suppresses missing-table errors. | `projectValidator.ts` and `triggerProjectValidation.ts` dynamically probe them and return empty on missing table. Live schema has neither table. | Intentional optional legacy resolver; not active in live schema. Transaction rows are the real support data source. |
| `transaction_data_rows` / datasets | `transactionDataPersistence.ts` writes; live row estimate `9983`. | Validator input, document detail, transaction reconciliation, cross-document support matching. | Wired and active. |
| `project_validation_rule_state` | Rule state/admin overrides. | `loadRuleState` and `isRuleEnabled` checks in rule packs. | Wired. |
| `state_projection_shadow_mismatches` | `logStateProjectionMismatch` inserts when legacy and persisted projections differ and logging enabled. | No UI/triage reader found in current app. Live count is 0. | Sink exists; observability consumer absent/unclear. |

## 5. Part 3 Findings - Known Open Items Status

| Item | Current live status | Runtime behavior / risk | Evidence |
|---|---|---|---|
| `portfolioCommandCenter.ts` queries `decision_detections` | Table still does not exist: `to_regclass('public.decision_detections') = null`. | `portfolioCommandCenter.ts` ignores query errors and loops over `issueCountsResult.data ?? []` / `decisionsResult.data ?? []`, so the command center silently shows zero/empty decision detection counts instead of crashing. `aiDecisionPersistence.ts` also writes to the missing table. | Code refs: `lib/server/portfolioCommandCenter.ts:138,145`; `lib/server/aiDecisionPersistence.ts:72,177`. |
| RLS disabled on 6 tables | Stale. Query for public base tables with `relrowsecurity=false` returned `[]`. | Current security risk is different: `document_relationships` and `state_projection_shadow_mismatches` have RLS enabled but 0 policies. Advisor also reports always-true policies on `organizations`, `transaction_data_rows`, `transaction_data_summaries`, and SECURITY DEFINER function concerns. | Live RLS query; Supabase security advisor. |
| `approval_action_log` missing from schema cache | Table still does not exist: `to_regclass('public.approval_action_log') = null`, despite migration file `20260407000001_approval_action_log.sql` in repo. | Workflow outcomes route and approval history silently return empty approval actions when data is null; approval engine writes would fail on execution. | Code refs: `app/api/decisions/[id]/workflow-outcomes/route.ts:92`; `lib/server/approvalActionHistory.ts:157`; `lib/server/approvalActionEngine.ts:410`. |
| H1 retirement / PR #35 shadow comparison | PR #35 is merged into `main` (`b6f9991 Merge pull request #35 ... h1-step1-shadow-adoption`), and PR #43 added durable sink (`7915cd0`). Live mismatch table exists. | Live `state_projection_shadow_mismatches` count is 0, so no persisted mismatch evidence currently exists. Direction in code is `legacy_value` vs `persisted_value`; examples log document status, validation finding lifecycle, and execution queue state. Absence of rows is not proof of no drift because logging can be disabled by env and insert failures are swallowed. | `lib/stateProjectionShadow.ts`; live count `{shadow_mismatch_count:0}`. |
| Four-surface Forge resurface | Partial. Project detail page imports `ProjectOverview` and `ValidatorTab`; `ProjectOverview` renders documents and audit inline; `ProjectDocumentsForge` and `ProjectAuditForge` exports exist but are not wired into `app/platform/projects/[id]/page.tsx`. | Overview is new; Validator uses old `ValidatorTab`; Documents/Audit are old inline surfaces on the project page. A stash from Jun 25 contains substantial `ProjectDocumentsForge` work, suggesting resurface work is stranded. | Code refs: `app/platform/projects/[id]/page.tsx`; `components/projects/ProjectOverview.tsx`; `components/projects/ProjectDocumentsForge.tsx`; `components/projects/ProjectAuditForge.tsx`; stash `feat/extractor-diagnostic-agent`. |

## 6. Part 4 Findings - Orphaned Code Sweep

### Queried Tables Missing From Live Schema

| Table | Live relation | Code references | Impact |
|---|---|---|---|
| `decision_detections` | `null` | `lib/server/aiDecisionPersistence.ts:72,177`; `lib/server/portfolioCommandCenter.ts:138,145` | AI decision persistence cannot write; portfolio issue counts silently empty. |
| `approval_action_log` | `null` | `app/api/decisions/[id]/workflow-outcomes/route.ts:92`; `lib/server/approvalActionHistory.ts:157`; `lib/server/approvalActionEngine.ts:410` | Approval action history/outcomes empty; approval action execution write would fail. |
| `invoice_lines` | `null` | `lib/server/invoicePersistence.ts`; `lib/validator/projectValidator.ts:983,1006`; `lib/validator/triggerProjectValidation.ts:341` | Legacy table path missing. Validator handles missing table by returning empty; invoice persistence path is not safe if invoked. |
| `invoices` | `null` | `lib/server/invoicePersistence.ts` | Legacy invoice persistence path missing if invoked. |
| `mobile_tickets` | `null` | Dynamic table target in `supportTicketPersistence.ts`, `projectValidator.ts`, `triggerProjectValidation.ts`. | Optional legacy table; code intentionally suppresses missing-table errors. |
| `load_tickets` | `null` | Dynamic table target in `supportTicketPersistence.ts`, `projectValidator.ts`, `triggerProjectValidation.ts`. | Optional legacy table; code intentionally suppresses missing-table errors. |

### Exported Functions / Surfaces With Zero or No Production Callers Found

| Export | Evidence | Status |
|---|---|---|
| `ProjectDocumentsForge` | Exported at `components/projects/ProjectDocumentsForge.tsx:190`, but `app/platform/projects/[id]/page.tsx` does not import it; project page renders inline documents in `ProjectOverview.tsx`. | Exported surface not wired into project detail page. |
| `ProjectAuditForge` | Exported at `components/projects/ProjectAuditForge.tsx:224`, but project page does not import it; audit renders inline in `ProjectOverview.tsx`. | Exported surface not wired into project detail page. |
| `contract_upload_guidance` code/migration | Not present on `main`; present on unmerged `claude/angry-clarke-82eda7`; live DB table exists with 0 rows. | Schema/code orphan across branches. |
| `state_projection_shadow_mismatches` reader | Sink writes exist; no operational reader/triage surface found. | Evidence sink may become write-only. |

### Validator Rule Packs

Rule pack registration in `validateProject`:

- `required_sources` runs first and gates heavier packs if blocked.
- Then registered/invoked: `identity_consistency`, `contract_invoice_reconciliation`, `invoice_transaction_reconciliation`, `cross_document_rate_verification`, `financial_integrity`, `ticket_integrity`.
- `rateBasedContractValidation.ts` is not top-level registered but is invoked by `financialIntegrity.ts` via `runRateBasedContractValidationRules(input)`.

No rule-pack file under `lib/validator/rulePacks` was found to be registered but never invoked, except test files.

## 7. Full Prioritized Bug List

| Severity | Classification | Description | Evidence | Affected scope | Suggested next Phase A prompt title |
|---|---|---|---|---|---|
| Critical | Produced-not-consumed resolver | Active manual rate links are written but ignored by validator on `main`; Golden line 6 remains blocked. | Link `2a976e57-...`; finding `805bd323-...`; `loadValidatorInput` lacks `invoice_line_rate_links`; branch `feat/manual-rate-link-pass2-and-2.1` contains missing reader work. | Validator, Decisions, Execution, UI project readiness. | "Phase A: Audit and Merge-Readiness Review for Manual Rate Link Pass 2.1" |
| Critical | Repo governance / release hygiene | Completed implementations are stranded across branches/worktrees/stashes. | 21 worktrees; `feat/manual-rate-link-pass2-and-2.1`, `claude/angry-clarke-82eda7`, dirty remove-AI worktree, Jun 25 Forge stash. | All delivery/release confidence. | "Phase A: Worktree/Branch Consolidation Triage for Completed EightForge Work" |
| High | State drift | Validator reopened Golden line 5 finding, but execution item for same source id remains resolved. | Finding `08f050fc-...` open; execution item `8e5a6bd6-...` resolved. | Execution queue, operator actions, validator tab. | "Phase A: Validator-to-Execution Drift Audit Across Latest Runs" |
| High | Persisted summary stale | MDOT summary reports open finding count even though only project validation finding is resolved. | MDOT project summary `open_count=1`; finding `757111b2...` resolved. | Project readiness, Overview/Validator UI. | "Phase A: validation_summary_json Recompute and Staleness Audit" |
| High | Schema/code divergence | `contract_upload_guidance` exists live but no `main` migration/code; unmerged branch contains implementation. | Live table count `0`; `Test-Path` on main for migration/API/lib returned `False`; branch `claude/angry-clarke-82eda7` ahead 1. | Contract upload guidance, validator setup UX. | "Phase A: Contract Upload Guidance Schema-Code Drift Audit" |
| High | Missing live table | `decision_detections` missing while production code reads/writes it. | `to_regclass=null`; refs in `aiDecisionPersistence.ts` and `portfolioCommandCenter.ts`. | AI enrichment persistence, portfolio command center. | "Phase A: decision_detections Runtime Path Audit" |
| High | Missing live table | `approval_action_log` missing while approval history/outcomes/engine use it. | `to_regclass=null`; refs in route/history/engine; migration exists. | Decision detail workflow outcomes, approval automation trace. | "Phase A: approval_action_log Schema and Runtime Audit" |
| Medium | Rate matching / canonical normalization | Goodlettsville support rows exist but contract rate matches remain open critical. | Findings `a249c82d-...` and `5b31f9f7-...`; transaction evidence categories `tree_operations`, `vegetative_removal`. | Goodlettsville validator, cross-document rate matching. | "Phase A: Goodlettsville Rate Match Collision Trace" |
| Medium | Security policy drift | RLS disabled note stale; current risk is no-policy tables and permissive policies. | RLS-disabled query returns `[]`; no-policy tables `document_relationships`, `state_projection_shadow_mismatches`; advisor warnings. | Supabase access control. | "Phase A: Current Supabase RLS Policy Risk Audit" |
| Medium | Shadow observability gap | H1 shadow sink exists but has 0 rows and no reader surface found. | PR #35/#43 merged; live count `0`; `logStateProjectionMismatch` swallows insert failures. | State projection retirement confidence. | "Phase A: H1 Shadow Sink Observability Audit" |
| Medium | Four-surface implementation gap | New Forge components exist but are not wired; Documents/Audit remain inline and Validator remains old tab. | Project page imports only `ProjectOverview` and `ValidatorTab`; `ProjectDocumentsForge`/`ProjectAuditForge` exports unused. | Overview/Documents/Validator/Audit UX. | "Phase A: Four-Surface Forge Wiring Audit" |
| Low | Legacy optional table probes | `mobile_tickets`, `load_tickets`, `invoice_lines`, `invoices` absent; some paths intentionally return empty, but invoice persistence could fail if invoked. | `to_regclass=null`; dynamic/static code refs. | Legacy ingestion paths, validator fallback behavior. | "Phase A: Legacy Structured Table Probe Audit" |
