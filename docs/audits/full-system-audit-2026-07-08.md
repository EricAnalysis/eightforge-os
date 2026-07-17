> Historical: references components removed after 2026-07-16; retained as-is for audit history.

# EightForge Full System Audit - 2026-07-08

Phase: A only, read-only.
Environment: Windows PowerShell, `C:\Dev\eightforge-os`.
Live DB: Supabase `jpzeckefppmiujwajgvk`, queried through `DATABASE_URL` and service-role Supabase client.
Important local-state caveat: after `git fetch --all --prune`, local `main` is behind `origin/main`; `origin/main=478cfd8` includes PR #60, while checked-out `HEAD=284bf04`. Code claims involving the perf pass were verified against `origin/main` where local files differ.

## 1. Executive Summary

- **High - Stranded work is systemic.** `git worktree list` shows 17 worktrees, multiple stale/detached branches, dirty worktrees, and 5 stashes. Dirty stranded work includes an 83-line deletion in `lib/useProjectWorkspaceData.ts`, a broad AI-enrichment removal worktree with 8 dirty files and 749 deletions, and a 693-line Project Documents Forge stash.
- **High - H1 shadow mismatch still fires but is not durably persisted.** Running the live `resolveProjectIssueObjects()` path emitted five console warnings for Golden Project findings (`legacy_value='resolved'`, `persisted_value='open'`), while `state_projection_shadow_mismatches` remained empty afterward.
- **High - Live schema still lacks `approval_action_log`.** `to_regclass('public.approval_action_log') = null`; current source queries/writes it in `app/api/decisions/[id]/workflow-outcomes/route.ts`, `lib/server/approvalActionHistory.ts`, and `lib/server/approvalActionEngine.ts`.
- **Medium - Goodlettsville backfill partly verifies, but expected live shape does not.** Live data has two price-sheet docs with 5 rows each and non-null `canonical_category`/`category_confidence`, not three such documents.
- **Medium - Mechanism 2 field threading is present, but the claimed explicit `0.65` needs-review gate was not found.** `rate_ocr_confidence` is persisted/threaded and tested, but static search found no `0.65` threshold in current code.
- **Medium - Golden acceptance gates remain good, but validator/issues surface is noisy.** Live exposure says invoices `2026-002` and `2026-003` are both `MATCH` with `$0` at risk and total billed `$815,559.35`; latest validation still has 8 open missing-rate-code findings, and resolver output includes 342 issues due to resolved execution-backed rows.
- **Medium - Production `projects` table lacks `validation_phase` while current workspace code selects it first.** `projects` columns are `id, organization_id, name, code, status, description, created_at, updated_at, validation_status, validation_summary_json`; code has fallback logic, but the schema/code mismatch remains.
- **Low - Four-surface Forge structure is in source, but authenticated browser rendering was not verified.** Playwright against `http://localhost:3000/platform/projects/...` redirected to `/login`; static code confirms four tabs and legacy anchors, but live authenticated rendering and real project page-load timing remain unverified.
- **Low - RLS-disabled note is stale.** Query for public base tables with `relrowsecurity=false` returned `[]`; current access-risk candidates are RLS-enabled tables with zero policies: `document_relationships`, `state_projection_shadow_mismatches`.

## 2. Part 0 Findings - Repo/Git State

### Current main and PR status

| Item | Live verification |
|---|---|
| Local main | `HEAD=284bf044...`, `origin/main=478cfd8...`; `git status` shows `main...origin/main [behind 2]`. |
| PR #55 | `MERGED`, head `feat/unify-rate-category-taxonomy`, merged `2026-07-04T20:08:47Z`. |
| PR #56 | `MERGED`, head `feat/project-rate-schedule-fixes`, merged `2026-07-06T00:01:13Z`. |
| PR #57 | `MERGED`, head `consolidate/facts-into-documents-tab`, merged `2026-07-06T18:35:40Z`. |
| PR #58 | `MERGED`, head `fix/overview-required-reviews-unify`, merged `2026-07-07T15:42:21Z`. |
| PR #60 | `MERGED`, head `perf/parallelize-workspace-fetch-and-indexes`, merged `2026-07-08T13:57:39Z`. |
| Validator consolidation branch | Commit `84668dd` is contained in `main`/`origin/main`; no separate PR found by `gh pr list` search. |

### Worktree classifications

| Worktree / branch | Divergence / dirt | Classification |
|---|---:|---|
| `C:/Dev/eightforge-os` / `main` | Behind `origin/main` by 2 commits after fetch. | Active local checkout stale vs remote current. |
| `.claude/worktrees/angry-clarke-82eda7` detached | 32 behind, clean. | Old completed/merged branch pointer. |
| `.claude/worktrees/cool-albattani-ac7ef7` detached | 44 behind, clean. | Old completed/merged branch pointer. |
| `.claude/worktrees/epic-morse-32eb3a` | 50 behind, dirty `lib/server/ai/orchestratorSystemPrompt.ts` +1. | Stranded local edit. |
| `.claude/worktrees/gracious-pascal-5faa9b` | 48 behind, dirty `lib/useProjectWorkspaceData.ts` +1/-82. | High-risk stranded local edit in shared workspace loader. |
| `.claude/worktrees/happy-wescoff-0ec989` | 44 behind, untracked `docs/audits/full-system-audit-2026-07-01.md`. | Stranded audit artifact. |
| `C:/Dev/eightforge-os-remove-ai-enrichment` | 86 behind, dirty 8 files, deletes `aiDecisionPersistence` and `documentAiEnrichment`. | High-risk abandoned/completed-but-unmerged removal work. |
| `C:/Dev/eightforge-os-ask` | 80 behind, 2 ahead. | Completed-but-unmerged or abandoned feature work. |
| `C:/Dev/eightforge-os-orchestrator` | 80 behind, 2 ahead. | Completed-but-unmerged or abandoned feature work. |
| Other listed worktrees (`manual-rate-link-*`, `cc-fix`, `upload-guidance`, `pricing-audit`, gitattributes) | Mostly clean but far behind or ahead/behind. | Old active/completed branch residue requiring owner triage. |

### Stashes

| Stash | Contents | Classification |
|---|---|---|
| `stash@{0}` | `ProjectDocumentsForge.tsx` 693-line rewrite, plus `ProjectOverview.tsx`, `projectOverview.ts`, `useProjectWorkspaceData.ts`; total +253/-553. | Stranded four-surface UI work. |
| `stash@{1}` | Adds `docs/design/snapshots/pre-simplification/*`, 6525 lines. | Snapshot artifact, likely intentional but uncommitted. |
| `stash@{2}` | `lib/projectOverview.ts` +17/-2. | Stranded overview logic. |
| `stash@{3}` | `components/projects/ValidatorTab.tsx` +35/-37. | Stranded validator UI work. |
| `stash@{4}` | `ProjectDecisionQueueFrame.tsx` +1/-1. | Stranded deleted-surface-era UI tweak. |

## 3. Part 1 Findings - Canonical Pipeline Walk

### Anchor A - Golden Project, invoice `2026-002`, 6A hazardous hanging limb

| Stage | Evidence |
|---|---|
| Raw extraction | Golden contract document `18550bfc...` has 19 extraction rows; transaction dataset `68ded1d3...` has `row_count=5063`, `total_cyd_ticket_grain=74617`, `total_extended_cost=815559.35`. |
| Assembly | Contract `rate_schedule_rows` contains `Trees with Hazardous Limbs Hanging Removal >2"` with `unit_type=Tree`, `rate_amount=80`, `canonical_category=tree_operations`, `confidence=medium`. |
| Transaction handoff | `transaction_data_rows` for invoice `2026-002`, billing key `6A` show rows such as source row 2 with `transaction_quantity=1`, `extended_cost=80`, `description_match_key='tree operations hazardous hanging limb removal 2 inch over per tree aft'`. Column `transaction_rate` is null, so the rate is represented by extended cost/quantity and contract support rather than a populated transaction-rate column. |
| Validator | Latest run `5c41300a...`, `status=complete`, rules applied: `required_sources`, `identity_consistency`, `contract_invoice_reconciliation`, `invoice_transaction_reconciliation`, `cross_document_rate_verification`, `financial_integrity`, `ticket_integrity`. No hazardous-limb mismatch remains; 8 open findings are all `FINANCIAL_RATE_CODE_MISSING`. |
| Decision/execution | Decisions `18df4ecf...` and `aa2704f0...` for invoices `2026-002` and `2026-003` are `resolved`, source `project_validator`, with `approval_status=approved`, `at_risk_amount=0`, `supported_amount` equal to billed. |
| UI/persisted summary | `projects.validation_summary_json.exposure` reports invoice `2026-002` `MATCH`, billed/supported `$534,757.10`, at-risk `$0`; invoice `2026-003` `MATCH`, billed/supported `$280,802.25`, at-risk `$0`; project total billed `$815,559.35`, total at-risk `$0`. |

### Anchor B - Golden random invoice lines from other categories

Sample rows from invoice `2026-002`:

| Category/key | Query evidence |
|---|---|
| `1B` vegetative removal | Source rows 3, 6, 29, etc. have `billing_rate_key=1B`, quantities 56/51/50, extended cost 442.40/402.90/395.00, description `vegetative collect remove haul ... 16 to 30 aft`. |
| Management/final-disposal categories | Latest Golden run has no mismatch findings for these sampled rows; remaining findings are missing invoice line rate code only. |

Finding: sampled transaction rows often have `transaction_rate=null` even when `extended_cost` and quantity imply the billed rate. The acceptance gate still passes through validation_summary_json, but this is a raw-column completeness gap worth auditing before downstream consumers rely on `transaction_rate`.

### Anchor C - Goodlettsville

Live Goodlettsville price-sheet rows:

| Document | Rows | Category status |
|---|---:|---|
| `40a7f15b...` price sheet | 5 | All 5 rows have non-null `canonical_category` and `category_confidence` (`vegetative_removal`, `management_reduction`, `final_disposal`, `tree_operations`). |
| `e98315b8...` price sheet | 5 | Same 5 non-null rows/categories. |

Finding: prompt expected three documents with five rows each; live project has two price-sheet documents with five persisted rate rows each. Latest validation run `5dad11d6...` is `complete` with 96 findings, including 66 critical `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` findings where actual is `No confident contract rate-row match found`, linked to decision `8ebc4773...` and execution items. The category backfill itself is intact on the two live documents found, but the project remains blocked.

### Anchor D - Blocked document

Selected document: Goodlettsville price sheet `40a7f15b...`, `processing_status=decisioned`, `operational_status=Blocked`, `processing_error=null`, 28 extraction rows, 5 assembled rate rows. The block is not an extraction failure; it is downstream validation/contract-rate matching failure. Latest Goodlettsville validation shows 96 open findings and total at-risk exposure `$2,832,269.32`.

### Anchor E - TDOT and MDOT

| Project | Document | Live rows | Finding |
|---|---|---:|---|
| TDOT | `SWC 820 - Fern - Contract #89633...`, doc `582e57b2...` | 32 `rate_schedule_rows` | Required Appendix B 32-row stitcher is intact. Persisted `facts.rate_row_count=30`, so fact count disagrees with live row array. |
| MDOT | `310225302000_Executed_Contractor.pdf`, doc `6866832f...` | 5 `rate_schedule_rows` | Required Section 905 parser count is intact. Persisted `facts.rate_row_count=49`, so fact count is stale/wrong versus live row array. |

### Anchor F - MVSU

MVSU `Exhibit A.pdf` (`c17d9278...`) has 3 rate rows:

| Row | Description | Rate | Unit | Category | Confidence |
|---:|---|---:|---|---|---|
| 1 | Operations Manager | 125 | Hour | personnel | high |
| 2 | Data Manager | 110 | Hour | personnel | high |
| 3 | Operations Manager - Mobilization/Demobilization | 125 | Hour | personnel | needs_review |

The row 3 review flag exists as `confidence='needs_review'`; no separate `requires_review` boolean was found on the persisted row. Authenticated UI rendering of the Contract Pricing Assembly panel could not be verified because browser access redirected to `/login`.

## 4. Part 2 Findings - Produced vs Consumed Cross-Reference

| Resolver/map/table | Writer | Reader | Status |
|---|---|---|---|
| `invoiceLineToRateMap` | `buildInvoiceLineToRateMap()` in `projectValidator.ts` after `factLookups` and manual links are loaded. | `rateBasedContractValidation`, `invoiceTransactionReconciliation`, `financialIntegrity`, `exposure`. | Active. Identifier path includes both current and legacy synthesized line IDs. |
| `manualRateLinkOverrides` / `invoice_line_rate_links` | `/api/projects/[id]/invoice-line-rate-link`; table has live schema and RLS. | `loadManualRateLinkOverrides()` then `resolveManualRateLinkOverride()` in validator; `crossDocumentRateVerification` uses `input.manualRateLinkOverrides?.get(line.line_id)`. | Active. Prior Pass 2 typed-id mismatch appears addressed by fallback lookup. |
| `contractUploadGuidance` / `contract_upload_guidance` | `/api/documents/[id]/upload-guidance`; `loadContractUploadGuidanceForDocument()`. | `projectValidator.ts` loads for contract doc and passes `contractUploadGuidanceRateScheduleIncluded`; `rateBasedContractValidation` consumes it. | Active. |
| `document_fact_overrides` | `/api/documents/[id]/facts/override`, execution outcome route, document route. | `projectValidator.ts`, ask retrieval, document route. | Active. Also used by execution outcome route for override audit/side effects. |
| `factLookups.*` | `buildFactLookups()` / validation input loading from project docs, persisted facts, contract rows. | All major rule packs. | Active; however MDOT/TDOT examples show persisted `facts.rate_row_count` can be stale relative to `contract_analysis.rate_schedule_rows`. |
| `resolveProjectIssueObjects` | Produced client-side from live findings/evidence/decisions/execution/documents. | Overview required-review metric and Validator findings panel. | Active and shared. Live resolver probe: Golden had 342 issues / 3 required reviews; Goodlettsville had 120 issues / 106 required reviews. Same object array is passed from `ProjectOverview` into `ValidatorTab`. |
| `state_projection_shadow_mismatches` | `logStateProjectionMismatch()` call sites in document/status/issue/execution resolution. | No operational reader found. | Write-only/observability gap. Console warnings fired but live table remained empty. |

Required Reviews drift check: source code uses `issueObjects.filter(isIssueRequiringReview)` for Overview and passes the same `issueObjects` into `ValidatorTab`/`ValidatorFindingsPanel`. Live resolver shows the count is not equal to open findings; it includes execution-backed and resolved issue objects. That is consistent between surfaces but surprising: Golden has 8 open findings, 342 issue objects, 3 required reviews.

## 5. Part 3 Findings - Known Open Items

| Item | Current live status | Assessment |
|---|---|---|
| `portfolioCommandCenter.ts` and `decision_detections` | `decision_detections` now exists, RLS enabled, 3 rows. `buildPortfolioCommandCenter('11111111-...')` returned 6 projects and issue ranking. | Prior missing-table finding resolved. New minor risk: calling without org id returns null after Supabase UUID error for `"undefined"`. |
| RLS disabled on 6 tables | Live query returned `[]`. | Prior note stale. Current risk: `document_relationships` and `state_projection_shadow_mismatches` have RLS enabled but zero policies. |
| `approval_action_log` missing | `to_regclass=null`; code still queries/writes it. | Still open, high severity for approval history/outcome traceability. |
| H1 retirement / shadow mismatch | Live table empty, but resolver emitted five Golden console mismatches (`legacy_value='resolved'`, `persisted_value='open'`, surface `resolveProjectIssueObjects.findingBacked`). The previously observed MDOT `6866832f...` mismatch was not present in the table. | Still occurring, but now observed on Golden findings. Sink did not persist evidence. |
| Four-surface Forge resurface | Static code has tabs `Overview`, `Documents`, `Validator`, `Audit`; `#project-facts` routes to `documents`; `#project-decisions` routes to `validator`; Documents includes `Project Facts`; Validator has three-panel copy `Findings / Evidence & Truth / Decision & Execution`. | Source verified. Authenticated browser rendering not verified due login redirect. |

## 6. Part 4 Findings - Orphaned Code Sweep

| Sweep item | Evidence | Status |
|---|---|---|
| Deleted Forge components | `components/projects/ProjectIssueBoard.tsx` and `ProjectDecisionQueueFrame.tsx` do not exist. No source imports found. | Runtime deletion complete. |
| Stale references to deleted components | `rg` finds many references in `docs/audits/*`, `docs/design/snapshots/*`, `EIGHTFORGE_SYSTEM_MAP.md`, and migration comments. | Documentation/snapshot residue, not runtime. |
| Missing live tables queried by current source | `approval_action_log`, `document_facts`, `invoices`, `invoice_lines`, `validation_runs`, `validation_findings`. | `approval_action_log` is active runtime risk. `document_facts`/invoice legacy tables appear in retrieval/persistence/fallback/audit scripts and need separate triage; live canonical tables are `document_extractions`, `transaction_data_*`, `project_validation_*`. |
| Registered rule packs never invoked | `projectValidator.ts` imports/invokes `requiredSources`, `identityConsistency`, `contractInvoiceReconciliation`, `invoiceTransactionReconciliation`, `crossDocumentRateVerification`, `financialIntegrity`, `ticketIntegrity`; `financialIntegrity` imports rate-based validation. | No registered-but-never-invoked rule pack found among current main packs. |
| Exported zero-reference candidates | Naive static sweep produced many candidates (e.g. `computeAgingCounts`, ask components, helper exports), but this is noisy in Next/TS due route/module boundaries and tests excluded. | Needs dedicated TS-aware unused-export tool before deletion. Do not treat as confirmed dead code. |

## 7. Part 5 Findings - This Session's Work Re-Verification

| Item | Claimed status at shipping | Current live-verified status | Drift/regression |
|---|---|---|---|
| 5.1 all 8 categories via `canonicalTaxonomyKeyForAllowedCategory` | Verified, including C&D bug | Targeted tests passed: 132 tests across `rateTaxonomy`, `contractPricingAssembly`, `exhibitARateTableRows`; code maps all 8 allowed labels. | No regression found in tests. |
| 5.1 MVSU row count | 3 rows, row 3 requires review | Live `Exhibit A.pdf` has 3 rows; row 3 `confidence=needs_review`. | No separate `requires_review` boolean persisted. |
| 5.1 TDOT row count | 32 rows | Live TDOT main contract has 32 rows. | `facts.rate_row_count=30` is stale. |
| 5.1 MDOT row count | 5 rows | Live MDOT contract has 5 rows. | `facts.rate_row_count=49` is stale. |
| 5.1 Goodlettsville categories | 3 docs x 5 rows non-null | Live has 2 price-sheet docs x 5 rows, all non-null categories/confidence. | Expected third doc not found. |
| 5.1 Williamson fixes | OCR corrections, `$18.80`, `$80`, dedupe/counts intact | Live contract has `$80` hazardous hanging row; `$18.80` rows collapsed to two distinct descriptions; `$15.80` row present; category counts total 105 rows with one null category. | Persisted `facts.rate_row_count=104` vs 105 row array; one null category remains. |
| 5.1 Golden acceptance gates | CYD 74,617; `$815,559.35`; invoices match; `$0` at risk | Live dataset and validation summary confirm all acceptance gates. | No acceptance regression. |
| 5.2 Mechanism 1 | `segmentationSuspect` present/functioning | Present in `exhibitARateTableRows.ts`; used to downgrade confidence and recovery reason. | Verified by code/tests. |
| 5.2 Mechanism 2 | `rate_ocr_confidence` threaded; `0.65` gate active | Field present in types/extraction rows/tests. No explicit `0.65` threshold found by static search. | Gate claim unverified/regressed. |
| 5.2 Mechanism 3 | Token-rejoin fallback scoped multiword-only | `recoverDescriptionByCategoryWithFallback` and `TOKEN_REJOIN_ELIGIBLE_DESCRIPTIONS` present; allowlist entries are multiword labels. | Verified by code/tests. |
| 5.2 Mechanism 4 | Normalization consolidation | `lib/contracts/textCleanupPrimitives.ts` exists; consumed by `contractPricingAssembly.ts`, `contractRateScheduleRows.ts`, `exhibitARateTableRows.ts`. | Verified. |
| 5.2 Mechanism 5 | Merge diagnostics attached | `ContractPricingRowMergeDiagnostic` and `mergeDiagnostics` present at `selectOperatorFacingRows`. Tests assert diagnostic exists. | Open risk remains: live rows sampled did not carry mergeDiagnostics; geometric provenance remains extraction-layer risk. |
| 5.3 Forge tabs | Four surfaces | Static code verifies `Overview`, `Documents`, `Validator`, `Audit`; not five/six. | Authenticated browser rendering unverified due `/login`. |
| 5.3 legacy hashes | `#project-facts`, `#project-decisions` redirect | `projectForgeNavigation.ts` maps facts to `documents`, decisions/actions to `validator`; anchors preserved in surfaces. | Verified by code, not by authenticated browser. |
| 5.3 Decision & Execution write path | Execution-only route | `ValidatorDecisionExecutionPanel` actions call `executeProjectExecutionResolution`, which PATCHes `/api/execution-items/[id]/outcome`. | Verified. Older decision feedback route still exists outside this panel. |
| 5.3 decision-card deferred item | Old `model.decisions` still deferred | New panel uses `issueObjects`; `model.decisions` still exists for overview/legacy decision cards and open decision count. | Partially changed; old model path not eliminated globally. |
| 5.3 Escalate absent | No Escalate in execution-only path | Action set is Confirm/Correct/Override only. | Verified. |
| 5.4 indexes | Two indexes applied and used | Live indexes exist; `EXPLAIN ANALYZE` used both target indexes. Activity query execution ~31.99 ms for 200 rows; transaction pagination ~0.245 ms for 100 rows. | Verified. |
| 5.4 Promise.all perf pass | Parallelized groupings present | `origin/main` has stage-1 `Promise.all`, decisions/tasks `Promise.all`, audit fetch after decisions/tasks, and `loadProjectActivityEvents` parallel project/fallback queries. | Verified in `origin/main`; local checkout still behind. |
| 5.4 live timing | Not captured previously | Playwright redirected project URL to `/login`; measured login redirect/page, not authenticated project load. | Remains unverified. |
| 5.4 caching/SWR/RSC deferred | Deferred | Static search found no `useSWR`; API cache headers exist for portfolio/operations. Project page remains client hook based. | Deferred architecture remains untouched. |
| 5.5 cross-cutting | No regressions | No regression to Golden acceptance or TDOT/MDOT row arrays; however stale `facts.rate_row_count` and H1 resolver mismatch are cross-cutting. | Findings above. |

## 8. Full Prioritized Bug List

| Severity | Classification | Description | Evidence | Affected scope | Suggested next Phase A prompt title |
|---|---|---|---|---|---|
| High | Repo hygiene / release risk | Completed or meaningful work is stranded across many worktrees/stashes. | 17 worktrees; dirty `useProjectWorkspaceData.ts` deletion; AI-enrichment removal dirty worktree; 5 stashes. | All future audits and agent work. | "Phase A: EightForge Worktree and Stash Triage Inventory" |
| High | Schema/runtime mismatch | `approval_action_log` missing while current code queries/writes it. | `to_regclass=null`; refs in workflow outcomes route, approval history, approval action engine. | Approval audit/history and automation traceability. | "Phase A: approval_action_log Live Schema Runtime Audit" |
| High | State projection drift | Resolver emits H1 mismatches but sink stays empty. | Console warnings for Golden findings; subsequent DB query returned `[]`. | Validator/Overview lifecycle truth, auditability. | "Phase A: State Projection Shadow Sink End-to-End Verification" |
| Medium | Canonical fact staleness | TDOT/MDOT/Williamson live row arrays disagree with persisted `facts.rate_row_count`. | TDOT 32 vs fact 30; MDOT 5 vs fact 49; Williamson 105 vs fact 104. | Project facts, Overview, validator input fallbacks. | "Phase A: Rate Row Count Canonical Source Audit" |
| Medium | Extraction mechanism claim drift | Mechanism 2 lacks found explicit `0.65` needs-review gate. | Static search found `rate_ocr_confidence` but no `0.65` threshold. | OCR trust gating and operator review surfacing. | "Phase A: rate_ocr_confidence Gate Trace Audit" |
| Medium | Goodlettsville live-shape mismatch | Expected 3 price-sheet docs x 5 rows; live has 2 x 5. | Live document/rate row query. | Goodlettsville acceptance criteria and backfill completeness. | "Phase A: Goodlettsville Price Sheet Duplicate/Backfill Audit" |
| Medium | Project schema drift | Code selects `projects.validation_phase`; live `projects` lacks column. | Information schema query; code in `useProjectWorkspaceData.ts`. | Project workspace loading/fallback behavior. | "Phase A: projects.validation_phase Schema Compatibility Audit" |
| Medium | Missing legacy tables in active source | Current source references `document_facts`, `invoices`, `invoice_lines`, `validation_runs`, `validation_findings`, none live. | Static `.from()` scan vs information schema. | Ask retrieval, invoice persistence, audit scripts/fallbacks. | "Phase A: Legacy Table Reference Runtime Classification" |
| Medium | UI verification gap | Authenticated Forge rendering and project page-load timing were not verified. | Playwright redirected project URL to `/login`; screenshot saved under `output/playwright/full-system-audit-project.png`. | Forge redesign confidence and perf timing. | "Phase A: Authenticated Forge Browser Verification and Timing Capture" |
| Low | Documentation drift | Deleted `ProjectIssueBoard` / `ProjectDecisionQueueFrame` remain in docs/snapshots/system map. | `rg` references in docs and snapshots; source components absent. | Future agent/operator context accuracy. | "Phase A: Forge Historical Docs Labeling Sweep" |
| Low | RLS policy coverage | No RLS-disabled tables, but two RLS-enabled tables have zero policies. | `document_relationships`, `state_projection_shadow_mismatches`. | Supabase access model clarity. | "Phase A: RLS Zero-Policy Table Intent Audit" |
