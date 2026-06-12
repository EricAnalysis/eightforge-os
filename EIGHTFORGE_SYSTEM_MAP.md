# EIGHTFORGE SYSTEM MAP
## 1. REPO METADATA
```
$ git remote -v (origin only)
origin	https://github.com/EricAnalysis/eightforge-os.git (fetch)
origin	https://github.com/EricAnalysis/eightforge-os.git (push)
$ current branch
feat/WorkHereOnly
$ git log --oneline -n 20
20c3cfa9 Pass 1: row-backed canonical projection input
44de2a0a Reclassify selector computes as upstream gaps
20822e2e Add Ask command system and Phase 3 regression harness
db6c50dc Triage behavioral test regressions
d3bc3bf2 Add operational rate schedule fallback
a52e1840 Stabilize validation revalidate persistence and side effects
46d000cb Fix vendor validation to use resolved canonical fact truth
7eb63bfa chore(skills): add shared skills sync script
a41863bf chore(agents): document EightForge reviewer architecture
9a28a94a chore(cursor): add cross-document reviewer skill
71533102 chore(cursor): add EightForge Cursor reviewer skills
15721164 Wire document relationship context into validator truth
2f352dd1 Update commit message generation
5dc30980 fix: defer Supabase client init and align decision task typing
14dad13c chore: remove tracked debug/tooling noise before merge (.playwright-cli, output, tmp-*, tmp/pdfs, supabase/.temp, .claude/*.js)
79f67e56 fix: unify processing status strip with derivedDocumentStatus; fix spreadsheet Dataset Summary metrics
f5a7839c feat: unified EightForge architecture (squashed clean state)
643742b9 Update eightforge-os
5757cda9 update
0d45718c EightForge
$ total tracked file count
623
$ top-level dir list depth 1
DIR  .agents
DIR  .claude
DIR  .cursor
FILE .env.local
DIR  .git
FILE .gitattributes
DIR  .github
FILE .gitignore
DIR  .next
DIR  .playwright-cli
DIR  .vscode
FILE AGENTS.md
DIR  app
FILE baseline-failures.txt
DIR  components
FILE current-failures.txt
FILE current-test-output.txt
DIR  docs
FILE EIGHTFORGE_SYSTEM_MAP.md
DIR  eightforge-os
FILE eng.traineddata
FILE eslint.config.mjs
FILE failure-set-diff.txt
FILE known-failures-ledger.md
DIR  lib
DIR  migrations
FILE next.config.ts
FILE next-env.d.ts
DIR  node_modules
FILE package.json
FILE package-lock.json
FILE PHASE_13_INTEGRATION.md
FILE PHASE_13_SUMMARY.md
FILE PHASE_6_SUMMARY.md
FILE playwright.config.ts
DIR  plugins
FILE postcss.config.mjs
DIR  public
FILE README.md
DIR  scripts
DIR  supabase
DIR  tests
FILE tsc-errors.txt
FILE tsconfig.json
FILE tsconfig.tsbuildinfo
DIR  types
FILE vercel.json
FILE vitest.config.ts
```
## 2. DEPENDENCY SNAPSHOT
```
dependencies:
@anthropic-ai/sdk@^0.78.0
@instructor-ai/instructor@^1.7.0
@napi-rs/canvas@^0.1.97
@supabase/supabase-js@^2.98.0
@tesseract.js-data/eng@^1.0.0
lucide-react@^1.7.0
next@16.1.6
openai@^6.27.0
pdfjs-dist@^5.5.207
pdf-parse@^1.1.1
react@19.2.3
react-dom@19.2.3
tesseract.js@^7.0.0
xlsx@^0.18.5
zod@^3.25.76
devDependencies:
@playwright/test@^1.58.2
@tailwindcss/postcss@^4
@types/node@^20
@types/pdf-parse@^1.1.5
@types/react@^19
@types/react-dom@^19
dotenv@^16.0.0
eslint@^9
eslint-config-next@16.1.6
tailwindcss@^4
typescript@^5
vitest@^3.2.4
explicit versions:
next@16.1.6
react@19.2.3
typescript@^5
tailwindcss@^4
@supabase/supabase-js@^2.98.0
zod@^3.25.76
vitest@^3.2.4
MISSING: jest
MISSING: playwright
@playwright/test@^1.58.2
```
## 3. DIRECTORY MAP (depth 3, noise excluded)
```
app/
app/api/operations/route.ts
app/api/projects/route.ts
app/api/rules/route.ts
app/favicon.ico
app/globals.css
app/layout.tsx
app/login/page.tsx
app/page.tsx
app/platform/agents/page.tsx
app/platform/dashboard/page.tsx
app/platform/decisions/page.tsx
app/platform/documents/page.tsx
app/platform/issues/page.tsx
app/platform/layout.tsx
app/platform/page.tsx
app/platform/portfolio/page.tsx
app/platform/projects/page.tsx
app/platform/reviews/page.tsx
app/platform/rules/page.tsx
app/platform/settings/page.tsx
app/platform/workflows/page.tsx
app/platform/workspace/page.tsx
MISSING: pages/
components/
components/ActivityTimeline.tsx
components/approval/ApprovalActionTimeline.tsx
components/approval/ApprovalTaskResolutionControls.tsx
components/approval/InvoiceApprovalBadge.tsx
components/approval/ProjectBlockedBanner.tsx
components/ApprovalHistoryTimeline.tsx
components/ask/AskActionsRow.tsx
components/ask/AskAnswerBlock.tsx
components/ask/AskFollowups.tsx
components/ask/AskInterface.tsx
components/ask/askResponseAdapter.ts
components/ask/AskResponsePanel.tsx
components/ask/AskSourcesList.tsx
components/ask/ProjectQueryResultCard.tsx
components/ask/SuggestedQueries.tsx
components/ask/TruthResultCard.tsx
components/decision-detail/DecisionContextPanel.tsx
components/decision-detail/DecisionDetailView.tsx
components/decision-detail/DecisionWorkflowOutcomePanel.tsx
components/document-intelligence/AskDocumentSection.tsx
components/document-intelligence/AuditSection.tsx
components/document-intelligence/CrossDocChecks.tsx
components/document-intelligence/DecisionsSection.tsx
components/document-intelligence/DiagnosticsDrawer.tsx
components/document-intelligence/DocumentDetailExperience.tsx
components/document-intelligence/DocumentIntelligenceStrip.tsx
components/document-intelligence/DocumentIntelligenceWorkspace.tsx
components/document-intelligence/DocumentSourceViewer.tsx
components/document-intelligence/EntityChips.tsx
components/document-intelligence/EvidenceSection.tsx
components/document-intelligence/FactEvidencePanel.tsx
components/document-intelligence/FactLedger.tsx
components/document-intelligence/FlowSection.tsx
components/document-intelligence/InvoiceSurface.tsx
components/document-intelligence/ReviewSection.tsx
components/document-intelligence/SignalsSection.tsx
components/document-intelligence/SpreadsheetReviewSurface.tsx
components/document-intelligence/SummaryCard.tsx
components/DocumentProcessingStatus.tsx
components/documents/DocumentProjectControls.tsx
components/evidence/EvidenceInspector.tsx
components/evidence/evidenceInspectorModel.ts
components/forge/ForgeDetailPanel.tsx
components/forge/ForgeMetricCard.tsx
components/forge/ForgeSectionCard.tsx
components/platform/AskEightForgeCommandBar.tsx
components/platform/AskEightForgeResponsePanel.tsx
components/platform/AskOperationsResultCard.tsx
components/platform/AskOperationsSection.tsx
components/platform/AskScopeEntry.tsx
components/platform/command-center.tsx
components/platform/OperationalDiagnostics.tsx
components/platform/OperatorGraphPanel.tsx
components/projects/DocumentPrecedenceSection.tsx
components/projects/ProjectAdminControls.tsx
components/projects/ProjectAuditForge.tsx
components/projects/ProjectDecisionExecutionCard.tsx
components/projects/ProjectDecisionQueueFrame.tsx
components/projects/ProjectDocumentsForge.tsx
components/projects/ProjectExecutionForge.tsx
components/projects/ProjectFactsForge.tsx
components/projects/ProjectIntelligenceSnapshot.tsx
components/projects/ProjectIssueBoard.tsx
components/projects/ProjectOverview.tsx
components/projects/ValidatorTab.tsx
components/rules/ActionBuilder.tsx
components/rules/ConditionsBuilder.tsx
components/rules/RuleForm.tsx
components/rules/RuleTestPanel.tsx
components/ui/badge.tsx
components/ui/card.tsx
components/ui/EightForgeLogo.tsx
components/ui/tabs.tsx
components/ui/tooltip.tsx
components/validator/ValidationAuditEventSummary.tsx
components/validator/ValidatorEvidenceDrawer.tsx
components/validator/ValidatorFindingsTable.tsx
components/validator/ValidatorStatusChip.tsx
lib/
lib/aging.ts
lib/ai/instructor/classifyDocumentFamily.ts
lib/ai/instructor/client.ts
lib/ai/instructor/extractionAssist.ts
lib/ai/instructor/instructorAssist.test.ts
lib/ai/instructor/schemas.ts
lib/ai/instructor/types.ts
lib/ask/aggregateSummaries.test.ts
lib/ask/aggregateSummaries.ts
lib/ask/answerBuilder.test.ts
lib/ask/answerBuilder.ts
lib/ask/canonicalPrompts.ts
lib/ask/canonicalReadGuard.ts
lib/ask/classifier.test.ts
lib/ask/classifier.ts
lib/ask/documentRouteHelpers.test.ts
lib/ask/globalCommand.test.ts
lib/ask/globalCommand.ts
lib/ask/portfolioAnswerBuilder.test.ts
lib/ask/portfolioAnswerBuilder.ts
lib/ask/portfolioHandoffContext.ts
lib/ask/portfolioProjectStatusAggregate.test.ts
lib/ask/portfolioProjectStatusAggregate.ts
lib/ask/portfolioStalenessCheck.ts
lib/ask/queryTemplates.ts
lib/ask/reasoning.test.ts
lib/ask/reasoning.ts
lib/ask/retrieval.test.ts
lib/ask/retrieval.ts
lib/ask/selectors/index.ts
lib/ask/selectors/portfolioProjectStatus.ts
lib/ask/selectors/projectApprovalExecutionState.ts
lib/ask/selectors/projectContractAuthority.ts
lib/ask/selectors/projectInvoiceSupport.ts
lib/ask/selectors/projectReviewAuditState.ts
lib/ask/selectors/projectTicketValidation.ts
lib/ask/selectors/selectorUtils.ts
lib/ask/sqlGuardrails.ts
lib/ask/suggestedQueries.test.ts
lib/ask/types.ts
lib/ask/upstreamGapDetector.ts
lib/ask/useAskDispatch.ts
lib/ask/validatorIntegration.ts
lib/blobExtractionSelection.ts
lib/brand.ts
lib/canonicalIntelligenceFamilies.ts
lib/contractInvoicePrimary.ts
lib/contracts/analyzeContractIntelligence.ts
lib/contracts/clausePatternLibrary.v1.ts
lib/contracts/contractCeiling.ts
lib/contracts/contractDecisions.test.ts
lib/contracts/contractDecisions.ts
lib/contracts/contractIntelligence.femaMockCorpus.test.ts
lib/contracts/contractIntelligence.golden.test.ts
lib/contracts/contractIntelligence.realFixtures.audit.test.ts
lib/contracts/contractIntelligence.test.ts
lib/contracts/contractorIdentity.test.ts
lib/contracts/contractorIdentity.ts
lib/contracts/contractPricingAssembly.test.ts
lib/contracts/contractPricingAssembly.ts
lib/contracts/contractRateScheduleRows.ts
lib/contracts/contractRateTableColumns.test.ts
lib/contracts/contractTaskGeneration.test.ts
lib/contracts/contractTaskGeneration.ts
lib/contracts/coverageLibrary.v1.ts
lib/contracts/exhibitARateTableRows.test.ts
lib/contracts/exhibitARateTableRows.ts
lib/contracts/languageEngineFields.v1.ts
lib/contracts/types.ts
lib/crossDocumentGrounding.test.ts
lib/currentWork.ts
lib/dateUtils.ts
lib/decisionActions.ts
lib/decisionContext.test.ts
lib/decisionContext.ts
lib/decisionDetail.test.ts
lib/decisionDetail.ts
lib/decisionNavigation.test.ts
lib/decisionNavigation.ts
lib/decisions/decisionStatusRoute.test.ts
lib/decisionToWorkflow.ts
lib/documentFactActivity.test.ts
lib/documentFactActivity.ts
lib/documentFactAnchors.ts
lib/documentFactOverrides.ts
lib/documentFactReviews.ts
lib/documentIntelligence.detectedType.test.ts
lib/documentIntelligence.invoiceCanonicalTasks.test.ts
lib/documentIntelligence.spreadsheetReview.integration.test.ts
lib/documentIntelligence.ts
lib/documentIntelligenceViewModel.test.ts
lib/documentIntelligenceViewModel.ts
lib/documentNavigation.test.ts
lib/documentNavigation.ts
lib/documentOperationalStatus.ts
lib/documentPrecedence.test.ts
lib/documentPrecedence.ts
lib/documents/documentFactReviewRoute.test.ts
lib/documents/documentReviewRoute.test.ts
lib/documentTypes.ts
lib/documentWorkspace.test.ts
lib/documentWorkspace.ts
lib/effectiveFacts.test.ts
lib/effectiveFacts.ts
lib/execution/executionItemOutcomeRoute.test.ts
lib/execution/executionSummary.test.ts
lib/execution/executionSummary.ts
lib/execution/syncExecutionItems.test.ts
lib/execution/syncExecutionItems.ts
lib/executionItems.ts
lib/extraction/evidenceValueMatch.test.ts
lib/extraction/evidenceValueMatch.ts
lib/extraction/failureModes/contractFailureModes.ts
lib/extraction/pdf/buildElementEvidence.ts
lib/extraction/pdf/buildEvidenceMap.ts
lib/extraction/pdf/extractForms.ts
lib/extraction/pdf/extractTables.test.ts
lib/extraction/pdf/extractTables.ts
lib/extraction/pdf/extractText.test.ts
lib/extraction/pdf/extractText.ts
lib/extraction/pdf/mapUnstructuredElements.ts
lib/extraction/pdf/ocrGeometryLayout.test.ts
lib/extraction/pdf/ocrGeometryLayout.ts
lib/extraction/pdf/partitionWithUnstructured.ts
lib/extraction/pdf/pdfControlSanitization.test.ts
lib/extraction/pdf/types.ts
lib/extraction/pdf/unstructuredPartitioning.test.ts
lib/extraction/textSanitization.ts
lib/extraction/types.ts
lib/extraction/withSourceDocument.ts
lib/extraction/xlsx/buildSpreadsheetEvidence.ts
lib/extraction/xlsx/detectSheets.ts
lib/extraction/xlsx/normalizeTicketExport.ts
lib/extraction/xlsx/normalizeTransactionData.test.ts
lib/extraction/xlsx/normalizeTransactionData.ts
lib/extraction/xlsx/parseWorkbook.test.ts
lib/extraction/xlsx/parseWorkbook.ts
lib/extraction/xlsx/ticketEvidenceGrounding.test.ts
lib/forgeDecisionGenerator.test.ts
lib/forgeDecisionGenerator.ts
lib/forgeStageCounts.test.ts
lib/forgeStageCounts.ts
lib/intelligence/groundingRefs.ts
lib/invoiceLedgerInsights.ts
lib/invoices/invoiceCanonicalNames.test.ts
lib/invoices/invoiceCanonicalNames.ts
lib/invoices/invoiceParser.test.ts
lib/invoices/invoiceParser.ts
lib/isMissingProjectIdColumnError.ts
lib/issueObjects.ts
lib/operationalTables/adapters/contractRateScheduleFragmentAdapter.test.ts
lib/operationalTables/adapters/contractRateScheduleFragmentAdapter.ts
lib/operationalTables/canonicalOperationalRateDiff.test.ts
lib/operationalTables/canonicalOperationalRateDiff.ts
lib/operationalTables/canonicalOperationalTableRowAssembler.test.ts
lib/operationalTables/canonicalOperationalTableRowAssembler.ts
lib/operationsQuery/askOperationsChips.test.ts
lib/operationsQuery/askOperationsChips.ts
lib/operationsQuery/askOperationsExecutionAdapter.ts
lib/operationsQuery/buildResult.ts
supabase/
supabase/migrations/20250311000000_add_workflow_trigger_rules.sql
supabase/migrations/20250312000000_add_assignment_fields.sql
supabase/migrations/20250313000000_add_activity_events.sql
supabase/migrations/20250314_verification_checklist.sql
supabase/migrations/20250314000000_deterministic_decision_backbone.sql
supabase/migrations/20250314000001_seed_debris_ops.sql
supabase/migrations/20250316000000_add_rls_document_extractions_rules_signals.sql
supabase/migrations/20250316000001_fix_user_profiles_rls_recursion.sql
supabase/migrations/20250316000002_stuck_document_detection.sql
supabase/migrations/20250317000000_projects_unique_code.sql
supabase/migrations/20260318000000_document_reviews.sql
supabase/migrations/20260319000000_document_intelligence_trace_and_review_error_type.sql
supabase/migrations/20260323000000_document_precedence.sql
supabase/migrations/20260328000000_document_fact_overrides.sql
supabase/migrations/20260328000001_document_fact_anchors.sql
supabase/migrations/20260328000002_rate_schedule_anchor_extensions.sql
supabase/migrations/20260328000003_document_fact_reviews.sql
supabase/migrations/20260329000000_add_project_id_to_decisions_and_tasks.sql
supabase/migrations/20260329010000_project_admin_controls.sql
supabase/migrations/20260330000000_add_role_to_user_profiles.sql
supabase/migrations/20260330000001_fix_decisions_source_check.sql
supabase/migrations/20260401000000_project_validator_phase0_schema.sql
supabase/migrations/20260401010000_project_validator_activity_events.sql
supabase/migrations/20260404000000_transaction_data_project_persistence.sql
supabase/migrations/20260407_approval_action_log.sql
supabase/migrations/20260407_workflow_task_resolution.sql
supabase/migrations/20260417000000_align_transaction_data_schema_to_code_contract.sql
supabase/migrations/20260422000000_truth_mutation_activity_events.sql
supabase/migrations/20260429000000_validation_request_activity_events.sql
supabase/migrations/20260430000000_document_truth_governance_phase.sql
supabase/migrations/20260506000000_execution_items.sql
supabase/migrations/20260506001000_execution_item_activity_events.sql
supabase/migrations/20260506002000_execution_item_override_suppression.sql
supabase/migrations/20260602000000_allow_project_validator_decision_source.sql
supabase/migrations/20260602001000_create_approval_snapshots.sql
```
## 4. CANONICAL TRUTH LAYER — EXPORTED SIGNATURES ONLY
```
MISSING: lib/facts
999:export function analyzeContractIntelligence(
3:export const CLAUSE_PATTERN_LIBRARY_V1: ClausePatternDefinition[] = [
228:export const CLAUSE_PATTERN_LIBRARY_V1_BY_ID = new Map(
3:export const RATE_BASED_CEILING_EVIDENCE_REGEXES: readonly RegExp[] = [
14:export function isRatePriceNoCeilingMachineClassification(
20:export function hasRateBasedCeilingLanguage(text: string | null | undefined): boolean {
26:export function classifyContractCeiling(params: {
51:export function contractCeilingDisplay(type: ContractCeilingType): string {
62:export function contractCeilingSummary(type: ContractCeilingType): string {
25:export interface EvaluationOptions {
39:export function evaluateOperationalDecisions(
33:export type RankedContractorCandidate = {
49:export type ContractorIdentityResolution = {
201:export function organizationNamesLookEquivalent(a: string, b: string): boolean {
511:export function resolveContractorIdentity(document: NormalizedNodeDocument): ContractorIdentityResolution {
630:export function applyContractorIdentityResolutionToNormalizedDocument(
3:export type ContractPricingAssemblyConfidence = 'high' | 'medium' | 'low' | 'needs_review';
4:export type ContractPricingSourceKind =
11:export type ContractPricingSourceQuality = 'clean' | 'partial' | 'fallback' | 'junk';
13:export type ContractRateDescriptionDisplayQuality = 'clean' | 'partial' | 'damaged';
14:export type ContractRateDescriptionStateHint = 'confirmed' | 'derived' | 'needs_review';
16:export type ContractRateDescriptionDisplayCleanup = {
22:export type ContractPricingAssemblyRow = {
38:export type ContractPricingAssemblySourceOptions = {
151:export function parseContractPricingRate(value: unknown): number | null {
167:export function formatContractPricingRate(value: number | null): string {
982:export function scoreContractPricingRowSourceQuality(params: {
1055:export function cleanContractRateDescriptionForDisplay(params: {
1507:export function assembleContractPricingRows(
628:export function buildContractRateScheduleRows(
68:export function generateOperationalTasks(
6:export const COVERAGE_LIBRARY_V1: Record<ContractDocumentTypeProfile, ContractCoverageDefinition[]> = {
559:export function extractExhibitARateTableRows(tables: readonly PdfTable[] | null | undefined): ContractRateScheduleRow[] {
6:export const LANGUAGE_ENGINE_FIELDS_V1: Record<ContractObjectFamily, LanguageEngineFieldDefinition[]> = {
310:export const LANGUAGE_ENGINE_FIELDS_V1_BY_ID = new Map(
1:export const LANGUAGE_ENGINE_FIELDS_VERSION_V1 = 'language_engine_fields:v1';
2:export const CLAUSE_PATTERN_LIBRARY_VERSION_V1 = 'clause_pattern_library:v1';
3:export const COVERAGE_LIBRARY_VERSION_V1 = 'coverage_library:v1';
5:export type ContractObjectFamily =
15:export type ContractFieldState =
22:export type ContractValueType =
30:export type ContractCriticality = 'P1' | 'P2' | 'P3';
32:export type ContractDownstreamDependency =
40:export type ContractFieldId =
64:export type ContractCeilingType = 'total' | 'rate_based' | 'none';
66:export interface LanguageEngineFieldDefinition {
80:export type ClausePatternFamily =
99:export interface ClausePatternDefinition {
112:export interface DetectedClausePattern {
123:export type ContractDocumentTypeProfile = 'fema_disaster_recovery_debris_contract';
124:export type ContractCoverageFamily =
131:export type ContractExtractionQuality = 'strong' | 'partial' | 'weak' | 'missing';
132:export type ContractEvidenceDistribution =
139:export interface ContractCoverageDefinition {
150:export interface ContractCoverageResult extends ContractCoverageDefinition {
159:export type ContractIssueType =
168:export interface ContractIssue {
179:export interface ContractSuppressedIssueTrace {
184:export interface ContractIssueAnchorSummary {
192:export interface ContractAnalysisTrace {
200:export interface ContractRateScheduleRow {
230:export type ContractDocumentShape =
238:export type ContractDomain =
242:export type AuthorizationState =
247:export interface ActivationGate {
253:export interface QuantityLevels {
259:export interface ContractFieldAnalysis {
274:export type ContractFieldAnalysisMap = Partial<Record<ContractFieldId, ContractFieldAnalysis>>;
276:export interface ContractAnalysisResult {
313:export interface EvidenceReference {
319:export interface OperationalDecision {
331:export interface GeneratedOperationalTask {
25:export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
11:export function useCurrentOrg() {
34:export function projectStatusFromValidationStatus(
42:export function buildValidatorContext(params: {
67:export async function loadValidatorContext(params: {
15:export function collectValueNeedles(value: unknown): string[] {
68:export function hasInspectableValue(value: unknown): boolean {
81:export function findEvidenceByValueMatch(
22:export function buildElementEvidence(params: {
6:export interface PdfEvidenceMapResult {
22:export function buildEvidenceMap(params: {
10:export interface SpreadsheetEvidenceResult {
190:export function buildSpreadsheetEvidence(params: {
8:export function dedupeSignalEvidence(items: EvidenceAnchor[]): EvidenceAnchor[] {
7:export type EvidenceSourceMethod = 'pdf_text' | 'ocr' | 'text';
9:export type PageTextEvidence = {
15:export type ContractStructuredFieldsV1 = {
26:export type ContractSectionSignalsV1 = {
47:export type DocumentEvidenceV1 = {
695:export function buildEvidenceV1(params: {
724:export function parseContractEvidenceV1(params: {
89:export type ApprovalGateOptions = {
251:export function evaluateApprovalGate(
26:export function normalizeRateCode(value: string | null | undefined): string | null {
31:export function normalizeRateDescription(value: string | null | undefined): string | null {
42:export function normalizeMaterial(value: string | null | undefined): string | null {
46:export function normalizeServiceItem(value: string | null | undefined): string | null {
50:export function normalizeSiteType(value: string | null | undefined): string | null {
54:export function normalizeDisposalSite(value: string | null | undefined): string | null {
59:export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
64:export function deriveDescriptionMatchKey(description: string | null | undefined): string | null {
68:export type BillingRateKeyInput = {
80:export function rateDescriptionProbablyCode(value: string | null | undefined): boolean {
94:export function deriveBillingRateKey(input: BillingRateKeyInput): string | null {
115:export type SiteMaterialKeyInput = {
122:export function deriveSiteMaterialKey(input: SiteMaterialKeyInput): string | null {
135:export function deriveInvoiceRateKey(
145:export type RateScheduleBillingSource = {
153:export function deriveBillingKeysForRateScheduleItem(
176:export type InvoiceLineBillingSource = {
183:export function deriveBillingKeysForInvoiceLine(
205:export type TransactionBillingSource = {
215:export function deriveBillingKeysForTransactionRecord(
240:export function billingRateKeyForScheduleItem(
246:export function billingRateKeyForInvoiceLine(
253:export function readServiceItemFromScheduleRow(row: Record<string, unknown>): string | null {
262:export type RateScheduleMatchable = RateScheduleBillingSource & {
275:export type InvoiceLineMatchable = InvoiceLineBillingSource & {
286:export type BillingScheduleIndex<T> = {
292:export function indexRateScheduleItemsByCanonicalKeys<T extends RateScheduleMatchable>(
349:export function findRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
356:export function selectBestRateScheduleItemForInvoiceLine<T extends RateScheduleMatchable>(
445:export type OperationalRateScheduleCandidateResult<T> = {
784:export function findOperationalRateScheduleCandidatesForInvoiceLine<T extends RateScheduleMatchable>(
806:export function matchRateScheduleItemForInvoiceLine<T extends RateScheduleMatchable>(
864:export type InvoiceGroupedTransactionMatchInput = {
870:export type TransactionRowMatchIndex<T> = {
884:export function matchTransactionRowsForInvoiceGroup<T extends TransactionRowInvoiceScope>(
116:export async function createFindingAction(
81:export async function createFindingDecision(
4:export type EvidenceReviewAction =
10:export type ValidationEvidenceTarget = {
127:export function buildEvidenceTarget(args: {
240:export function getEvidenceDocumentUrl(args: {
493:export function evaluateProjectExposure(
627:export function normalizeValidationFinding(
659:export function isBlockingFinding(finding: ValidationFinding): boolean {
663:export function isReviewFinding(finding: ValidationFinding): boolean {
672:export function blockerFindingCount(findings: readonly ValidationFinding[]): number {
676:export function warningFindingCount(findings: readonly ValidationFinding[]): number {
680:export function requiresReviewFindingCount(findings: readonly ValidationFinding[]): number {
684:export function infoFindingCount(findings: readonly ValidationFinding[]): number {
688:export function severityRankForFinding(
701:export function legacySeverityForFinding(
79:export function extractUuidPrefix(value: unknown): string | null {
93:export function buildEvidenceInserts(
740:export async function persistValidationRun(
6:export type PrimaryApprovalDecisionStatus =
11:export type PrimaryApprovalContext = 'project' | 'invoice';
13:export type PrimaryApprovalDecisionInput = {
27:export type ParsedPrimaryApprovalDecision = {
199:export function resolvePrimaryApprovalDecisions(
211:export function resolveProjectPrimaryApprovalDecision(
219:export function resolveInvoicePrimaryApprovalDecisions(
227:export function isPrimaryApprovalDecisionRow(
233:export function isProjectPrimaryApprovalDecisionRow(
240:export function primaryApprovalStatusToValidatorStatus(
254:export function primaryApprovalStatusToValidationStatus(
110:export const VALIDATOR_DOCUMENT_SELECT =
384:export function extractCanonicalContractFacts(
413:export function buildPersistedContractValidationContextFromTrace(
446:export function buildExcludedValidationDocumentIds(params: {
471:export function resolveValidationInvoiceScope<TInvoice extends StructuredRow, TLine extends StructuredRow>(params: {
508:export function buildPersistedContractValidationContextFromProjectSummary(
919:export function buildDocumentIdsByFamily(
1273:export function buildRateScheduleItems(params: {
1382:export function synthesizeInvoicesFromLegacyExtractions(params: {
1470:export function buildContractValidationContext(params: {
1957:export async function loadProjectValidatorInput(
2189:export async function validateProject(projectId: string): Promise<ValidatorResult> {
38:export type QueueFindingActionFinding = QueueFinding;
39:export type QueueFindingActionEvidence = QueueEvidence;
43:export const QUEUE_FINDING_RULE_IDS = [
536:export function buildValidatorFindingAction(params: {
573:export function buildValidatorFindingActionsByProjectId(params: {
3:export const MIN_CONFIDENT_CANONICAL_CATEGORY = 0.68;
5:export type CanonicalRateCategoryBasis =
12:export type CanonicalRateCategoryResolution = {
167:export function resolveCanonicalRateCategory(params: {
270:export function hasConfidentCanonicalRateCategory(
249:export function emptyValidatorTransactionRollups(): ValidatorTransactionRollups {
257:export function buildValidatorTransactionRollups(
419:export function buildValidatorReconciliationContext(
540:export function deriveContractInvoiceStatus(
563:export function deriveInvoiceTransactionStatus(
589:export function buildProjectReconciliationSummary(params: {
5:export async function requestDecisionStatusRevalidation(params: {
18:export async function requestDecisionFeedbackRevalidation(params: {
35:export async function requestFactOverrideRevalidation(params: {
43:export async function requestDocumentPrecedenceRevalidation(params: {
222:export type ContractInvoiceReconciliationResult = {
683:export function evaluateContractInvoiceReconciliation(
167:export type CrossDocumentRateVerificationResult = {
729:export function evaluateCrossDocumentRateVerification(
136:export function isRateCodeMissingInformational(params: {
262:export function runFinancialIntegrityRules(
107:export function runIdentityConsistencyRules(
182:export type InvoiceTransactionReconciliationResult = {
900:export function evaluateInvoiceTransactionReconciliation(
18:export const RATE_BASED_CONTRACT_VALIDATION_RULES = {
244:export function isGoverningContractFullyExecutedAndActive(input: ProjectValidatorInput): boolean {
285:export function runRateBasedContractValidationRules(
11:export function runRequiredSourcesRules(
107:export function runTicketIntegrityRules(
64:export const validationFindingSchema: z.ZodType<ValidationFinding> = z
110:export const validatorSummaryItemSchema: z.ZodType<ValidatorSummaryItem> = z.object({
129:export const contractInvoiceReconciliationSummarySchema: z.ZodType<ContractInvoiceReconciliationSummary> =
140:export const invoiceTransactionReconciliationSummarySchema: z.ZodType<InvoiceTransactionReconciliationSummary> =
150:export const projectReconciliationSummarySchema: z.ZodType<ProjectReconciliationSummary> =
188:export const crossDocumentRateVerificationSummarySchema: z.ZodType<CrossDocumentRateVerificationSummary> =
232:export const invoiceExposureSummarySchema: z.ZodType<InvoiceExposureSummary> = z.object({
246:export const projectExposureSummarySchema: z.ZodType<ProjectExposureSummary> = z.object({
260:export const validationSummarySchema: z.ZodType<ValidationSummary> = z.object({
47:export const PURE_VALIDATOR_RUN_ID = 'pure-validator';
48:export const PURE_VALIDATOR_TIMESTAMP = '1970-01-01T00:00:00.000Z';
50:export type ValidatorProjectRow = {
60:export type ValidatorDocumentRow = {
74:export type ValidatorExtractionFactRow = {
86:export type ValidatorLegacyExtractionRow = {
92:export type StructuredRow = Record<string, unknown>;
93:export type MobileTicketRow = StructuredRow;
94:export type LoadTicketRow = StructuredRow;
95:export type InvoiceRow = StructuredRow;
96:export type InvoiceLineRow = StructuredRow;
98:export type ValidatorDocumentIdsByFamily = {
106:export type ValidatorTruthCategoryDocumentIds = {
113:export type ValidatorFactSource =
122:export type ValidatorFactRecord = {
132:export type ValidatorEvidenceResult = ValidationEvidence;
135:export type RateScheduleItem = {
159:export type ProjectTotals = {
167:export type ValidatorTransactionDataDataset = {
180:export type ValidatorTransactionDataRow = {
201:export type ValidatorProjectTransactionData = {
207:export type ValidatorTransactionRollups = {
213:export type ValidatorContractReconciliationSource = {
219:export type ValidatorInvoiceReconciliationSource = {
224:export type ValidatorTransactionReconciliationSource = {
230:export type ValidatorBillingGroup = {
244:export type ValidatorReconciliationContext = {
251:export type ValidatorContractAnalysisContext = {
262:export type ValidatorFactLookups = {
289:export type ProjectValidatorInput = {
314:export type FindingEvidenceInput = {
325:export type ValidatorFindingResult = ValidationFinding & {
366:export function stringifyValue(value: unknown): string | null {
382:export function toNumber(value: unknown): number | null {
401:export function toBoolean(value: unknown): boolean | null {
419:export function normalizeCode(value: string | null | undefined): string | null {
430:export function normalizePartyName(value: string | null | undefined): string | null {
451:export function normalizeVendorName(value: string | null | undefined): string | null {
463:export function partiesClearlyDifferent(
492:export function uniqueStrings(values: Array<string | null | undefined>): string[] {
502:export function readRowValue(
513:export function readRowString(
530:export function readRowNumber(
537:export function collectRowIdentityKeys(
554:export function rowIdentifier(
564:export function findFactRecords(
584:export function findFirstFactRecord(
592:export function findFirstStringFact(
605:export function findFirstNumberFact(
618:export function isRuleEnabled(
630:export function resolveRuleTolerance(
653:export function makeEvidenceInput(params: FindingEvidenceInput): FindingEvidenceInput {
657:export function structuredRowEvidenceInput(params: {
677:export function makeFinding(params: {
766:export function blockingReasons(findings: readonly ValidationFinding[]): string[] {
774:export function hasBlockingFindings(findings: readonly ValidationFinding[]): boolean {
778:export function sortFindings<T extends ValidationFinding>(findings: readonly T[]): T[] {
922:export function messageForFinding(finding: ValidationFinding): string {
946:export function factKeysForFinding(finding: ValidationFinding): string[] {
953:export function toValidatorSummaryItem(
1096:export function deriveValidatorStatus(
1109:export function buildValidationSummary(
1256:export function normalizeLooseText(value: string | null | undefined): string | null {
189:export function buildValidationInputsSnapshotHash(params: {
265:export function buildDocumentPrecedenceSnapshotFingerprint(
422:export type TriggerProjectValidationResult =
437:export type TriggerProjectValidationOptions = {
441:export function shouldSkipUnchangedValidationInputs(params: {
573:export async function triggerProjectValidation(
45:export type ValidatorDecisionRecord = {
58:export type SyncValidatorDecisionsResult = {
798:export function buildValidatorDecisionRecords(params: {
1072:export async function syncValidatorDecisions(params: {
8:export type FindingRoutingEvaluation = {
14:export function evaluateFindingRouting(
$ exported Row/Fact/RateSchedule/Evidence/Validation/Decision types
lib/blobExtractionSelection.ts:1:export type BlobExtractionRow = {
lib/ask\canonicalReadGuard.ts:18:export type GuardedEvidenceItem = {
lib/decisionContext.ts:15:export type DecisionProjectValidationContext = {
lib/decisionContext.ts:20:export type DecisionContextRow = {
lib/decisionContext.ts:32:export type DecisionInvoiceStripItem = {
lib/decisionContext.ts:38:export type DecisionCausalChainStepState =
lib/decisionContext.ts:44:export type DecisionCausalChainStep = {
lib/decisionContext.ts:53:export type DecisionQueueFindingActionContext = {
lib/decisionContext.ts:62:export type DecisionWorkflowExecutionStatus =
lib/decisionContext.ts:67:export type DecisionWorkflowExecutionLogEntry = {
lib/contracts\contractPricingAssembly.ts:22:export type ContractPricingAssemblyRow = {
lib/decisionDetail.ts:8:export type DecisionDetailDocumentRef = {
lib/decisionDetail.ts:16:export type DecisionDetailTask = {
lib/decisionDetail.ts:32:export type DecisionDetailFeedback = {
lib/decisionDetail.ts:44:export type DecisionTone = 'brand' | 'success' | 'warning' | 'danger' | 'muted';
lib/decisionDetail.ts:46:export type DecisionExecutiveSummary = {
lib/decisionDetail.ts:54:export type DecisionEvidenceMetric = {
lib/decisionDetail.ts:63:export type DecisionEvidenceReference = {
lib/decisionDetail.ts:69:export type DecisionEvidenceTarget = {
lib/decisionDetail.ts:78:export type DecisionEvidenceNote = {
lib/decisionDetail.ts:84:export type DecisionEvidencePayload = {
lib/decisionDetail.ts:93:export type DecisionProcessStepState = 'complete' | 'current' | 'upcoming' | 'attention';
lib/decisionDetail.ts:95:export type DecisionProcessStep = {
lib/decisionDetail.ts:102:export type DecisionProcessState = {
lib/decisionDetail.ts:108:export type DecisionMetricCard = {
lib/ask\globalCommand.ts:12:export type AskEvidenceLink = {
lib/contracts\types.ts:132:export type ContractEvidenceDistribution =
lib/contracts\types.ts:200:export interface ContractRateScheduleRow {
lib/contracts\types.ts:313:export interface EvidenceReference {
lib/contracts\types.ts:319:export interface OperationalDecision {
lib/decisionToWorkflow.ts:43:export type DecisionWorkflowInput = {
lib/decisionToWorkflow.ts:56:export type DecisionWorkflowOutput = {
lib/documentFactOverrides.ts:1:export type DocumentFactOverrideActionType = 'add' | 'correct';
lib/documentFactOverrides.ts:3:export type DocumentFactDisplaySource =
lib/documentFactOverrides.ts:8:export type DocumentFactOverrideRow = {
lib/documentFactOverrides.ts:23:export type DocumentFactOverrideRecord = {
lib/ask\portfolioHandoffContext.ts:1:export type ValidationStateLabel =
lib/documentFactAnchors.ts:1:export type DocumentFactAnchorType =
lib/documentFactAnchors.ts:9:export type RateScheduleAnchorType = 'page_range' | 'table_region';
lib/documentFactAnchors.ts:11:export type DocumentFactAnchorRect = {
lib/documentFactAnchors.ts:20:export type DocumentFactAnchorRow = {
lib/documentFactAnchors.ts:39:export type DocumentFactAnchorRecord = {
lib/documentFactReviews.ts:1:export type DocumentFactReviewStatus =
lib/documentFactReviews.ts:7:export type DocumentFactReviewRow = {
lib/documentFactReviews.ts:19:export type DocumentFactReviewRecord = {
lib/ask\queryTemplates.ts:3:export type AskFactKey =
lib/documentIntelligenceViewModel.ts:76:export type DocumentFactState =
lib/documentIntelligenceViewModel.ts:84:export type DocumentFactValueType =
lib/documentIntelligenceViewModel.ts:96:export type EvidenceGeometry = {
lib/documentIntelligenceViewModel.ts:108:export type DocumentEvidenceAnchor = {
lib/documentIntelligenceViewModel.ts:136:export type DocumentFactOverrideHistoryItem = {
lib/documentIntelligenceViewModel.ts:151:export type DocumentFactReviewSummary = {
lib/documentIntelligenceViewModel.ts:158:export type DocumentFactReviewHistoryItem = {
lib/documentIntelligenceViewModel.ts:169:export type DocumentFact = {
lib/documentIntelligenceViewModel.ts:222:export type DocumentFactGroup = {
lib/documentIntelligenceViewModel.ts:287:export type SpreadsheetReviewRateCodeRow = {
lib/documentIntelligenceViewModel.ts:294:export type SpreadsheetReviewFlowRow = {
lib/documentIntelligenceViewModel.ts:305:export type SpreadsheetReviewServiceItemRow = {
lib/documentIntelligenceViewModel.ts:324:export type SpreadsheetReviewRiskIssueRow = {
lib/documentIntelligenceViewModel.ts:335:export type SpreadsheetReviewRiskDrilldownRow = {
lib/documentIntelligenceViewModel.ts:372:export type DocumentContractRateRow = {
lib/documentIntelligenceViewModel.ts:4925:export type InvoiceLedgerLineDisplayRow = {
lib/ask\types.ts:48:export type ValidationStateLabel =
lib/ask\types.ts:89:export interface StructuredFact {
lib/ask\types.ts:157:export interface DecisionRecord {
lib/ask\types.ts:240:export interface EvidenceChain {
lib/documentWorkspace.ts:46:export type DocumentWorkspaceDocRow = {
lib/documentWorkspace.ts:64:export type DocumentWorkspaceReviewRow = {
lib/documentWorkspace.ts:70:export type DocumentWorkspaceDecisionRow = {
lib/documentWorkspace.ts:80:export type DocumentWorkspaceTaskRow = {
lib/effectiveFacts.ts:1:export type EffectiveFactSource =
lib/effectiveFacts.ts:12:export type EffectiveFactRecord = {
lib/executionItems.ts:15:export type ProjectExecutionItemRow = {
lib/forgeDecisionGenerator.ts:82:export type ForgeDecisionSeverity = 'critical' | 'review' | 'check';
lib/forgeDecisionGenerator.ts:84:export type ForgeDecisionAnchor = {
lib/forgeDecisionGenerator.ts:90:export type ForgeDecisionFact = {
lib/forgeDecisionGenerator.ts:113:export type ForgeGeneratedDecision = {
lib/forgeDecisionGenerator.ts:126:export type ForgeDecisionGeneratorInput = {
lib/forgeDecisionGenerator.ts:137:export type ForgeDecisionDocumentInput = {
lib/extraction\types.ts:17:export interface EvidenceLocation {
lib/extraction\types.ts:30:export type EvidenceValue = string | number | boolean | null;
lib/extraction\types.ts:33:export interface EvidenceSourceMetadata {
lib/extraction\types.ts:40:export interface EvidenceObject {
lib/extraction\pdf\buildEvidenceMap.ts:6:export interface PdfEvidenceMapResult {
lib/extraction\xlsx\buildSpreadsheetEvidence.ts:10:export interface SpreadsheetEvidenceResult {
lib/extraction\xlsx\normalizeTicketExport.ts:16:export interface NormalizedTicketRow {
lib/issueObjects.ts:20:export type EvidenceSourceType = 'contract' | 'invoice' | 'amendment' | 'fema_doc' | 'other';
lib/issueObjects.ts:22:export interface EvidenceTarget {
lib/extraction\pdf\extractTables.ts:13:export interface PdfTableRow {
lib/extraction\xlsx\parseWorkbook.ts:6:export interface WorkbookRow {
lib/projectDecisionResolution.ts:1:export type ProjectDecisionResolutionAction =
lib/projectFacts.ts:78:export type CanonicalProjectFacts = {
lib/projectFacts.ts:131:export type CanonicalProjectValidationSnapshot = {
lib/projectFacts.ts:145:export type CanonicalProjectTruthRow = {
lib/projectFacts.ts:221:export type CanonicalProjectDecisionInput = PrimaryApprovalDecisionInput;
lib/projectFacts.ts:233:export type CanonicalProjectTransactionRowInput = {
lib/operationalTables\canonicalOperationalRateDiff.ts:28:export type CanonicalOperationalRateDiffRow = {
lib/operationalTables\adapters\contractRateScheduleFragmentAdapter.ts:4:export type ContractRateScheduleSourceFamily = 'contract' | 'price_sheet';
lib/operationalTables\adapters\contractRateScheduleFragmentAdapter.ts:6:export type ContractRateScheduleKind =
lib/operationalTables\adapters\contractRateScheduleFragmentAdapter.ts:12:export type ContractRateScheduleFragmentAdapterInput = {
```
## 5. DATA MODEL
```
20250311000000_add_workflow_trigger_rules.sql
20250312000000_add_assignment_fields.sql
20250313000000_add_activity_events.sql
20250314_verification_checklist.sql
20250314000000_deterministic_decision_backbone.sql
20250314000001_seed_debris_ops.sql
20250316000000_add_rls_document_extractions_rules_signals.sql
20250316000001_fix_user_profiles_rls_recursion.sql
20250316000002_stuck_document_detection.sql
20250317000000_projects_unique_code.sql
20260318000000_document_reviews.sql
20260319000000_document_intelligence_trace_and_review_error_type.sql
20260323000000_document_precedence.sql
20260328000000_document_fact_overrides.sql
20260328000001_document_fact_anchors.sql
20260328000002_rate_schedule_anchor_extensions.sql
20260328000003_document_fact_reviews.sql
20260329000000_add_project_id_to_decisions_and_tasks.sql
20260329010000_project_admin_controls.sql
20260330000000_add_role_to_user_profiles.sql
20260330000001_fix_decisions_source_check.sql
20260401000000_project_validator_phase0_schema.sql
20260401010000_project_validator_activity_events.sql
20260404000000_transaction_data_project_persistence.sql
20260407_approval_action_log.sql
20260407_workflow_task_resolution.sql
20260417000000_align_transaction_data_schema_to_code_contract.sql
20260422000000_truth_mutation_activity_events.sql
20260429000000_validation_request_activity_events.sql
20260430000000_document_truth_governance_phase.sql
20260506000000_execution_items.sql
20260506001000_execution_item_activity_events.sql
20260506002000_execution_item_override_suppression.sql
20260602000000_allow_project_validator_decision_source.sql
20260602001000_create_approval_snapshots.sql
$ migration DDL heads
4:create table if not exists public.workflow_trigger_rules (
24:create table if not exists public.activity_events (
52:create policy activity_events_select_org
5:-- Safety: Uses ALTER TABLE ADD COLUMN IF NOT EXISTS for existing tables,
6:--         CREATE TABLE IF NOT EXISTS for new tables. No destructive changes.
104:CREATE TABLE IF NOT EXISTS public.document_fields (
124:CREATE TABLE IF NOT EXISTS public.rules (
348:CREATE TABLE IF NOT EXISTS public.signals (
500:    CREATE POLICY document_fields_select_authenticated
513:    CREATE POLICY rules_select_org
532:    CREATE POLICY signals_select_org
18:CREATE POLICY "document_extractions_select_org"
38:CREATE POLICY "document_extractions_insert_org"
48:CREATE POLICY "document_extractions_update_org"
74:CREATE POLICY "rules_select_org"
85:CREATE POLICY "rules_insert_org"
95:CREATE POLICY "rules_update_org"
113:CREATE POLICY "rules_delete_org"
129:CREATE POLICY "signals_select_org"
139:CREATE POLICY "signals_insert_org"
149:CREATE POLICY "signals_update_org"
167:CREATE POLICY "signals_delete_org"
182:CREATE POLICY "decisions_delete_org"
192:CREATE POLICY "workflow_tasks_delete_org"
34:CREATE POLICY "user_profiles_select_org"
9:CREATE TABLE IF NOT EXISTS public.document_reviews (
47:    CREATE POLICY document_reviews_select_authenticated
65:    CREATE POLICY document_reviews_write_authenticated
76:    CREATE POLICY document_reviews_update_authenticated
82:CREATE TABLE IF NOT EXISTS public.document_relationships (
149:    CREATE POLICY document_relationships_select_authenticated
166:    CREATE POLICY document_relationships_insert_authenticated
183:    CREATE POLICY document_relationships_update_authenticated
8:CREATE TABLE IF NOT EXISTS public.document_fact_overrides (
54:    CREATE POLICY document_fact_overrides_select_authenticated
71:    CREATE POLICY document_fact_overrides_insert_authenticated
88:    CREATE POLICY document_fact_overrides_update_authenticated
8:CREATE TABLE IF NOT EXISTS public.document_fact_anchors (
66:    CREATE POLICY document_fact_anchors_select_authenticated
83:    CREATE POLICY document_fact_anchors_insert_authenticated
100:    CREATE POLICY document_fact_anchors_update_authenticated
8:CREATE TABLE IF NOT EXISTS public.document_fact_reviews (
47:    CREATE POLICY document_fact_reviews_select_authenticated
64:    CREATE POLICY document_fact_reviews_insert_authenticated
9:CREATE TABLE IF NOT EXISTS public.project_validation_runs (
28:CREATE TABLE IF NOT EXISTS public.project_validation_findings (
55:CREATE TABLE IF NOT EXISTS public.project_validation_evidence (
69:CREATE TABLE IF NOT EXISTS public.project_validation_rule_state (
240:    CREATE POLICY project_validation_runs_select_authenticated
260:    CREATE POLICY project_validation_runs_insert_authenticated
280:    CREATE POLICY project_validation_runs_update_authenticated
308:    CREATE POLICY project_validation_findings_select_authenticated
328:    CREATE POLICY project_validation_findings_insert_authenticated
348:    CREATE POLICY project_validation_findings_update_authenticated
376:    CREATE POLICY project_validation_evidence_select_authenticated
397:    CREATE POLICY project_validation_evidence_insert_authenticated
418:    CREATE POLICY project_validation_rule_state_select_authenticated
438:    CREATE POLICY project_validation_rule_state_insert_authenticated
458:    CREATE POLICY project_validation_rule_state_update_authenticated
9:CREATE TABLE IF NOT EXISTS public.transaction_data_datasets (
22:CREATE TABLE IF NOT EXISTS public.transaction_data_rows (
92:    CREATE POLICY transaction_data_datasets_select_authenticated
112:    CREATE POLICY transaction_data_rows_select_authenticated
10:CREATE TABLE IF NOT EXISTS public.approval_action_log (
56:CREATE POLICY "approval_action_log_select_own_org"
15:CREATE TABLE IF NOT EXISTS public.transaction_data_datasets (
126:CREATE TABLE IF NOT EXISTS public.transaction_data_rows (
309:    CREATE POLICY transaction_data_datasets_select_authenticated
329:    CREATE POLICY transaction_data_rows_select_authenticated
10:CREATE TABLE IF NOT EXISTS public.execution_items (
118:    CREATE POLICY execution_items_select_authenticated
138:    CREATE POLICY execution_items_insert_authenticated
158:    CREATE POLICY execution_items_update_authenticated
5:CREATE TABLE IF NOT EXISTS public.project_approval_snapshots (
31:CREATE TABLE IF NOT EXISTS public.invoice_approval_snapshots (
68:CREATE POLICY project_approval_snapshots_select_authenticated
83:CREATE POLICY invoice_approval_snapshots_select_authenticated
$ generated table/Row type names
MISSING: lib/database.types.ts
MISSING: types/supabase.ts
MISSING: types/database.types.ts
```
## 6. TRUTH-FLOW TOUCHPOINTS (Source → Facts → Validation → UI → Execution)
```
$ Persistence of canonical facts
lib\ask\portfolioAnswerBuilder.test.ts:86:              validation_summary_json: null,
lib\ask\portfolioAnswerBuilder.ts:268:      validation_summary: item.project.validation_summary_json,
supabase\migrations\20260319000000_document_intelligence_trace_and_review_error_type.sql:9:  ADD COLUMN IF NOT EXISTS intelligence_trace jsonb;
lib\ask\portfolioProjectStatusAggregate.ts:1:import { resolveCanonicalProjectFacts } from '@/lib/projectFacts';
lib\ask\retrieval.ts:5:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\ask\sqlGuardrails.ts:50:        filters: [`documents.id = ${scopedId}`, 'intelligence_trace extraction_gaps and missing_source_context only'],
lib\ask\sqlGuardrails.ts:51:        query_plan: 'documents.intelligence_trace gaps for one document',
lib\ask\sqlGuardrails.ts:69:        query_plan: 'documents.intelligence_trace fact lookup with cited evidence only',
lib\ask\validatorIntegration.ts:3:import { resolveCanonicalProjectFacts } from '@/lib/projectFacts';
lib\ask\validatorIntegration.ts:11:  validation_summary_json: unknown;
lib\ask\validatorIntegration.ts:79:        .select('id, name, validation_status, validation_summary_json')
lib\ask\validatorIntegration.ts:91:        validationSummary: row.validation_summary_json,
lib\ask\selectors\projectApprovalExecutionState.ts:8:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\ask\selectors\projectContractAuthority.ts:8:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\ask\selectors\projectInvoiceSupport.ts:7:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
supabase\migrations\20260401000000_project_validator_phase0_schema.sql:82:  ADD COLUMN IF NOT EXISTS validation_summary_json jsonb;
lib\ask\selectors\projectReviewAuditState.ts:8:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\ask\selectors\projectTicketValidation.ts:8:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\documentWorkspace.test.ts:32:    intelligence_trace: {
lib\documentWorkspace.test.ts:76:    intelligence_trace: {
lib\ask\portfolioStalenessCheck.ts:15:    const validationSummary = item.project.validation_summary_json;
lib\decisionContext.ts:7:import { resolveCanonicalProjectValidationSnapshot } from '@/lib/projectFacts';
lib\documentIntelligenceViewModel.ts:35:} from '@/lib/projectFacts';
lib\documentIntelligenceViewModel.ts:1666:  const projectFacts = resolveCanonicalProjectFacts({
lib\documentIntelligenceViewModel.ts:1671:  const projectBlockedReasons = projectFacts.blocked_reasons;
lib\documentIntelligenceViewModel.ts:1673:    projectFacts.total_billed
lib\documentIntelligenceViewModel.ts:1674:    ?? projectFacts.exposure_total_billed;
lib\documentIntelligenceViewModel.ts:1675:  const projectTotalInvoices = projectFacts.exposure?.invoices.length ?? null;
lib\documentIntelligenceViewModel.ts:1678:    facts: projectFacts,
lib\documentIntelligenceViewModel.ts:5823:      ? toDocumentContractRateRows(params.executionTrace?.contract_analysis?.rate_schedule_rows)
lib\documentIntelligenceViewModel.ts:5827:      ? assembleContractPricingRows(params.executionTrace?.contract_analysis?.rate_schedule_rows, {
lib\documentIntelligenceViewModel.test.ts:1873:          rate_schedule_rows: [
lib\contracts\types.ts:291:  rate_schedule_rows?: ContractRateScheduleRow[];
lib\projectFacts.test.ts:16:} from '@/lib/projectFacts';
lib\projectFacts.test.ts:882:          intelligence_trace: {
lib\projectFacts.test.ts:956:          intelligence_trace: {
lib\projectFacts.test.ts:1002:          intelligence_trace: {
lib\projectFacts.test.ts:1078:          intelligence_trace: {
lib\projectFacts.test.ts:1097:          intelligence_trace: {
lib\projectFacts.test.ts:1175:          intelligence_trace: {
lib\projectFacts.test.ts:1190:          intelligence_trace: {
lib\projectFacts.test.ts:1378:        intelligence_trace: {
lib\projectFacts.test.ts:1388:        intelligence_trace: {
lib\projectFacts.test.ts:1403:        intelligence_trace: {
lib\projectFacts.test.ts:1513:          intelligence_trace: {
lib\projectFacts.test.ts:1532:          intelligence_trace: {
lib\projectFacts.test.ts:1763:          intelligence_trace: {
lib\projectFacts.test.ts:1784:          intelligence_trace: {
lib\projectFacts.test.ts:1860:          intelligence_trace: {
lib\projectFacts.test.ts:1880:          intelligence_trace: {
lib\projectFacts.test.ts:1955:          intelligence_trace: {
lib\projectFacts.test.ts:1969:          intelligence_trace: {
lib\projectFacts.ts:208:  intelligence_trace?: unknown;
lib\projectFacts.ts:1575:  return asRecord(document?.intelligence_trace);
lib\contracts\contractIntelligence.test.ts:274:    assert.equal(analysis.rate_schedule_rows?.length, 2);
lib\contracts\contractIntelligence.test.ts:275:    assert.equal(analysis.rate_schedule_rows?.[0]?.category, 'Vegetative');
lib\contracts\contractIntelligence.test.ts:276:    assert.equal(analysis.rate_schedule_rows?.[0]?.unit, 'per cubic yard');
lib\contracts\contractIntelligence.test.ts:277:    assert.equal(analysis.rate_schedule_rows?.[0]?.rate, 6.9);
lib\contracts\contractIntelligence.test.ts:278:    assert.equal(analysis.rate_schedule_rows?.[0]?.page, 2);
lib\contracts\contractIntelligence.test.ts:279:    assert.ok((analysis.rate_schedule_rows?.[0]?.source_anchor_ids.length ?? 0) > 0);
lib\pipeline\processDocument.test.ts:358:        canonical_persistence_error: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
lib\pipeline\processDocument.test.ts:373:      error: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
lib\pipeline\processDocument.test.ts:380:        errorMessage: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
lib\pipeline\processDocument.test.ts:388:        processingError: 'Execution trace persistence failed for spreadsheet-doc: documents.intelligence_trace update timed out',
lib\contracts\analyzeContractIntelligence.ts:1045:    rate_schedule_rows: rateScheduleRows,
lib\documentWorkspace.ts:57:  intelligence_trace: DocumentExecutionTrace | Record<string, unknown> | null;
lib\documentWorkspace.ts:347:    const trace = parseDocumentTrace(document.intelligence_trace);
app\api\documents\[id]\route.ts:23:  'id, title, name, document_type, document_subtype, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain, intelligence_trace';
app\api\documents\[id]\route.ts:25:  'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain, intelligence_trace';
lib\operationsQuery\askOperationsChips.test.ts:68:          validation_summary_json: {
lib\operationsQuery\executeOperationsQuery.test.ts:31:      validation_summary_json: null,
app\api\ask\document\route.ts:28:  intelligence_trace?: DocumentExecutionTrace | Record<string, unknown> | null;
app\api\ask\document\route.ts:71:function parseTrace(value: DocumentRow['intelligence_trace']): DocumentExecutionTrace | null {
app\api\ask\document\route.ts:268:      .select('id, title, name, document_type, processing_status, project_id, intelligence_trace')
app\api\ask\document\route.ts:307:  const trace = parseTrace(document.intelligence_trace ?? null);
components\projects\ValidatorTab.tsx:19:} from '@/lib/projectFacts';
components\projects\ValidatorTab.tsx:51:  validation_summary_json: unknown;
components\projects\ValidatorTab.tsx:865:          .select('validation_status, validation_summary_json')
components\projects\ValidatorTab.tsx:894:        validation_summary_json: null,
components\projects\ValidatorTab.tsx:906:        validatorProject.validation_summary_json,
components\projects\ProjectOverview.tsx:32:} from '@/lib/projectFacts';
components\projects\ProjectOverview.tsx:1395:    intelligence_trace: document.intelligence_trace ?? null,
components\projects\ProjectOverview.tsx:1399:    validationSummary: model.project.validation_summary_json,
components\projects\ProjectOverview.tsx:1408:    validationSummary: model.project.validation_summary_json,
components\projects\ProjectFactsForge.tsx:18:} from '@/lib/projectFacts';
app\api\ask\project\route.ts:15:  validation_summary_json: unknown;
app\api\ask\project\route.ts:72:    .select('id, name, validation_status, validation_summary_json')
app\api\ask\project\route.ts:94:      validationSummary: project.validation_summary_json,
app\api\ask\project\route.ts:105:      validationSummary: project.validation_summary_json,
lib\validator\triggerProjectValidation.ts:116:  intelligence_trace?: unknown;
lib\validator\triggerProjectValidation.ts:146:  const trace = asRecord(document.intelligence_trace);
lib\validator\triggerProjectValidation.ts:157:  const rows = Array.isArray(contractAnalysis.rate_schedule_rows)
lib\validator\triggerProjectValidation.ts:158:    ? contractAnalysis.rate_schedule_rows
lib\validator\triggerProjectValidation.ts:184:      rate_schedule_rows: rows,
lib\validator\triggerProjectValidation.ts:218:    .select('id, processed_at, intelligence_trace')
lib\validator\triggerProjectValidation.ts:228:    intelligence_trace: row.intelligence_trace ?? null,
lib\validator\triggerProjectValidation.test.ts:20:          intelligence_trace: {
lib\validator\triggerProjectValidation.test.ts:25:              rate_schedule_rows: [
lib\validator\triggerProjectValidation.test.ts:50:          intelligence_trace: {
lib\validator\triggerProjectValidation.test.ts:55:              rate_schedule_rows: [
$ Validator reads/writes
lib/contracts\analyzeContractIntelligence.ts:1045:    rate_schedule_rows: rateScheduleRows,
lib/contracts\contractIntelligence.test.ts:274:    assert.equal(analysis.rate_schedule_rows?.length, 2);
lib/contracts\contractIntelligence.test.ts:275:    assert.equal(analysis.rate_schedule_rows?.[0]?.category, 'Vegetative');
lib/contracts\contractIntelligence.test.ts:276:    assert.equal(analysis.rate_schedule_rows?.[0]?.unit, 'per cubic yard');
lib/contracts\contractIntelligence.test.ts:277:    assert.equal(analysis.rate_schedule_rows?.[0]?.rate, 6.9);
lib/contracts\contractIntelligence.test.ts:278:    assert.equal(analysis.rate_schedule_rows?.[0]?.page, 2);
lib/contracts\contractIntelligence.test.ts:279:    assert.ok((analysis.rate_schedule_rows?.[0]?.source_anchor_ids.length ?? 0) > 0);
lib/contracts\types.ts:291:  rate_schedule_rows?: ContractRateScheduleRow[];
lib/documentIntelligenceViewModel.test.ts:1872:        contract_analysis: {
lib/documentIntelligenceViewModel.test.ts:1873:          rate_schedule_rows: [
lib/documentIntelligenceViewModel.ts:5823:      ? toDocumentContractRateRows(params.executionTrace?.contract_analysis?.rate_schedule_rows)
lib/documentIntelligenceViewModel.ts:5827:      ? assembleContractPricingRows(params.executionTrace?.contract_analysis?.rate_schedule_rows, {
lib/projectFacts.test.ts:80:        contract_validation_context: {
lib/projectFacts.test.ts:392:        contract_validation_context: {
lib/projectFacts.test.ts:863:        contract_validation_context: {
lib/projectFacts.test.ts:886:            contract_analysis: {
lib/projectFacts.test.ts:961:            contract_analysis: {
lib/projectFacts.test.ts:1294:      contract_validation_context: {
lib/projectFacts.test.ts:1582:        contract_validation_context: {
lib/projectFacts.test.ts:1924:        contract_validation_context: {
lib/projectFacts.ts:1064:      : raw?.contract_validation_context && isRecord(raw.contract_validation_context)
lib/projectFacts.ts:1065:        ? raw.contract_validation_context
lib/projectFacts.ts:1593:  const analysis = asRecord(readDocumentTrace(document)?.contract_analysis);
lib/projectFacts.ts:1667:  return asRecord(raw.contractValidationContext) ?? asRecord(raw.contract_validation_context);
lib/types\documentIntelligence.ts:250:  contract_analysis?: ContractAnalysisResult | null;
lib/validator\persistValidationRun.ts:669:      (params.result.summary.contract_validation_context as never) ?? null,
lib/validator\projectValidator.contractTrace.test.ts:33:  rate_schedule_rows: [
lib/validator\projectValidator.contractTrace.test.ts:78:        contract_analysis: CONTRACT_ANALYSIS,
lib/validator\projectValidator.contractTrace.test.ts:106:    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.rate, 6.9);
lib/validator\projectValidator.contractTrace.test.ts:107:    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.page, 7);
lib/validator\projectValidator.ts:421:  const analysis = asRecord(trace.contract_analysis);
lib/validator\projectValidator.ts:513:    asRecord(summary?.contract_validation_context)
lib/validator\projectValidator.ts:1297:  const persistedRateRows = params.contractValidationContext?.analysis.rate_schedule_rows ?? [];
lib/validator\projectValidator.inputLoading.test.ts:26:      contract_validation_context: {
lib/validator\projectValidator.inputLoading.test.ts:34:          rate_schedule_rows: [
lib/validator\projectValidator.inputLoading.test.ts:50:    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.rate, 6.9);
lib/validator\projectValidator.inputLoading.test.ts:56:        contract_validation_context: {
lib/validator\projectValidator.inputLoading.test.ts:62:            rate_schedule_rows: [
lib/validator\projectValidator.inputLoading.test.ts:85:            contract_analysis: {
lib/validator\projectValidator.inputLoading.test.ts:89:              rate_schedule_rows: [
lib/validator\shared.test.ts:107:    assert.deepEqual(summary.contract_validation_context, {
lib/validator\shared.ts:1223:    contract_validation_context: options.contractValidationContext
lib/validator\triggerProjectValidation.test.ts:21:            contract_analysis: {
lib/validator\triggerProjectValidation.test.ts:25:              rate_schedule_rows: [
lib/validator\triggerProjectValidation.test.ts:51:            contract_analysis: {
lib/validator\triggerProjectValidation.test.ts:55:              rate_schedule_rows: [
lib/validator\triggerProjectValidation.ts:147:  const contractAnalysis = asRecord(trace?.contract_analysis);
lib/validator\triggerProjectValidation.ts:152:      contract_analysis: null,
lib/validator\triggerProjectValidation.ts:157:  const rows = Array.isArray(contractAnalysis.rate_schedule_rows)
lib/validator\triggerProjectValidation.ts:158:    ? contractAnalysis.rate_schedule_rows
lib/validator\triggerProjectValidation.ts:182:    contract_analysis: {
lib/validator\triggerProjectValidation.ts:184:      rate_schedule_rows: rows,
lib/server\intelligenceAdapter.contractRateRows.test.ts:26:  rate_schedule_rows: [
lib/server\intelligenceAdapter.contractRateRows.test.ts:96:    assert.ok(Array.isArray(governingRateTables.rate_schedule_rows));
lib/server\intelligenceAdapter.ts:186:  const rateScheduleRows = Array.isArray(contractAnalysis.rate_schedule_rows)
lib/server\intelligenceAdapter.ts:187:    ? contractAnalysis.rate_schedule_rows
lib/server\intelligenceAdapter.ts:221:            rate_schedule_rows: rateScheduleRows,
lib/server\intelligenceAdapter.ts:384:    contract_analysis: contractAnalysis,
$ Evidence anchoring
components\validator\ValidatorEvidenceDrawer.tsx:4:import { EvidenceInspector } from '@/components/evidence/EvidenceInspector';
components\validator\ValidatorEvidenceDrawer.tsx:5:import { buildValidatorEvidenceInspectorModel } from '@/components/evidence/evidenceInspectorModel';
components\validator\ValidatorEvidenceDrawer.tsx:20:} from '@/lib/validator/evidenceNavigation';
components\validator\ValidatorEvidenceDrawer.tsx:30:  evidence: ValidationEvidence[];
components\validator\ValidatorEvidenceDrawer.tsx:66:    item.evidence_type === 'document'
components\validator\ValidatorEvidenceDrawer.tsx:67:    || item.evidence_type === 'fact'
components\validator\ValidatorEvidenceDrawer.tsx:68:    || item.evidence_type === 'rate_schedule'
components\validator\ValidatorEvidenceDrawer.tsx:124:function evidenceFieldValue(
components\validator\ValidatorEvidenceDrawer.tsx:125:  evidence: readonly ValidationEvidence[],
components\validator\ValidatorEvidenceDrawer.tsx:129:    const match = evidence.find((entry) => entry.field_name === fieldName);
components\validator\ValidatorEvidenceDrawer.tsx:137:function sourceTraceLabel(finding: ValidationFinding, evidence: readonly ValidationEvidence[]): string {
components\validator\ValidatorEvidenceDrawer.tsx:138:  const invoiceNumber = evidenceFieldValue(evidence, ['invoice_number', 'invoice_no', 'number']);
components\validator\ValidatorEvidenceDrawer.tsx:139:  const rateCode = evidenceFieldValue(evidence, ['rate_code', 'line_code', 'item_code']);
components\validator\ValidatorEvidenceDrawer.tsx:168:    evidence: params.item,
components\validator\ValidatorEvidenceDrawer.tsx:186:      'Review the linked workbook, ticket, or support evidence for the expected match.',
components\validator\ValidatorEvidenceDrawer.tsx:228:      'Correct the mismatched field or review the linked evidence for the right source of truth.',
components\validator\ValidatorEvidenceDrawer.tsx:257:    entry.item.evidence_type === 'rate_schedule'
components\validator\ValidatorEvidenceDrawer.tsx:322:  evidence,
components\validator\ValidatorEvidenceDrawer.tsx:342:          Choose a blocker to review the approval gap, compare expected versus actual values, and jump into the linked evidence or decision flow.
components\validator\ValidatorEvidenceDrawer.tsx:350:  const evidenceEntries = evidence.map((item) => ({
components\validator\ValidatorEvidenceDrawer.tsx:354:      evidence: item,
components\validator\ValidatorEvidenceDrawer.tsx:360:  const structuredEvidence = evidenceEntries.filter((entry) => !isDocumentEvidence(entry.item));
components\validator\ValidatorEvidenceDrawer.tsx:361:  const documentEvidence = evidenceEntries.filter((entry) => isDocumentEvidence(entry.item));
components\validator\ValidatorEvidenceDrawer.tsx:363:    evidenceEntries.find((entry) => entry.target.exactTarget && entry.target.href)
components\validator\ValidatorEvidenceDrawer.tsx:364:    ?? evidenceEntries.find((entry) => entry.target.href)
components\validator\ValidatorEvidenceDrawer.tsx:380:      evidence.length === 0
components\validator\ValidatorEvidenceDrawer.tsx:381:        ? 'Validator has not persisted any document, page, fact, or row evidence for this finding yet.'
components\validator\ValidatorEvidenceDrawer.tsx:475:          <DetailBlock label="Data Source" value={sourceTraceLabel(activeFinding, evidence)} />
components\validator\ValidatorEvidenceDrawer.tsx:531:            Loading evidence...
components\validator\ValidatorEvidenceDrawer.tsx:541:            No document evidence is attached to this issue yet.
components\validator\ValidatorEvidenceDrawer.tsx:556:                      evidence: entry.item,
components\validator\ValidatorEvidenceDrawer.tsx:563:                      evidenceHref: entry.target.href,
components\validator\ValidatorEvidenceDrawer.tsx:617:            Approval outcomes are finalized in Execution Forge. Use the linked execution surface to approve, correct, or override this issue after reviewing the evidence.
components\decision-detail\DecisionDetailView.tsx:63:  evidence: DecisionEvidencePayload;
components\decision-detail\DecisionDetailView.tsx:846:  evidence: DecisionEvidencePayload;
components\decision-detail\DecisionDetailView.tsx:849:  const { evidence, details } = props;
components\decision-detail\DecisionDetailView.tsx:850:  const leadMetric = evidence.metrics[0];
components\decision-detail\DecisionDetailView.tsx:851:  const trailingMetrics = evidence.metrics.slice(1);
components\decision-detail\DecisionDetailView.tsx:860:      {!evidence.hasStructuredEvidence && (
components\decision-detail\DecisionDetailView.tsx:862:          No structured evidence payload was emitted for this decision. What you see below is the thinnest reliable fallback we could derive from the persisted record.
components\decision-detail\DecisionDetailView.tsx:906:      {evidence.references.length > 0 && (
components\decision-detail\DecisionDetailView.tsx:908:          {evidence.references.map((reference) => (
components\decision-detail\DecisionDetailView.tsx:920:      {evidence.notes.length > 0 && (
components\decision-detail\DecisionDetailView.tsx:922:          {evidence.notes.map((note) => (
components\decision-detail\DecisionDetailView.tsx:1044:    evidence,
components\decision-detail\DecisionDetailView.tsx:1084:          evidence={evidence}
components\decision-detail\DecisionDetailView.tsx:1118:            <EvidenceEnginePanel evidence={evidence} details={decision.details} />
components\decision-detail\DecisionContextPanel.tsx:119:  evidence: DecisionEvidencePayload;
components\decision-detail\DecisionContextPanel.tsx:137:    evidence,
components\decision-detail\DecisionContextPanel.tsx:166:    hasStructuredEvidence: evidence.hasStructuredEvidence,
components\decision-detail\DecisionContextPanel.tsx:266:                Inspect evidence from decision context first, then open the exact source document, fact, or spreadsheet row for review and correction.
components\decision-detail\DecisionContextPanel.tsx:270:              {evidence.targets.length} target{evidence.targets.length === 1 ? '' : 's'}
components\decision-detail\DecisionContextPanel.tsx:274:          {evidence.targets.length > 0 ? (
components\decision-detail\DecisionContextPanel.tsx:276:              {evidence.targets.map((target) => (
components\decision-detail\DecisionContextPanel.tsx:291:                        {target.exactTarget ? 'Open exact evidence' : 'Open source document'}
components\decision-detail\DecisionContextPanel.tsx:305:              {evidence.missingEvidenceMessage ?? 'No validator-backed evidence target is attached to this decision yet.'}
lib\crossDocumentGrounding.test.ts:8:  it('contract with Exhibit A signals uses strict evidence_v1 refs (no text_preview inference on confirm)', () => {
lib\crossDocumentGrounding.test.ts:23:          evidence_v1: {
lib\crossDocumentGrounding.test.ts:45:    assert.ok(refs.some((r) => r.includes('evidence_v1.section_signals.rate_section_pages')));
lib\crossDocumentGrounding.test.ts:49:  it('emits inference-only risk when rate keywords appear without evidence_v1 section signals', () => {
lib\crossDocumentGrounding.test.ts:61:          evidence_v1: {
app\api\ask\search\route.ts:99:    evidence: matchedRecords.map((record) => ({
app\api\ask\intelligence\route.ts:57:  const evidence = [
app\api\ask\intelligence\route.ts:77:    evidence,
lib\contracts\contractIntelligence.femaMockCorpus.test.ts:121:  it('low quality signature evidence stays visible enough for classification or explicit uncertainty', () => {
lib\contracts\contractDecisions.ts:52:      evidence: [
lib\contracts\contractDecisions.ts:78:          evidence: [
lib\contracts\contractDecisions.ts:109:      evidence: [
lib\contracts\contractDecisions.ts:133:      evidence: [
lib\contracts\contractDecisions.ts:152:  // It will activate in a future batch when a signature_evidence or equivalent field
lib\contracts\contractDecisions.ts:156:  // Trigger condition: analysis.signature_evidence?.quality === 'absent' | 'weak' | 'ambiguous'
app\api\ask\document\route.ts:118:function evidenceLocationLabel(evidence: EvidenceObject): string {
app\api\ask\document\route.ts:120:  if (typeof evidence.location.page === 'number') parts.push(`p.${evidence.location.page}`);
app\api\ask\document\route.ts:121:  if (typeof evidence.location.sheet === 'string' && evidence.location.sheet.length > 0) parts.push(evidence.location.sheet);
app\api\ask\document\route.ts:122:  if (typeof evidence.location.row === 'number') parts.push(`row ${evidence.location.row}`);
app\api\ask\document\route.ts:123:  if (typeof evidence.location.section === 'string' && evidence.location.section.length > 0) parts.push(evidence.location.section);
app\api\ask\document\route.ts:124:  if (typeof evidence.location.label === 'string' && evidence.location.label.length > 0) parts.push(evidence.location.label);
app\api\ask\document\route.ts:129:  if (!trace?.evidence) return [];
app\api\ask\document\route.ts:131:  return trace.evidence.filter((evidence) => {
app\api\ask\document\route.ts:133:      evidence.description,
app\api\ask\document\route.ts:134:      evidence.text,
app\api\ask\document\route.ts:135:      evidence.value == null ? '' : String(evidence.value),
app\api\ask\document\route.ts:136:      evidence.location.label,
app\api\ask\document\route.ts:137:      evidence.location.section,
app\api\ask\document\route.ts:138:      evidence.location.nearby_text,
app\api\ask\document\route.ts:192:  evidence: ProjectFindingEvidenceRow[];
app\api\ask\document\route.ts:196:  const evidenceByFindingId = new Map<string, ProjectFindingEvidenceRow[]>();
app\api\ask\document\route.ts:197:  for (const row of params.evidence) {
app\api\ask\document\route.ts:200:    const current = evidenceByFindingId.get(row.finding_id) ?? [];
app\api\ask\document\route.ts:202:    evidenceByFindingId.set(row.finding_id, current);
app\api\ask\document\route.ts:210:        evidenceByFindingId.has(finding.id)
app\api\ask\document\route.ts:215:      const evidence = evidenceByFindingId.get(finding.id)?.[0] ?? null;
app\api\ask\document\route.ts:216:      const location = evidence?.source_page ? ` p.${evidence.source_page}` : '';
app\api\ask\document\route.ts:219:        evidence?.note ??
app\api\ask\document\route.ts:220:        evidence?.field_value ??
app\api\ask\document\route.ts:355:    case 'document_missing_evidence': {
app\api\ask\document\route.ts:452:      const evidence = matchingEvidence(trace, factKey).slice(0, 3);
app\api\ask\document\route.ts:453:      if (evidence.length > 0) {
app\api\ask\document\route.ts:455:          ...evidence.map((item) => `${item.description} (${evidenceLocationLabel(item)}).`),
app\api\ask\document\route.ts:458:        support.push(`No direct evidence object is stored for ${factName.toLowerCase()}.`);
app\api\ask\document\route.ts:487:  const evidenceResult = await params.admin
app\api\ask\document\route.ts:488:    .from('project_validation_evidence')
app\api\ask\document\route.ts:491:  if (evidenceResult.error) return [];
app\api\ask\document\route.ts:495:    evidence: (evidenceResult.data ?? []) as ProjectFindingEvidenceRow[],
lib\contracts\contractDecisions.test.ts:51:    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
lib\contracts\contractDecisions.test.ts:53:      triggered.evidence.some((e) => e.field === 'document_shape' && e.value === 'bafo_response'),
lib\contracts\contractDecisions.test.ts:54:      'evidence must reference document_shape with value bafo_response',
lib\contracts\contractDecisions.test.ts:86:    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
lib\contracts\contractDecisions.test.ts:125:  it('invoice_overrun evidence includes actual, authorized, and computed delta', () => {
lib\contracts\contractDecisions.test.ts:131:    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.actual' && e.value === 97000));
lib\contracts\contractDecisions.test.ts:132:    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.authorized' && e.value === 85000));
lib\contracts\contractDecisions.test.ts:133:    assert.ok(triggered.evidence.some((e) => e.field === 'quantity_levels.delta' && e.value === 12000));
lib\contracts\contractDecisions.test.ts:144:    assert.ok(triggered.evidence.length > 0, 'evidence must be non-empty');
lib\contracts\contractDecisions.test.ts:146:      triggered.evidence.some((e) => e.field === 'authorization_state' && e.value === 'missing'),
lib\contracts\contractDecisions.test.ts:178:    assert.ok(triggered.evidence.some((e) => e.field === 'contract_domain' && e.value === 'waterway_maintenance'));
lib\contracts\contractDecisions.test.ts:179:    assert.ok(triggered.evidence.some((e) => e.field === 'expected_domain' && e.value === 'debris_removal'));
lib\contracts\contractDecisions.test.ts:208:  // When a signature_evidence field is graduated to ContractAnalysisResult in a future
lib\contracts\contractDecisions.test.ts:217:  it('signature_verify does not trigger on strong signature evidence context', () => {
lib\contracts\contractDecisions.test.ts:298:  it('every triggered decision has a non-empty evidence array', () => {
lib\contracts\contractDecisions.test.ts:310:        decision.evidence.length > 0,
$ Execution/decision lifecycle
lib\ask\aggregateSummaries.test.ts:29:  decision_id: 'decision-1',
lib\ask\aggregateSummaries.test.ts:30:  decision_title: 'Decision 1',
lib\ask\aggregateSummaries.test.ts:31:  decision_severity: 'medium',
lib\ask\aggregateSummaries.test.ts:34:  feedback_type: 'needs_review',
lib\ask\aggregateSummaries.test.ts:39:  href: '/platform/decisions/decision-1',
components\validator\ValidatorFindingsTable.tsx:308:                            {finding.decision_eligible ? (
components\validator\ValidatorEvidenceDrawer.tsx:8:import { executionItemProjectHref } from '@/lib/executionItems';
components\validator\ValidatorEvidenceDrawer.tsx:31:  executionItemId?: string | null;
components\validator\ValidatorEvidenceDrawer.tsx:170:    decisionId: params.finding.linked_decision_id,
components\validator\ValidatorEvidenceDrawer.tsx:323:  executionItemId = null,
components\validator\ValidatorEvidenceDrawer.tsx:342:          Choose a blocker to review the approval gap, compare expected versus actual values, and jump into the linked evidence or decision flow.
components\validator\ValidatorEvidenceDrawer.tsx:356:      decisionId: activeFinding.linked_decision_id,
components\validator\ValidatorEvidenceDrawer.tsx:374:  const executionHref = executionItemProjectHref(activeFinding.project_id, executionItemId);
components\validator\ValidatorEvidenceDrawer.tsx:562:                      executionHref,
components\validator\ValidatorEvidenceDrawer.tsx:585:              href={executionHref}
components\validator\ValidatorEvidenceDrawer.tsx:588:              {executionItemId ? 'Open Execution Item' : 'Open Execution'}
components\validator\ValidatorEvidenceDrawer.tsx:617:            Approval outcomes are finalized in Execution Forge. Use the linked execution surface to approve, correct, or override this issue after reviewing the evidence.
app\projects\[projectId]\approval-history\page.tsx:47:          Approval decision history and timeline
lib\contracts\analyzeContractIntelligence.ts:298:  const executionLike =
lib\contracts\analyzeContractIntelligence.ts:299:    /\b(term|initial term|agreement)[^.]{0,120}?(?:from|after)\s+(?:the\s+date\s+of\s+)?(?:execution|effective)\b/i.test(
lib\contracts\analyzeContractIntelligence.ts:302:  if (!executionLike) return null;
lib\contracts\analyzeContractIntelligence.ts:308:  return buildPatternMatch('execution_based_term', {
lib\contracts\analyzeContractIntelligence.ts:311:      ...findEvidenceIdsByRegex(ctx.document, /(?:term|initial term|agreement)[^.]{0,120}?(?:from|after)\s+(?:the\s+date\s+of\s+)?(?:execution|effective)/i),
lib\contracts\analyzeContractIntelligence.ts:318:    matchedPhrases: ['execution-based term'],
lib\contracts\analyzeContractIntelligence.ts:681:    /\beffective\s+(?:date|upon)\b[^.]{0,80}\bexecution\b/i.test(document.text_preview)
lib\contracts\analyzeContractIntelligence.ts:704:    patternIds: effectiveInheritsExecution ? ['execution_based_term'] : [],
lib\contracts\analyzeContractIntelligence.ts:712:      ? ['Effective date was inferred from execution-linked effective-date language.']
lib\contracts\analyzeContractIntelligence.ts:716:  const executionPattern = patternById.get('execution_based_term') ?? null;
lib\contracts\analyzeContractIntelligence.ts:718:    value: executionPattern?.semantic_slots.initial_term_length ?? null,
```
## 7. DUPLICATE-DERIVATION SUSPECTS
```
$ Totals math outside facts layer
components/decision-detail\DecisionDetailView.tsx:560:          {reason || decision.summary || 'This decision does not include a structured rationale yet.'}
components/validator\ValidatorEvidenceDrawer.tsx:210:    || field.includes('total')
components/PortfolioCommandCenter.tsx:76:        value={formatCurrency(portfolio.totalRequiresVerification)}
components/PortfolioCommandCenter.tsx:82:        value={formatCurrency(portfolio.totalAtRisk)}
components/PortfolioCommandCenter.tsx:343:  const totalIssues = issues.reduce((sum, i) => sum + i.count, 0);
components/PortfolioCommandCenter.tsx:345:  if (totalIssues === 0) {
components/projects\DocumentPrecedenceSection.tsx:763:                    {relationship.summary}
components/projects\DocumentPrecedenceSection.tsx:1003:                    {relationship.summary}
components/approval\ApprovalActionTimeline.tsx:375:            {history.total_actions} action{history.total_actions === 1 ? '' : 's'} across{' '}
components/projects\ProjectDecisionQueueFrame.tsx:97:        <p className="mt-2 text-sm leading-6 text-[var(--ef-text-muted)]">{issue.summary}</p>
components/projects\ProjectDecisionQueueFrame.tsx:132:        <FrameRow label="Decision question" value={decision?.summary ?? issue.finding.required_action ?? issue.nextAction} />
components/projects\ProjectDecisionQueueFrame.tsx:134:        <FrameRow label="Impact" value={issue.finding.impact ?? decision?.summary ?? 'Impact is captured on the validator finding and decision record.'} />
components/projects\ProjectFactsForge.tsx:235:  if (validatorSummary.required_review_total > 0) {
components/projects\ProjectFactsForge.tsx:236:    return `${validatorSummary.required_review_total} review${validatorSummary.required_review_total === 1 ? '' : 's'} still require operator action`;
components/projects\ProjectFactsForge.tsx:518:          validatorSummary.required_review_total,
components/projects\ProjectFactsForge.tsx:935:                    Impact uses the current project-wide validator and decision counts because the overview model does not expose fact-specific dependency totals.
components/projects\ProjectDocumentsForge.tsx:35:    /(billed|invoice).*(amount|total)/i,
components/projects\ProjectDocumentsForge.tsx:42:    /(invoice|workbook).*(amount|total)/i,
components/projects\ProjectDocumentsForge.tsx:554:                          ? `${selectedModel.counts.totalFacts} structured fact${selectedModel.counts.totalFacts === 1 ? '' : 's'} available`
components/projects\ValidatorTab.tsx:165:  if (!dataset.summary_json || typeof dataset.summary_json !== 'object' || Array.isArray(dataset.summary_json)) {
components/projects\ValidatorTab.tsx:169:  const summary = dataset.summary_json as Record<string, unknown>;
components/projects\ValidatorTab.tsx:183:    const totalTickets = readNumericDatasetValue(summary?.total_tickets);
components/projects\ValidatorTab.tsx:184:    const totalInvoicedAmount = readNumericDatasetValue(summary?.total_invoiced_amount);
components/projects\ValidatorTab.tsx:186:    return (totalTickets ?? 0) > 0 || (totalInvoicedAmount ?? 0) > 0;
components/projects\ValidatorTab.tsx:489:    lineTotal: formatContextCurrency(evidenceFieldValue(evidence, ['line_total', 'extended_amount', 'extended_cost', 'line_amount'])),
components/projects\ValidatorTab.tsx:594:  const blockedReason = params.summary.blocked_reasons.find(
components/projects\ValidatorTab.tsx:618:    summary.exposure?.total_billed_amount
components/projects\ValidatorTab.tsx:619:    ?? summary.total_billed
components/projects\ValidatorTab.tsx:784:            {invoiceLineContext.lineTotal ? <p>Line total: {invoiceLineContext.lineTotal}</p> : null}
components/projects\ProjectOverview.tsx:994:    && (model.validator_summary.total_at_risk == null || model.validator_summary.total_at_risk <= 0)
components/projects\ProjectOverview.tsx:1007:  const totalBilled = model.validator_summary.total_billed;
components/projects\ProjectOverview.tsx:1008:  const totalAtRisk = model.validator_summary.total_at_risk;
components/projects\ProjectOverview.tsx:1017:  const hasFinancials = totalBilled != null;
components/projects\ProjectOverview.tsx:1067:              <p className="mt-0.5 text-sm font-semibold text-[#E5EDF7]">{fmtMoney(totalBilled)}</p>
components/projects\ProjectOverview.tsx:1069:            {totalAtRisk != null ? (
components/projects\ProjectOverview.tsx:1072:                <p className={`mt-0.5 text-sm font-semibold ${totalAtRisk > 0 ? 'text-[#FCD34D]' : 'text-[#4ADE80]'}`}>
components/projects\ProjectOverview.tsx:1073:                  {fmtMoney(totalAtRisk)}
components/projects\ProjectOverview.tsx:1200:    model.validator_summary.required_review_total > 0
components/projects\ProjectOverview.tsx:1201:      ? model.validator_summary.required_review_total
components/projects\ProjectOverview.tsx:1553:                  : `${model.decision_total} linked decision record${model.decision_total === 1 ? '' : 's'} in this project context`
$ Rate/category normalization outside lib/contracts or lib/facts
components/decision-detail\DecisionWorkflowOutcomePanel.tsx:20:  generate_approval_log:          'Approval log generated',
components/decision-detail\DecisionWorkflowOutcomePanel.tsx:34:  generate_approval_log:          'Approval log generated',
components/decision-detail\DecisionContextPanel.tsx:26:  const normalized = gateImpact.toLowerCase();
components/decision-detail\DecisionContextPanel.tsx:27:  if (normalized.includes('blocks approval')) return 'text-[var(--ef-critical-soft)]';
components/decision-detail\DecisionContextPanel.tsx:29:    normalized.includes('holds approval')
components/decision-detail\DecisionContextPanel.tsx:30:    || normalized.includes('operator review')
components/decision-detail\DecisionContextPanel.tsx:31:    || normalized.includes('not established')
components/decision-detail\DecisionContextPanel.tsx:36:    normalized.includes('approval limit')
components/decision-detail\DecisionContextPanel.tsx:37:    || normalized.includes('exposure')
components/decision-detail\DecisionContextPanel.tsx:38:    || normalized.includes('capacity')
components/decision-detail\DecisionContextPanel.tsx:39:    || normalized.includes('clears the approval gate')
components/decision-detail\DecisionContextPanel.tsx:47:  const normalized = nextAction.toLowerCase();
components/decision-detail\DecisionContextPanel.tsx:49:    normalized.includes('resolve')
components/decision-detail\DecisionContextPanel.tsx:50:    || normalized.includes('review')
components/decision-detail\DecisionContextPanel.tsx:51:    || normalized.includes('confirm')
components/decision-detail\DecisionContextPanel.tsx:52:    || normalized.includes('escalate')
components/approval\ApprovalTaskResolutionControls.tsx:43:  'approval_generate_log',
components/approval\ApprovalActionTimeline.tsx:30:  generate_approval_log: 'Approval Log',
components/validator\ValidatorFindingsTable.tsx:19:  category: 'all' | ValidationCategory;
components/validator\ValidatorFindingsTable.tsx:114:    if (filters.category !== 'all' && finding.category !== filters.category) {
components/validator\ValidatorFindingsTable.tsx:157:            value={filters.category}
components/validator\ValidatorFindingsTable.tsx:158:            onChange={(event) => updateFilters('category', event.target.value as ValidatorFindingFilters['category'])}
components/validator\ValidatorFindingsTable.tsx:262:                            {CATEGORY_LABELS[finding.category]}
components/validator\ValidatorEvidenceDrawer.tsx:21:import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
components/validator\ValidatorEvidenceDrawer.tsx:68:    || item.evidence_type === 'rate_schedule'
components/validator\ValidatorEvidenceDrawer.tsx:114:  if (sourceFamily === 'support' || finding.category === 'required_sources') {
components/validator\ValidatorEvidenceDrawer.tsx:117:  if (finding.category === 'financial_integrity') {
components/validator\ValidatorEvidenceDrawer.tsx:121:  return humanizeTruthToken(finding.category);
components/validator\ValidatorEvidenceDrawer.tsx:139:  const rateCode = evidenceFieldValue(evidence, ['rate_code', 'line_code', 'item_code']);
components/validator\ValidatorEvidenceDrawer.tsx:149:      rateCode ? `Line ${rateCode}` : null,
components/validator\ValidatorEvidenceDrawer.tsx:150:      'Contract rate match',
components/validator\ValidatorEvidenceDrawer.tsx:181:    finding.category === 'required_sources'
components/validator\ValidatorEvidenceDrawer.tsx:193:    finding.category === 'ticket_integrity'
components/validator\ValidatorEvidenceDrawer.tsx:207:    finding.category === 'financial_integrity'
components/validator\ValidatorEvidenceDrawer.tsx:208:    || field.includes('rate')
components/validator\ValidatorEvidenceDrawer.tsx:213:      'Open the governing contract or rate schedule tied to this billing check.',
components/validator\ValidatorEvidenceDrawer.tsx:214:      'Locate the expected rate, amount, or threshold in the source record.',
components/validator\ValidatorEvidenceDrawer.tsx:221:    finding.category === 'identity_consistency'
components/validator\ValidatorEvidenceDrawer.tsx:257:    entry.item.evidence_type === 'rate_schedule'
components/validator\ValidatorEvidenceDrawer.tsx:258:    || entry.target.rateRowId
$ Component/app files importing supabaseClient
components/ActivityTimeline.tsx
components/approval\ApprovalActionTimeline.tsx
components/approval\ApprovalTaskResolutionControls.tsx
app/login\page.tsx
components/projects\ValidatorTab.tsx
components/projects\ProjectOverview.tsx
components/projects\ProjectExecutionForge.tsx
components/projects\ProjectDecisionQueueFrame.tsx
app/platform\workflows\[id]\page.tsx
components/projects\ProjectDecisionExecutionCard.tsx
app/platform\workflows\page.tsx
components/projects\ProjectAdminControls.tsx
components/projects\DocumentPrecedenceSection.tsx
app/platform\settings\page.tsx
app/platform\issues\page.tsx
components/ask\AskInterface.tsx
app/platform\rules\[id]\edit\page.tsx
components/DocumentProcessingStatus.tsx
app/platform\rules\page.tsx
app/platform\documents\[id]\page.tsx
app/platform\documents\page.tsx
app/platform\rules\new\page.tsx
app/platform\layout.tsx
app/platform\decisions\page.tsx
app/platform\projects\page.tsx
components/document-intelligence\AskDocumentSection.tsx
app/platform\decisions\[id]\page.tsx
app/platform\agents\page.tsx
components/documents\DocumentProjectControls.tsx
components/document-intelligence\ReviewSection.tsx
```
## 8. TEST & FIXTURE INVENTORY
```
$ test files wc -l
179 lib\ai\instructor\instructorAssist.test.ts
64 lib\ask\aggregateSummaries.test.ts
315 lib\ask\answerBuilder.test.ts
22 lib\ask\classifier.test.ts
93 lib\ask\documentRouteHelpers.test.ts
32 lib\ask\globalCommand.test.ts
138 lib\ask\portfolioAnswerBuilder.test.ts
88 lib\ask\portfolioProjectStatusAggregate.test.ts
199 lib\ask\reasoning.test.ts
180 lib\ask\retrieval.test.ts
18 lib\ask\suggestedQueries.test.ts
319 lib\contracts\contractDecisions.test.ts
967 lib\contracts\contractIntelligence.femaMockCorpus.test.ts
90 lib\contracts\contractIntelligence.golden.test.ts
73 lib\contracts\contractIntelligence.realFixtures.audit.test.ts
363 lib\contracts\contractIntelligence.test.ts
259 lib\contracts\contractorIdentity.test.ts
1929 lib\contracts\contractPricingAssembly.test.ts
24 lib\contracts\contractRateTableColumns.test.ts
219 lib\contracts\contractTaskGeneration.test.ts
683 lib\contracts\exhibitARateTableRows.test.ts
186 lib\crossDocumentGrounding.test.ts
354 lib\decisionContext.test.ts
89 lib\decisionDetail.test.ts
18 lib\decisionNavigation.test.ts
109 lib\decisions\decisionStatusRoute.test.ts
78 lib\documentFactActivity.test.ts
32 lib\documentIntelligence.detectedType.test.ts
86 lib\documentIntelligence.invoiceCanonicalTasks.test.ts
311 lib\documentIntelligence.spreadsheetReview.integration.test.ts
5647 lib\documentIntelligenceViewModel.test.ts
47 lib\documentNavigation.test.ts
420 lib\documentPrecedence.test.ts
169 lib\documents\documentFactReviewRoute.test.ts
158 lib\documents\documentReviewRoute.test.ts
287 lib\documentWorkspace.test.ts
120 lib\effectiveFacts.test.ts
394 lib\execution\executionItemOutcomeRoute.test.ts
57 lib\execution\executionSummary.test.ts
657 lib\execution\syncExecutionItems.test.ts
47 lib\extraction\evidenceValueMatch.test.ts
915 lib\extraction\pdf\extractTables.test.ts
91 lib\extraction\pdf\extractText.test.ts
152 lib\extraction\pdf\ocrGeometryLayout.test.ts
112 lib\extraction\pdf\pdfControlSanitization.test.ts
192 lib\extraction\pdf\unstructuredPartitioning.test.ts
879 lib\extraction\xlsx\normalizeTransactionData.test.ts
85 lib\extraction\xlsx\parseWorkbook.test.ts
95 lib\extraction\xlsx\ticketEvidenceGrounding.test.ts
226 lib\forgeDecisionGenerator.test.ts
TRUNCATED_SECTION_8_TO_LINE_CAP
## 9. RISK & REVIEW MARKERS
```
lib/server\approvalSnapshots.ts:133:    billing_group_ids: null, // TODO: extract from invoice details if available
lib/server\approvalSnapshots.ts:159:    blocking_reasons: [], // TODO: extract from intelligence trace if available
lib/server\approvalSnapshots.ts:160:    billing_group_ids: null, // TODO: extract from invoice details if available
lib/types\documentIntelligence.ts:282:/** @deprecated use ComparisonResult */
$ review/phantom/unknown markers
lib/ask\aggregateSummaries.test.ts:34:  feedback_type: 'needs_review',
lib/decisionContext.ts:55:  approvalStatus: 'approved' | 'approved_with_exceptions' | 'needs_review' | 'blocked' | null;
lib/decisionContext.ts:369:  return resolved === 'Unknown' ? 'Not Evaluated' : resolved;
lib/decisionContext.ts:376:    if (label !== 'Unknown' && label !== 'Not Evaluated') {
lib/decisionContext.ts:381:  return labels.find((label) => label !== 'Unknown') ?? 'Not Evaluated';
lib/decisionContext.ts:483:      return 'Unknown';
lib/decisionContext.ts:697:  if (contractCeiling == null || invoiceTotal == null) return 'Unknown';
lib/decisionContext.ts:817:      'needs_review_amount',
lib/decisionContext.ts:920:      validation: billedToDate != null ? 'Verified' : 'Unknown',
lib/decisionContext.ts:990:          ? 'Unknown'
lib/decisionContext.ts:1023:          ? 'Unknown'
lib/decisionContext.ts:1132:    'needs_review_line_count',
lib/decisionContext.ts:1174:      validation: validatedLinesCount != null ? 'Verified' : 'Unknown',
lib/decisionContext.ts:1186:          ? 'Unknown'
lib/decisionContext.ts:1199:          ? 'Unknown'
lib/decisionDetail.ts:167:function formatUnknownValue(value: unknown, keyHint = ''): string {
lib/decisionDetail.ts:176:      .map((item) => formatUnknownValue(item, keyHint))
lib/decisionDetail.ts:279:      return 'Unknown';
lib/decisionDetail.ts:344:      gate = `${humanize(fieldKey || 'threshold')} is running at ${formatRatioPercent(ratio)} of target (${formatUnknownValue(observed, fieldKey)} observed vs ${formatUnknownValue(expected, fieldKey)} expected${delta > 0 ? `, ${formatUnknownValue(delta, fieldKey)} over threshold` : ''}).`;
lib/decisionDetail.ts:404:      detail: `Observed ${formatUnknownValue(observed, fieldKey)} vs expected ${formatUnknownValue(expected, fieldKey)}.`,
lib/decisionDetail.ts:443:        detail: `Actual ${formatUnknownValue(actual, conditionField)} vs expected ${formatUnknownValue(expectedValue, conditionField)}.`,
lib/decisionDetail.ts:489:        detail: `${humanize(operator)}: ${formatUnknownValue(condition.actual, conditionField)} vs ${formatUnknownValue(condition.expected, conditionField)}`,
lib/decisionDetail.ts:503:          detail: formatUnknownValue(value, key),
lib/decisionToWorkflow.ts:118:  if (validationState === 'Missing' || validationState === 'Unknown') return 'medium';
lib/decisionToWorkflow.ts:228:    case 'needs_review':           return 'Needs Review';
lib/documentIntelligence.ts:4169:            : 'Unknown';
lib/documentIntelligence.ts:6272:/** Interpret a boolean or string as YesNoUnknown */
lib/documentIntelligenceViewModel.ts:667:function readLegacyUnknownEligibilityCount(value: unknown): number {
lib/documentIntelligenceViewModel.ts:680:  legacyUnknownCount?: number | null | undefined;
lib/documentIntelligenceViewModel.ts:687:  const legacyUnknownCount = params.legacyUnknownCount ?? null;
lib/documentIntelligenceViewModel.ts:689:    ineligibleBase != null || legacyUnknownCount != null
lib/documentIntelligenceViewModel.ts:690:      ? (ineligibleBase ?? 0) + (legacyUnknownCount ?? 0)
lib/documentIntelligenceViewModel.ts:699:function stripLegacyUnknownEligibilityFields<T extends object>(value: T): T {
lib/documentIntelligenceViewModel.ts:1308:  const legacyUnknownCount = readLegacyUnknownEligibilityCount(overview);
lib/documentIntelligenceViewModel.ts:1312:    legacyUnknownCount,
lib/documentIntelligenceViewModel.ts:1316:    ...stripLegacyUnknownEligibilityFields(overview),
lib/documentIntelligenceViewModel.ts:1378:    legacyUnknownCount:
lib/documentIntelligenceViewModel.ts:1379:      readLegacyUnknownEligibilityCount(canonicalSummary)
lib/documentIntelligenceViewModel.ts:1380:      + readLegacyUnknownEligibilityCount(extractionRollups),
lib/documentIntelligenceViewModel.ts:1445:    ...stripLegacyUnknownEligibilityFields(extractionRollups ?? {}),
```
## 10. OPEN-QUESTION CHECKLIST
- Verify canonical fact persistence fields against validator read paths above.
- Check direct `supabaseClient` imports in UI/app files for projection bypass.
- Resolve duplicate total/rate/category calculations listed outside facts/contracts layers.
- Confirm `rate_schedule_rows` DDL, persistence, validation, and UI references align.
- Confirm evidence anchors use stable source fields across extraction, facts, validation, and UI.
- Review `requires_review` / `needs_review` lifecycle consistency across decisions and execution.
- Inspect TODO/FIXME/HACK markers before touching nearby code.
- Confirm generated database types are current with sorted migration sequence.
- Confirm Golden Project fixture references still match active validation expectations.
- Review unknown/phantom markers for unresolved truth-state semantics.
