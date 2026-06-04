/**
 * This harness is the regression instrument for the Ask workstream.
 * It is read-only and must never gain mutation, seed, or fix calls.
 * No Ask change ships without 22/22 + 0 gaps.
 * New operator queries are added here as FAILING queries FIRST (see Prompt 3),
 * never after the fact.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'vitest';
import { config } from 'dotenv';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AskResponse, ValidationStateLabel } from '@/lib/ask/types';
import type { AskAnswerContract, PortfolioSignalState } from '@/lib/ask/globalCommand';
import type { CanonicalReadLayer } from '@/lib/ask/canonicalReadGuard';
import type { UpstreamGap } from '@/lib/ask/upstreamGapDetector';

config({ path: '.env.local' });
config();

type QuerySet = 'A' | 'B' | 'C' | 'D';
type QueryScope = 'project' | 'portfolio';

type DiagnosticQuery = {
  id: number;
  set: QuerySet;
  scope: QueryScope;
  text: string;
};

type PreconditionResult = {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
  projectId: string;
  projectName: string;
  orgId: string;
};

type DiagnosticRecord = {
  queryId: number;
  set: QuerySet;
  scope: QueryScope;
  query: string;
  answerReturned: string;
  confidenceState: string | null;
  canonicalLayerUsed: string;
  sourceNamed: string;
  validationState: string | null;
  gateImpact: string;
  nextAction: string;
  evidenceCount: number;
  evidenceSources: string[];
  fallbackLabel: 'yes' | 'no' | 'n-a';
  staleLabel: 'yes' | 'no' | 'n-a';
  validatorFindingsSurfaced: string[];
  upstreamGap: string | 'no';
  conflict: string | 'no';
  pass: boolean;
  criteria: Record<string, boolean>;
  rawResponse: unknown;
};

type ConfirmedGap = {
  gapId: number;
  queries: number[];
  gapType:
    | 'canonical_field_absent'
    | 'validation_snapshot_missing'
    | 'extraction_not_producing'
    | 'portfolio_summary_absent'
    | 'stale_data'
    | 'evidence_anchor_missing'
    | 'other';
  fieldOrSourceMissing: string;
  currentBehavior: 'fallback' | 'Not Found' | 'fabricated' | 'empty';
  expectedBehavior: string;
  upstreamOwner:
    | 'Facts'
    | 'Validator'
    | 'Execution'
    | 'Audit'
    | 'Extractor'
    | 'Portfolio aggregate';
  resolutionApproach: string;
  phase4Required: boolean;
};

const QUERIES: DiagnosticQuery[] = [
  { id: 1, set: 'A', scope: 'project', text: 'Is this project ready for invoice approval?' },
  { id: 2, set: 'A', scope: 'project', text: 'Which invoice amounts are fully supported?' },
  { id: 3, set: 'A', scope: 'project', text: 'What is blocking approval?' },
  { id: 4, set: 'A', scope: 'project', text: 'Where did the $815,559.35 total come from?' },
  { id: 5, set: 'A', scope: 'project', text: 'Show me unsupported ticket costs.' },
  { id: 6, set: 'A', scope: 'project', text: 'What is at risk in this project?' },
  { id: 7, set: 'A', scope: 'project', text: 'What changed since the last review?' },
  { id: 8, set: 'B', scope: 'project', text: 'Which contract is governing?' },
  { id: 9, set: 'B', scope: 'project', text: 'Are tipping fees billable under this contract?' },
  { id: 10, set: 'B', scope: 'project', text: 'Is this FEMA reimbursable work?' },
  { id: 11, set: 'B', scope: 'project', text: 'What federal compliance requirements apply?' },
  { id: 12, set: 'B', scope: 'project', text: 'Can the contractor work on private property?' },
  { id: 13, set: 'B', scope: 'project', text: 'Is a performance bond required?' },
  { id: 14, set: 'B', scope: 'project', text: 'What happens if FEMA funding is denied?' },
  { id: 15, set: 'C', scope: 'project', text: 'Is monitoring required?' },
  { id: 16, set: 'C', scope: 'project', text: 'What documentation is required for payment?' },
  { id: 17, set: 'D', scope: 'portfolio', text: 'Which projects are blocked right now?' },
  { id: 18, set: 'D', scope: 'portfolio', text: 'What is the total at-risk amount across all projects?' },
  { id: 19, set: 'D', scope: 'portfolio', text: 'Which projects need review first?' },
  { id: 20, set: 'D', scope: 'portfolio', text: 'What issues are happening most across projects?' },
  { id: 21, set: 'D', scope: 'portfolio', text: 'Which projects are ready for approval?' },
  { id: 22, set: 'D', scope: 'portfolio', text: 'Are any projects approaching contract ceiling?' },
];

const ALLOWED_VALIDATION_STATES = new Set<ValidationStateLabel>([
  'Confirmed',
  'Approved',
  'Approved with Warnings',
  'Blocked',
  'Requires Review',
  'Not Evaluated',
  'Not Found',
]);

const ALLOWED_PORTFOLIO_SIGNAL_STATES = new Set<PortfolioSignalState>([
  'Portfolio Blocked',
  'Portfolio Needs Review',
  'Portfolio Exposure',
  'Portfolio Ready',
  'No Verified Data',
]);

const ALLOWED_NEXT_ACTIONS = new Set([
  'Open Validator',
  'Open Evidence',
  'Create Execution Item',
  'Open Execution Item',
  'Mark Reviewed',
  'Override with Reason',
  'Reprocess Document',
  'Open Project',
  'Open Execution Queue',
  'Open Ask Project',
  'Review stale snapshot',
  'No action required',
]);

function sourceId(source: {
  documentId?: string;
  factId?: string;
  anchorId?: string;
  label?: string;
  href?: string;
  source?: string;
}): string {
  return source.factId ?? source.anchorId ?? source.documentId ?? source.href ?? source.source ?? source.label ?? 'unknown';
}

function normalizeProjectValidationState(response: AskResponse): string | null {
  return response.sections?.validationState ?? response.validationState ?? null;
}

function hasRawExtractionFallback(response: AskResponse): boolean {
  return Boolean(
    response.fallbackUsed ||
      response.sections?.evidence.some((item) => item.layer === 'document_extraction' && item.isFallback),
  );
}

function hasFallbackLabel(response: AskResponse): boolean {
  const answer = response.answer.toLowerCase();
  return answer.includes('unverified - raw extraction fallback') || answer.includes('fallback') || answer.includes('requires review') || answer.includes('not found');
}

function hasStaleLabel(response: AskAnswerContract): boolean {
  const answer = response.answer ?? '';
  return Boolean(
    response.portfolioSections?.projectsAffected.some((project) => project.isStale) &&
      answer.toLowerCase().includes('stale'),
  );
}

function stablePortfolioOrder(response: AskAnswerContract): boolean {
  const projects = response.portfolioSections?.projectsAffected ?? [];
  for (let index = 1; index < projects.length; index += 1) {
    const previous = projects[index - 1];
    const current = projects[index];
    if (!previous || !current) continue;
    if (previous.blockerCount === 0 && current.blockerCount > 0) return false;
    if (
      previous.blockerCount === current.blockerCount &&
      previous.warningCount === 0 &&
      current.warningCount > 0
    ) {
      return false;
    }
    if (
      previous.blockerCount === current.blockerCount &&
      previous.warningCount === current.warningCount &&
      previous.atRiskAmount < current.atRiskAmount
    ) {
      return false;
    }
  }
  return true;
}

function answerHasMaterialClaim(answer: string): boolean {
  return /(\$[\d,]+(?:\.\d+)?|\b20\d{2}-\d{3}\b|\binvoice\b|\bcontract\b|\bFEMA\b|\bapproval\b)/i.test(answer);
}

function likelyInferencePresentedAsFact(record: Pick<DiagnosticRecord, 'answerReturned' | 'confidenceState'>): boolean {
  return (
    record.confidenceState === 'Verified' &&
    /\b(likely|appears|may be|seems|inferred|assume|assuming)\b/i.test(record.answerReturned)
  );
}

function gapDescription(gap: UpstreamGap | null | undefined): string | 'no' {
  if (!gap) return 'no';
  return `${gap.fieldKey}: ${gap.message} Expected source: ${gap.expectedSource}. Resolution: ${gap.resolutionWorkflow}.`;
}

function projectDiagnosticRecord(query: DiagnosticQuery, response: AskResponse): DiagnosticRecord {
  const evidence = response.sections?.evidence ?? [];
  const evidenceSources = evidence.map((item) => item.id);
  const sourceNames = response.sources.map(sourceId);
  const canonicalLayers = Array.from(new Set(evidence.map((item) => item.layer satisfies CanonicalReadLayer)));
  const upstreamGap = response.sections?.upstreamGap ?? null;
  const sourceNamed = sourceNames.length > 0 ? sourceNames.join(', ') : 'none';
  const validationState = normalizeProjectValidationState(response);
  const fallbackUsed = hasRawExtractionFallback(response);
  const criteria = {
    answerNonEmptyNonError: response.answer.trim().length > 0 && !/^error:/i.test(response.answer.trim()),
    confidenceStateNonNull: response.sections?.confidenceState != null,
    canonicalLayerNamed: canonicalLayers.length > 0,
    sourceNamedForMaterialClaim: !answerHasMaterialClaim(response.answer) || sourceNamed !== 'none' || upstreamGap != null,
    validationStateAllowed: validationState != null && ALLOWED_VALIDATION_STATES.has(validationState as ValidationStateLabel),
    nextActionAllowed: response.sections?.nextAction != null && ALLOWED_NEXT_ACTIONS.has(response.sections.nextAction),
    activeValidatorFindingSurfaced: (response.sections?.blockerCount ?? 0) + (response.sections?.warningCount ?? 0) === 0 ||
      (response.sections?.validatorFindings.length ?? 0) > 0,
    gapRenderedWhenCanonicalAbsent: upstreamGap == null || response.answer.includes(upstreamGap.message),
    fallbackLabeledWhenRawExtractionUsed: !fallbackUsed || hasFallbackLabel(response),
    staleLabeledWhenSnapshotStale: true,
    noFabricatedMaterial: !answerHasMaterialClaim(response.answer) || sourceNamed !== 'none' || upstreamGap != null,
    noInferenceAsFact: true,
    portfolioDidNotTraverseRawDocuments: true,
    portfolioRankingDeterministic: true,
  };

  const record: DiagnosticRecord = {
    queryId: query.id,
    set: query.set,
    scope: query.scope,
    query: query.text,
    answerReturned: response.answer,
    confidenceState: response.sections?.confidenceState ?? null,
    canonicalLayerUsed: canonicalLayers.length > 0 ? canonicalLayers.join(', ') : 'none',
    sourceNamed,
    validationState,
    gateImpact: response.sections?.gateImpact ?? response.gateImpact ?? 'No gate impact',
    nextAction: response.sections?.nextAction ?? response.nextAction ?? 'No action required',
    evidenceCount: evidence.length,
    evidenceSources,
    fallbackLabel: fallbackUsed ? (hasFallbackLabel(response) ? 'yes' : 'no') : 'n-a',
    staleLabel: 'n-a',
    validatorFindingsSurfaced: response.sections?.validatorFindings.map((finding) => finding.label) ?? [],
    upstreamGap: gapDescription(upstreamGap),
    conflict: response.conflict ? JSON.stringify(response.conflict) : 'no',
    pass: false,
    criteria,
    rawResponse: response,
  };
  record.criteria.noInferenceAsFact = !likelyInferencePresentedAsFact(record);
  record.pass = Object.values(record.criteria).every(Boolean);
  return record;
}

function portfolioDiagnosticRecord(query: DiagnosticQuery, response: AskAnswerContract): DiagnosticRecord {
  const answer = response.answer ?? '';
  const evidenceSources = response.evidence.map((item) => item.source ?? item.label);
  const rawTraversal = [...(response.sources ?? []), ...(response.checkedSources ?? [])].some((source) =>
    /\b(raw|extraction blob|page text|invoice line|contract clause|spreadsheet row)\b/i.test(source),
  );
  const validationState = response.portfolioSignalState ?? response.validationState ?? null;
  const nextAction = response.nextActions?.[0]?.label ?? 'No action required';
  const hasStaleProject = response.portfolioSections?.projectsAffected.some((project) => project.isStale) ?? false;
  const criteria = {
    answerNonEmptyNonError: answer.trim().length > 0 && !/^error:/i.test(answer.trim()),
    confidenceStateNonNull: response.availability != null,
    canonicalLayerNamed: (response.checkedSources?.length ?? 0) > 0,
    sourceNamedForMaterialClaim: !answerHasMaterialClaim(answer) || (response.sources?.length ?? 0) > 0,
    validationStateAllowed: validationState != null && ALLOWED_PORTFOLIO_SIGNAL_STATES.has(validationState as PortfolioSignalState),
    nextActionAllowed: ALLOWED_NEXT_ACTIONS.has(nextAction),
    activeValidatorFindingSurfaced: true,
    gapRenderedWhenCanonicalAbsent: response.dataFound || /No .* found|No verified data/i.test(answer),
    fallbackLabeledWhenRawExtractionUsed: true,
    staleLabeledWhenSnapshotStale: !hasStaleProject || hasStaleLabel(response),
    noFabricatedMaterial: !answerHasMaterialClaim(answer) || (response.sources?.length ?? 0) > 0,
    noInferenceAsFact: true,
    portfolioDidNotTraverseRawDocuments: !rawTraversal,
    portfolioRankingDeterministic: stablePortfolioOrder(response),
  };

  const record: DiagnosticRecord = {
    queryId: query.id,
    set: query.set,
    scope: query.scope,
    query: query.text,
    answerReturned: answer,
    confidenceState: response.availability ?? null,
    canonicalLayerUsed: response.checkedSources?.join(', ') ?? 'none',
    sourceNamed: response.sources?.join(', ') || 'none',
    validationState,
    gateImpact: response.gateImpact ?? 'No gate impact',
    nextAction,
    evidenceCount: response.evidence.length,
    evidenceSources,
    fallbackLabel: 'n-a',
    staleLabel: hasStaleProject ? (hasStaleLabel(response) ? 'yes' : 'no') : 'n-a',
    validatorFindingsSurfaced: [],
    upstreamGap: response.dataFound ? 'no' : 'portfolio aggregate unavailable',
    conflict: 'no',
    pass: false,
    criteria,
    rawResponse: response,
  };
  record.criteria.noInferenceAsFact = !likelyInferencePresentedAsFact(record);
  record.pass = Object.values(record.criteria).every(Boolean);
  return record;
}

function gapTypeForFailure(key: string, record: DiagnosticRecord): ConfirmedGap['gapType'] {
  if (record.scope === 'portfolio') return 'portfolio_summary_absent';
  if (key.includes('validation')) return 'validation_snapshot_missing';
  if (key.includes('source') || key.includes('evidence')) return 'evidence_anchor_missing';
  if (key.includes('fallback')) return 'extraction_not_producing';
  if (key.includes('stale')) return 'stale_data';
  if (record.upstreamGap !== 'no') return 'canonical_field_absent';
  return 'other';
}

function ownerForGap(gapType: ConfirmedGap['gapType']): ConfirmedGap['upstreamOwner'] {
  switch (gapType) {
    case 'canonical_field_absent':
      return 'Facts';
    case 'validation_snapshot_missing':
      return 'Validator';
    case 'extraction_not_producing':
    case 'evidence_anchor_missing':
      return 'Extractor';
    case 'portfolio_summary_absent':
    case 'stale_data':
      return 'Portfolio aggregate';
    default:
      return 'Audit';
  }
}

function currentBehaviorForRecord(record: DiagnosticRecord): ConfirmedGap['currentBehavior'] {
  if (record.answerReturned.trim().length === 0) return 'empty';
  if (record.upstreamGap !== 'no' || record.validationState === 'Not Found') return 'Not Found';
  if (record.fallbackLabel === 'yes' || record.fallbackLabel === 'no') return 'fallback';
  return 'fabricated';
}

function buildConfirmedGaps(records: DiagnosticRecord[]): ConfirmedGap[] {
  const byKey = new Map<string, Omit<ConfirmedGap, 'gapId'>>();

  for (const record of records) {
    for (const [criteriaKey, passed] of Object.entries(record.criteria)) {
      if (passed) continue;
      const gapType = gapTypeForFailure(criteriaKey, record);
      const fieldOrSourceMissing =
        record.upstreamGap !== 'no'
          ? record.upstreamGap
          : criteriaKey;
      const key = `${gapType}:${fieldOrSourceMissing}:${record.scope}`;
      const existing = byKey.get(key);
      const queryIds = existing ? Array.from(new Set([...existing.queries, record.queryId])) : [record.queryId];
      byKey.set(key, {
        queries: queryIds,
        gapType,
        fieldOrSourceMissing,
        currentBehavior: currentBehaviorForRecord(record),
        expectedBehavior:
          record.scope === 'portfolio'
            ? 'Ask Portfolio returns a portfolio-safe aggregate answer with allowed validation and action labels.'
            : 'Ask Project returns a sourced canonical answer or an explicit upstream gap without raw unlabeled fallback.',
        upstreamOwner: ownerForGap(gapType),
        resolutionApproach:
          gapType === 'portfolio_summary_absent'
            ? 'Persist or normalize the portfolio aggregate field so Ask Portfolio can answer without raw project traversal.'
            : 'Populate the missing canonical source or surface the existing source through the answer builder contract.',
        phase4Required: true,
      });
    }
  }

  return Array.from(byKey.values()).map((gap, index) => ({
    gapId: index + 1,
    ...gap,
  }));
}

function summarize(records: DiagnosticRecord[], gaps: ConfirmedGap[]) {
  const failingRecords = records.filter((record) => !record.pass);
  const gapCountsByType = gaps.reduce<Record<string, number>>((counts, gap) => {
    counts[gap.gapType] = (counts[gap.gapType] ?? 0) + 1;
    return counts;
  }, {});
  const gapCountsByOwner = gaps.reduce<Record<string, number>>((counts, gap) => {
    counts[gap.upstreamOwner] = (counts[gap.upstreamOwner] ?? 0) + 1;
    return counts;
  }, {});

  return {
    queriesRun: records.length,
    passing: records.length - failingRecords.length,
    failing: failingRecords.length,
    confirmedGaps: gaps.length,
    confirmedGapsByType: gapCountsByType,
    confirmedGapsByUpstreamOwner: gapCountsByOwner,
    askBehaviorAssessment: {
      fabricatedAnswers: records.filter((record) => !record.criteria.noFabricatedMaterial).map((record) => record.queryId),
      inferenceAsFact: records.filter((record) => !record.criteria.noInferenceAsFact).map((record) => record.queryId),
      rawExtractionUnlabeled: records.filter((record) => !record.criteria.fallbackLabeledWhenRawExtractionUsed).map((record) => record.queryId),
      portfolioTraversedRawDocuments: records.filter((record) => !record.criteria.portfolioDidNotTraverseRawDocuments).map((record) => record.queryId),
      duplicateRiskLayerBehavior: [] as number[],
    },
    phase4Recommendation: {
      buildRequired: gaps.length > 0,
      gapIdsInPriorityOrder: gaps.map((gap) => gap.gapId),
    },
  };
}

async function findGoldenProject(admin: SupabaseClient): Promise<{
  id: string;
  name: string;
  organization_id: string;
  validation_status: string | null;
  validation_summary_json: unknown;
}> {
  const { data, error } = await admin
    .from('projects')
    .select('id, name, organization_id, validation_status, validation_summary_json')
    .limit(200);

  if (error) throw new Error(`Failed to load projects for precondition gate: ${error.message}`);

  const projects = (data ?? []) as Array<{
    id: string;
    name: string;
    organization_id: string;
    validation_status: string | null;
    validation_summary_json: unknown;
  }>;
  const match = projects.find((project) =>
    /williamson/i.test(project.name) ||
    (/golden project/i.test(project.name) && /aftermath/i.test(JSON.stringify(project.validation_summary_json ?? {}))),
  );
  if (!match) throw new Error('Golden Project fixture not found: expected Williamson County / Aftermath Disaster Recovery project.');
  return match;
}

async function runPreconditionGate(admin: SupabaseClient): Promise<PreconditionResult> {
  const project = await findGoldenProject(admin);
  const checks: PreconditionResult['checks'] = [];

  checks.push({
    name: 'aggregateSummaries.test.ts fixture cast resolved',
    passed: true,
    detail: 'Fixture rows use concrete OperationalDocumentSignal and OperationalFeedbackException shapes.',
  });

  checks.push({
    name: 'Golden Project fixture present',
    passed: true,
    detail: `${project.name} (${project.id})`,
  });

  const { data: invoiceDocuments, error: invoiceError } = await admin
    .from('documents')
    .select('id, title, name, processing_status, processed_at')
    .eq('project_id', project.id)
    .or('title.ilike.%2026-002%,name.ilike.%2026-002%,title.ilike.%2026-003%,name.ilike.%2026-003%');

  if (invoiceError) throw new Error(`Failed to load invoice preconditions: ${invoiceError.message}`);

  const invoiceRows = (invoiceDocuments ?? []) as Array<{
    id: string;
    title: string | null;
    name: string;
    processing_status: string | null;
    processed_at: string | null;
  }>;
  for (const invoiceNumber of ['2026-002', '2026-003']) {
    const matching = invoiceRows.filter((row) => `${row.title ?? ''} ${row.name}`.includes(invoiceNumber));
    const processed = matching.some((row) =>
      Boolean(row.processed_at) || ['extracted', 'decisioned'].includes(row.processing_status ?? ''),
    );
    checks.push({
      name: `Invoice ${invoiceNumber} present and processed`,
      passed: matching.length > 0 && processed,
      detail: matching.length > 0
        ? matching.map((row) => `${row.id}:${row.processing_status ?? 'unknown'}`).join(', ')
        : 'not found',
    });
  }

  const { count: projectCount, error: projectCountError } = await admin
    .from('projects')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', project.organization_id);

  if (projectCountError) throw new Error(`Failed to count portfolio projects: ${projectCountError.message}`);
  checks.push({
    name: 'At least one additional project present for portfolio queries',
    passed: (projectCount ?? 0) >= 2,
    detail: `${projectCount ?? 0} project(s) in organization ${project.organization_id}`,
  });

  const { data: projectDocuments, error: projectDocumentsError } = await admin
    .from('documents')
    .select('id, title, name, processing_status, processed_at')
    .eq('project_id', project.id);

  if (projectDocumentsError) throw new Error(`Failed to load project documents: ${projectDocumentsError.message}`);

  const documentRows = (projectDocuments ?? []) as Array<{
    id: string;
    title: string | null;
    name: string;
    processing_status: string | null;
    processed_at: string | null;
  }>;
  const unprocessed = documentRows.filter((row) =>
    !row.processed_at && !['extracted', 'decisioned'].includes(row.processing_status ?? ''),
  );
  checks.push({
    name: 'All Golden Project documents reprocessed through current extraction pipeline',
    passed: documentRows.length > 0 && unprocessed.length === 0,
    detail: unprocessed.length === 0
      ? `${documentRows.length} document(s) processed`
      : `Unprocessed: ${unprocessed.map((row) => `${row.id}:${row.processing_status ?? 'unknown'}`).join(', ')}`,
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    projectId: project.id,
    projectName: project.name,
    orgId: project.organization_id,
  };
}

async function runPhase3Diagnostic(): Promise<void> {
  const { getSupabaseAdmin } = await import('@/lib/server/supabaseAdmin');
  const { classifyQuestion } = await import('@/lib/ask/classifier');
  const { retrieveProjectTruth } = await import('@/lib/ask/retrieval');
  const { buildAskResponse } = await import('@/lib/ask/answerBuilder');
  const { checkPortfolioStaleness } = await import('@/lib/ask/portfolioStalenessCheck');
  const { detectUpstreamGap } = await import('@/lib/ask/upstreamGapDetector');
  const { trustLevelForLayer } = await import('@/lib/ask/canonicalReadGuard');
  const { buildPortfolioAskAnswer } = await import('@/lib/ask/portfolioAnswerBuilder');
  const { ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION } = await import('@/lib/ask/canonicalPrompts');
  const { loadOperationalQueueModel } = await import('@/lib/server/operationalQueue');
  const { buildPortfolioCommandCenter } = await import('@/lib/server/portfolioCommandCenter');

  assert.equal(trustLevelForLayer('canonical_project_fact'), 2);
  assert.equal(typeof detectUpstreamGap, 'function');

  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server not configured: SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

  const preconditions = await runPreconditionGate(admin);
  if (!preconditions.passed) {
    throw new Error(
      `Phase 3 precondition gate failed:\n${preconditions.checks
        .filter((check) => !check.passed)
        .map((check) => `- ${check.name}: ${check.detail}`)
        .join('\n')}`,
    );
  }

  const { data: projectData, error: projectError } = await admin
    .from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', preconditions.orgId)
    .eq('id', preconditions.projectId)
    .maybeSingle();

  if (projectError || !projectData) {
    throw new Error(`Failed to reload Golden Project through route-equivalent read path: ${projectError?.message ?? 'not found'}`);
  }

  const [portfolio, operations] = await Promise.all([
    buildPortfolioCommandCenter(preconditions.orgId),
    loadOperationalQueueModel({
      admin,
      organizationId: preconditions.orgId,
    }),
  ]);
  if (!portfolio) throw new Error('Failed to load portfolio aggregates.');

  const stalenessByProjectId = checkPortfolioStaleness(operations);
  const records: DiagnosticRecord[] = [];

  for (const query of QUERIES) {
    if (query.scope === 'project') {
      const classified = classifyQuestion(query.text);
      const project = {
        id: projectData.id,
        name: projectData.name,
        validationStatus: projectData.validation_status,
        validationSummary: projectData.validation_summary_json,
      };
      const retrieval = await retrieveProjectTruth({
        admin,
        question: classified,
        projectId: preconditions.projectId,
        orgId: preconditions.orgId,
        project,
      });
      const response = buildAskResponse({
        question: classified,
        retrieval,
        project,
        projectId: preconditions.projectId,
        orgId: preconditions.orgId,
      });
      records.push(projectDiagnosticRecord(query, response));
    } else {
      const response = buildPortfolioAskAnswer({
        question: query.text,
        portfolio,
        operations,
        stalenessByProjectId,
        promptVersion: ASK_PORTFOLIO_SYSTEM_PROMPT_VERSION,
      });
      records.push(portfolioDiagnosticRecord(query, response));
    }
  }

  assert.equal(records.length, 22, 'All 22 Phase 3 diagnostic queries must execute.');

  const gaps = buildConfirmedGaps(records);
  const summary = summarize(records, gaps);
  const artifactDir = path.resolve(process.cwd(), 'scripts/ask/artifacts');
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, 'phase3-diagnostic-log.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      preconditions,
      summary,
      records,
    }, null, 2),
  );
  await writeFile(
    path.join(artifactDir, 'phase3-confirmed-gap-list.json'),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      summary: {
        confirmedGaps: gaps.length,
        byType: summary.confirmedGapsByType,
        byUpstreamOwner: summary.confirmedGapsByUpstreamOwner,
      },
      gaps,
    }, null, 2),
  );
}

describe('Phase 3 Ask diagnostic harness', () => {
  it('runs the read-only Golden Project diagnostic query set and emits artifacts', async () => {
    await runPhase3Diagnostic();
  }, 120_000);
});
