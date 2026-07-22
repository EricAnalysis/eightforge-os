import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { finalizeDecision } from '@/lib/server/decisionClosure';
import { syncExecutionItems } from '@/lib/execution/syncExecutionItems';
import { evaluateFindingRouting } from '@/lib/validator/validatorRouting';
import { persistApprovalSnapshot } from '@/lib/server/approvalSnapshots';
import { executeApprovalActions } from '@/lib/server/approvalActionEngine';
import { emitValidationFindingLifecycleActivity } from '@/lib/validator/validationFindingActivity';
import type {
  ProjectOperationalRollup,
  ProjectValidatorSummarySnapshot,
} from '@/lib/projectOverview';
import { syncValidatorDecisions } from '@/lib/validator/validatorDecisionSync';
import { buildValidationSummary } from '@/lib/validator/shared';
import {
  blockerFindingCount,
  infoFindingCount,
  isBlockingFinding,
  normalizeValidationFinding,
  requiresReviewFindingCount,
  warningFindingCount,
} from '@/lib/validator/findingSemantics';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationStatus,
  ValidationTriggerSource,
  ValidatorResult,
} from '@/types/validator';

const RULE_VERSION = '1.0.0';
const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINANCIAL_MISSING_CONTRACT_RATE_RULE_ID = 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT';
const CROSS_DOCUMENT_MISSING_CONTRACT_RATE_RULE_ID = 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS';
const EXISTING_FINDING_CHECK_KEY_BATCH_SIZE = 25;
const CONTRACT_INTELLIGENCE_DECISION_PREFIX = 'contract_intelligence:';
const ACTIVE_CONTRACT_DECISION_STATUSES = ['open', 'in_review'] as const;
const CONTRACT_ISSUE_TYPE_BY_SUPPRESSED_ISSUE_ID: Record<string, string> = {
  activation_trigger_status_unresolved: 'conditional_without_trigger_status',
  pricing_applicability_requires_context: 'pricing_applicability_unclear',
  documentation_gate_unclear: 'documentation_prerequisite_unclear',
  fema_gate_ambiguous: 'fema_gate_ambiguous',
  'missing_required_clause:term_trigger': 'missing_required_clause',
  'missing_required_clause:activation_trigger': 'missing_required_clause',
};

type PersistableValidationFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

type ExistingOpenFindingRow = ValidationFinding & { id: string };

type HistoricalResolvedFindingRow = Pick<
  ValidationFinding,
  | 'id'
  | 'check_key'
  | 'rule_id'
  | 'subject_type'
  | 'subject_id'
  | 'field'
  | 'expected'
  | 'actual'
  | 'variance'
  | 'variance_unit'
  | 'status'
  | 'linked_decision_id'
> & {
  evidenceSignature: string;
};

type PersistedEvidenceRow = Pick<
  ValidationEvidence,
  | 'evidence_type'
  | 'source_document_id'
  | 'source_page'
  | 'fact_id'
  | 'record_id'
  | 'field_name'
  | 'field_value'
  | 'note'
>;

type ProjectValidationActivityContext = {
  id: string;
  organization_id: string;
  name: string | null;
  code: string | null;
};

type PreviousRunRow = {
  id: string;
};

type SuppressedContractIssue = {
  issue_id: string;
  reason: string;
};

type ExistingContractDecisionRow = {
  id: string;
  organization_id: string;
  project_id: string | null;
  document_id: string | null;
  decision_type: string;
  status: string | null;
  severity: string | null;
  details: Record<string, unknown> | null;
};

type HistoricalFindingIdentityRow = Pick<
  ValidationFinding,
  'check_key' | 'rule_id' | 'subject_id' | 'status'
>;

type ValidationFindingDiff = {
  new_findings: number;
  resolved_findings: number;
};

function requireAdminClient() {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error('Server validation client is not configured.');
  }

  return admin;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

export function extractUuidPrefix(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const firstSegment = value.split(':')[0]?.trim() ?? '';
  return UUID_PREFIX_PATTERN.test(firstSegment) ? firstSegment : null;
}

function firstSemanticAnchor(row: ValidationEvidence): string | null {
  for (const value of [row.fact_id, row.source_document_id, row.record_id]) {
    if (typeof value === 'string' && value.includes(':')) return value;
  }

  return null;
}

export function buildEvidenceInserts(
  findingId: string,
  evidence: readonly ValidationEvidence[],
) {
  return evidence.map((row) => {
    const semanticAnchor = firstSemanticAnchor(row);

    return {
      finding_id: findingId,
      evidence_type: row.evidence_type,
      source_document_id: extractUuidPrefix(row.source_document_id),
      source_page: row.source_page,
      fact_id: extractUuidPrefix(row.fact_id),
      record_id: row.record_id ?? semanticAnchor,
      field_name: row.field_name,
      field_value: row.field_value,
      note: row.note,
    };
  });
}

function summarizeFindings(findings: readonly ValidationFinding[]) {
  return {
    findings_count: findings.length,
    critical_count: blockerFindingCount(findings),
    warning_count: warningFindingCount(findings) + requiresReviewFindingCount(findings),
    info_count: infoFindingCount(findings),
  };
}

function deriveOperationalValidationStatus(params: {
  baseStatus: ValidationStatus;
  findings: readonly ValidationFinding[];
}): ValidationStatus {
  const openFindings = params.findings.filter((finding) => finding.status === 'open');

  if (openFindings.some((finding) => isBlockingFinding(finding))) {
    return 'BLOCKED';
  }

  if (openFindings.length > 0) {
    return 'FINDINGS_OPEN';
  }

  if (params.baseStatus === 'NOT_READY' && params.findings.length === 0) {
    return 'NOT_READY';
  }

  return 'VALIDATED';
}

function applyFindingRouting(
  finding: PersistableValidationFinding,
): PersistableValidationFinding {
  const routing = evaluateFindingRouting(finding);

  return {
    ...finding,
    decision_eligible: routing.decision_eligible,
    action_eligible: routing.action_eligible,
  };
}

function suppressOverlappingMissingContractRateFindings(
  findings: readonly PersistableValidationFinding[],
): PersistableValidationFinding[] {
  const subjectsWithCrossDocumentRate = new Set(
    findings
      .filter((finding) => finding.rule_id === CROSS_DOCUMENT_MISSING_CONTRACT_RATE_RULE_ID)
      .map((finding) => finding.subject_id),
  );

  return findings.filter((finding) => !(
    finding.rule_id === FINANCIAL_MISSING_CONTRACT_RATE_RULE_ID
    && subjectsWithCrossDocumentRate.has(finding.subject_id)
  ));
}

function findingIdentity(
  finding: Pick<ValidationFinding, 'check_key' | 'rule_id' | 'subject_id'>,
): string {
  const checkKey = finding.check_key.trim();
  return checkKey.length > 0 ? checkKey : `${finding.rule_id}:${finding.subject_id}`;
}

function normalizeSignatureText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function evidenceSignature(rows: readonly PersistedEvidenceRow[]): string {
  return JSON.stringify(
    rows
      .map((row) => ({
        evidence_type: normalizeSignatureText(row.evidence_type),
        source_document_id: normalizeSignatureText(row.source_document_id),
        source_page: row.source_page ?? null,
        fact_id: normalizeSignatureText(row.fact_id),
        record_id: normalizeSignatureText(row.record_id),
        field_name: normalizeSignatureText(row.field_name),
        field_value: normalizeSignatureText(row.field_value),
        note: normalizeSignatureText(row.note),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en-US')),
  );
}

function findingClearanceSignature(params: {
  projectId: string;
  finding: Pick<
    ValidationFinding,
    | 'check_key'
    | 'rule_id'
    | 'subject_type'
    | 'subject_id'
    | 'field'
    | 'expected'
    | 'actual'
    | 'variance'
    | 'variance_unit'
  >;
  evidenceSignature: string;
}): string {
  return JSON.stringify({
    project_id: params.projectId,
    check_key: normalizeSignatureText(params.finding.check_key),
    rule_id: normalizeSignatureText(params.finding.rule_id),
    subject_type: normalizeSignatureText(params.finding.subject_type),
    subject_id: normalizeSignatureText(params.finding.subject_id),
    field: normalizeSignatureText(params.finding.field),
    expected: normalizeSignatureText(params.finding.expected),
    actual: normalizeSignatureText(params.finding.actual),
    variance: params.finding.variance ?? null,
    variance_unit: normalizeSignatureText(params.finding.variance_unit),
    evidence: params.evidenceSignature,
  });
}

function currentFindingEvidenceSignature(finding: PersistableValidationFinding): string {
  return evidenceSignature(buildEvidenceInserts('00000000-0000-4000-8000-000000000000', finding.evidence ?? []));
}

function isSameClearedFinding(params: {
  projectId: string;
  finding: PersistableValidationFinding;
  historical: HistoricalResolvedFindingRow;
}): boolean {
  return findingClearanceSignature({
    projectId: params.projectId,
    finding: params.finding,
    evidenceSignature: currentFindingEvidenceSignature(params.finding),
  }) === findingClearanceSignature({
    projectId: params.projectId,
    finding: params.historical,
    evidenceSignature: params.historical.evidenceSignature,
  });
}

function openFindingIdentitySet(
  findings: readonly Pick<ValidationFinding, 'check_key' | 'rule_id' | 'subject_id' | 'status'>[],
): Set<string> {
  return new Set(
    findings
      .filter((finding) => finding.status === 'open')
      .map((finding) => findingIdentity(finding)),
  );
}

function diffFindings(params: {
  currentFindings: readonly PersistableValidationFinding[];
  previousFindings: readonly HistoricalFindingIdentityRow[];
}): ValidationFindingDiff {
  const currentIdentities = openFindingIdentitySet(params.currentFindings);
  const previousIdentities = openFindingIdentitySet(params.previousFindings);

  let newFindings = 0;
  for (const identity of currentIdentities) {
    if (!previousIdentities.has(identity)) {
      newFindings += 1;
    }
  }

  let resolvedFindings = 0;
  for (const identity of previousIdentities) {
    if (!currentIdentities.has(identity)) {
      resolvedFindings += 1;
    }
  }

  return {
    new_findings: newFindings,
    resolved_findings: resolvedFindings,
  };
}

async function insertRunRow(params: {
  projectId: string;
  triggerSource: ValidationTriggerSource;
  triggeredByUserId?: string;
  rulesApplied: string[];
  inputsSnapshotHash?: string | null;
}): Promise<string> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_runs')
    .insert({
      project_id: params.projectId,
      triggered_by: params.triggerSource,
      triggered_by_user_id: params.triggeredByUserId ?? null,
      rules_applied: params.rulesApplied,
      rule_version: RULE_VERSION,
      status: 'running',
      findings_count: 0,
      critical_count: 0,
      warning_count: 0,
      info_count: 0,
      inputs_snapshot_hash: params.inputsSnapshotHash ?? null,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`Failed to create validation run: ${error?.message ?? 'unknown error'}`);
  }

  return data.id;
}

async function loadProjectValidationActivityContext(
  projectId: string,
): Promise<ProjectValidationActivityContext> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('projects')
    .select('id, organization_id, name, code')
    .eq('id', projectId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load validation activity context for ${projectId}: ${error?.message ?? 'not found'}`);
  }

  return data as ProjectValidationActivityContext;
}

async function loadPreviousCompletedRun(
  projectId: string,
): Promise<PreviousRunRow | null> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_runs')
    .select('id')
    .eq('project_id', projectId)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load previous validation run for ${projectId}: ${error.message}`);
  }

  return (data ?? null) as PreviousRunRow | null;
}

async function loadRunFindingIdentities(
  runId: string,
): Promise<HistoricalFindingIdentityRow[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_findings')
    .select('check_key, rule_id, subject_id, status')
    .eq('run_id', runId);

  if (error) {
    throw new Error(`Failed to load validation findings for run ${runId}: ${error.message}`);
  }

  return (data ?? []) as HistoricalFindingIdentityRow[];
}

async function loadExistingOpenFindings(
  projectId: string,
  checkKeys: readonly string[],
): Promise<Map<string, ExistingOpenFindingRow>> {
  if (checkKeys.length === 0) {
    return new Map<string, ExistingOpenFindingRow>();
  }

  const admin = requireAdminClient();
  const findingsByCheckKey = new Map<string, ExistingOpenFindingRow>();
  const uniqueCheckKeys = Array.from(new Set(checkKeys));

  for (let index = 0; index < uniqueCheckKeys.length; index += EXISTING_FINDING_CHECK_KEY_BATCH_SIZE) {
    const batch = uniqueCheckKeys.slice(index, index + EXISTING_FINDING_CHECK_KEY_BATCH_SIZE);
    const { data, error } = await admin
      .from('project_validation_findings')
      .select('*')
      .eq('project_id', projectId)
      .eq('status', 'open')
      .in('check_key', batch)
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to load existing validation findings: ${error.message}`);
    }

    for (const row of (data ?? []) as ExistingOpenFindingRow[]) {
      if (!findingsByCheckKey.has(row.check_key)) {
        findingsByCheckKey.set(row.check_key, row);
      }
    }
  }

  return findingsByCheckKey;
}

async function loadHistoricalResolvedFindings(
  projectId: string,
  checkKeys: readonly string[],
): Promise<Map<string, HistoricalResolvedFindingRow[]>> {
  if (checkKeys.length === 0) {
    return new Map<string, HistoricalResolvedFindingRow[]>();
  }

  const admin = requireAdminClient();
  const findingsByCheckKey = new Map<string, HistoricalResolvedFindingRow[]>();
  const uniqueCheckKeys = Array.from(new Set(checkKeys));

  for (let index = 0; index < uniqueCheckKeys.length; index += EXISTING_FINDING_CHECK_KEY_BATCH_SIZE) {
    const batch = uniqueCheckKeys.slice(index, index + EXISTING_FINDING_CHECK_KEY_BATCH_SIZE);
    const { data, error } = await admin
      .from('project_validation_findings')
      .select('id, check_key, rule_id, subject_type, subject_id, field, expected, actual, variance, variance_unit, status, linked_decision_id, resolved_at')
      .eq('project_id', projectId)
      .in('status', ['resolved', 'dismissed'])
      .in('check_key', batch)
      .order('resolved_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to load resolved validation findings: ${error.message}`);
    }

    const rows = (data ?? []) as Array<Omit<HistoricalResolvedFindingRow, 'evidenceSignature'>>;
    if (rows.length === 0) continue;

    const { data: evidenceRows, error: evidenceError } = await admin
      .from('project_validation_evidence')
      .select('finding_id, evidence_type, source_document_id, source_page, fact_id, record_id, field_name, field_value, note')
      .in('finding_id', rows.map((row) => row.id));

    if (evidenceError) {
      throw new Error(`Failed to load resolved validation evidence: ${evidenceError.message}`);
    }

    const evidenceByFindingId = new Map<string, PersistedEvidenceRow[]>();
    for (const row of (evidenceRows ?? []) as Array<PersistedEvidenceRow & { finding_id: string }>) {
      const rowsForFinding = evidenceByFindingId.get(row.finding_id) ?? [];
      rowsForFinding.push(row);
      evidenceByFindingId.set(row.finding_id, rowsForFinding);
    }

    for (const row of rows) {
      const historicalRow: HistoricalResolvedFindingRow = {
        ...row,
        evidenceSignature: evidenceSignature(evidenceByFindingId.get(row.id) ?? []),
      };
      const rowsForCheckKey = findingsByCheckKey.get(row.check_key) ?? [];
      rowsForCheckKey.push(historicalRow);
      findingsByCheckKey.set(row.check_key, rowsForCheckKey);
    }
  }

  return findingsByCheckKey;
}

async function loadAllExistingOpenFindings(
  projectId: string,
): Promise<ExistingOpenFindingRow[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_findings')
    .select('*')
    .eq('project_id', projectId)
    .eq('status', 'open');

  if (error) {
    throw new Error(`Failed to load open validation findings for ${projectId}: ${error.message}`);
  }

  return (data ?? []) as ExistingOpenFindingRow[];
}

async function insertFindingEvidence(
  findingId: string,
  evidence: readonly ValidationEvidence[],
): Promise<void> {
  if (evidence.length === 0) {
    return;
  }

  const admin = requireAdminClient();
  const { error } = await admin
    .from('project_validation_evidence')
    .insert(buildEvidenceInserts(findingId, evidence));

  if (error) {
    throw new Error(`Failed to persist validation evidence for finding ${findingId}: ${error.message}`);
  }
}

async function replaceFindingEvidence(
  findingId: string,
  evidence: readonly ValidationEvidence[],
): Promise<void> {
  const admin = requireAdminClient();

  const { error: deleteError } = await admin
    .from('project_validation_evidence')
    .delete()
    .eq('finding_id', findingId);

  if (deleteError) {
    throw new Error(`Failed to clear validation evidence for finding ${findingId}: ${deleteError.message}`);
  }

  await insertFindingEvidence(findingId, evidence);
}

async function persistFinding(params: {
  runId: string;
  projectId: string;
  finding: PersistableValidationFinding;
  existingOpenFindingId?: string;
}): Promise<string> {
  const admin = requireAdminClient();
  const now = new Date().toISOString();

  if (params.existingOpenFindingId) {
    const { error } = await admin
      .from('project_validation_findings')
      .update({
        run_id: params.runId,
        category: params.finding.category,
        severity: params.finding.severity,
        field: params.finding.field,
        expected: params.finding.expected,
        actual: params.finding.actual,
        variance: params.finding.variance,
        variance_unit: params.finding.variance_unit,
        blocked_reason: params.finding.blocked_reason,
        decision_eligible: params.finding.decision_eligible,
        action_eligible: params.finding.action_eligible,
        updated_at: now,
      })
      .eq('id', params.existingOpenFindingId);

    if (error) {
      throw new Error(`Failed to update validation finding ${params.existingOpenFindingId}: ${error.message}`);
    }

    await replaceFindingEvidence(
      params.existingOpenFindingId,
      params.finding.evidence ?? [],
    );

    return params.existingOpenFindingId;
  }

  const { data, error } = await admin
    .from('project_validation_findings')
    .insert({
      run_id: params.runId,
      project_id: params.projectId,
      rule_id: params.finding.rule_id,
      check_key: params.finding.check_key,
      category: params.finding.category,
      severity: params.finding.severity,
      status: params.finding.status,
      subject_type: params.finding.subject_type,
      subject_id: params.finding.subject_id,
      field: params.finding.field,
      expected: params.finding.expected,
      actual: params.finding.actual,
      variance: params.finding.variance,
      variance_unit: params.finding.variance_unit,
      blocked_reason: params.finding.blocked_reason,
      decision_eligible: params.finding.decision_eligible,
      action_eligible: params.finding.action_eligible,
      linked_decision_id: params.finding.linked_decision_id,
      linked_action_id: params.finding.linked_action_id,
      resolved_by_user_id: params.finding.resolved_by_user_id,
      resolved_at: params.finding.resolved_at,
    })
    .select('id')
    .single();

  if (error || !data?.id) {
    throw new Error(`Failed to insert validation finding ${params.finding.check_key}: ${error?.message ?? 'unknown error'}`);
  }

  await insertFindingEvidence(data.id, params.finding.evidence ?? []);

  return data.id;
}

async function markStaleOpenFindingsResolved(params: {
  project: ProjectValidationActivityContext;
  projectId: string;
  currentOpenCheckKeys: Set<string>;
  actorId?: string;
  runId: string;
}) {
  const admin = requireAdminClient();
  const existingOpenFindings = await loadAllExistingOpenFindings(params.projectId);
  const staleFindingIds = existingOpenFindings
    .filter((finding) => !params.currentOpenCheckKeys.has(finding.check_key))
    .map((finding) => finding.id);

  if (staleFindingIds.length === 0) return;

  const now = new Date().toISOString();
  const { data: transitionedRows, error } = await admin
    .from('project_validation_findings')
    .update({
      status: 'resolved',
      resolved_by_user_id: params.actorId ?? null,
      resolved_at: now,
      updated_at: now,
    })
    .in('id', staleFindingIds)
    .eq('status', 'open')
    .select('id');

  if (error) {
    throw new Error(`Failed to resolve stale validation findings for ${params.projectId}: ${error.message}`);
  }

  const transitionedIds = new Set(
    ((transitionedRows ?? []) as Array<{ id: string }>).map((row) => row.id),
  );
  for (const finding of existingOpenFindings.filter((row) => transitionedIds.has(row.id))) {
    const activityResult = await emitValidationFindingLifecycleActivity({
      organizationId: params.project.organization_id,
      projectId: params.projectId,
      findingId: finding.id,
      changedBy: params.actorId,
      previousFinding: finding,
      currentFinding: {
        ...finding,
        status: 'resolved',
        resolved_by_user_id: params.actorId ?? null,
        resolved_at: now,
        updated_at: now,
      },
      runId: params.runId,
    });
    if (!activityResult.ok) {
      console.error('[persistValidationRun] failed to log validation finding lifecycle event', {
        projectId: params.projectId,
        findingId: finding.id,
        error: activityResult.error,
      });
    }
  }
}

function localDecisionIdForSuppressedIssue(issueId: string): string {
  return `contract:intelligence:${issueId}`;
}

function decisionTypeForSuppressedIssue(issueId: string): string | null {
  const issueType = CONTRACT_ISSUE_TYPE_BY_SUPPRESSED_ISSUE_ID[issueId];
  return issueType ? `${CONTRACT_INTELLIGENCE_DECISION_PREFIX}${issueType}` : null;
}

function suppressedContractIssuesFromResult(result: ValidatorResult): {
  documentId: string | null;
  suppressedIssues: SuppressedContractIssue[];
} {
  const context = asRecord(result.summary.contract_validation_context);
  const documentId = asString(context?.document_id);
  const analysis = asRecord(context?.analysis);
  const traceSummary = asRecord(analysis?.trace_summary);
  const suppressed = Array.isArray(traceSummary?.suppressed_issues)
    ? traceSummary.suppressed_issues
    : [];

  return {
    documentId,
    suppressedIssues: suppressed
      .map((issue): SuppressedContractIssue | null => {
        const row = asRecord(issue);
        const issueId = asString(row?.issue_id);
        const reason = asString(row?.reason);
        return issueId && reason ? { issue_id: issueId, reason } : null;
      })
      .filter((issue): issue is SuppressedContractIssue => issue != null),
  };
}

function contractDecisionMatchesSuppressedIssue(
  decision: ExistingContractDecisionRow,
  issue: SuppressedContractIssue,
): boolean {
  const expectedDecisionType = decisionTypeForSuppressedIssue(issue.issue_id);
  if (!expectedDecisionType) return false;

  const details = asRecord(decision.details);
  const normalizedDecision = asRecord(details?.normalized_decision);
  const normalizedDecisionId = asString(normalizedDecision?.id);
  const expectedLocalDecisionId = localDecisionIdForSuppressedIssue(issue.issue_id);
  if (normalizedDecisionId) {
    return normalizedDecisionId === expectedLocalDecisionId;
  }

  const detailsRuleId = asString(details?.rule_id);
  if (expectedDecisionType.endsWith(':missing_required_clause')) {
    return false;
  }

  return decision.decision_type === expectedDecisionType || detailsRuleId === expectedDecisionType;
}

async function closeSuppressedContractDecisions(params: {
  project: ProjectValidationActivityContext;
  projectId: string;
  result: ValidatorResult;
  actorId?: string;
}): Promise<number> {
  const actorId = params.actorId;
  if (!actorId) return 0;

  const { documentId, suppressedIssues } = suppressedContractIssuesFromResult(params.result);
  if (!documentId || suppressedIssues.length === 0) return 0;

  const relevantIssues = suppressedIssues.filter((issue) =>
    decisionTypeForSuppressedIssue(issue.issue_id) != null,
  );
  if (relevantIssues.length === 0) return 0;

  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('decisions')
    .select('id, organization_id, project_id, document_id, decision_type, status, severity, details')
    .eq('organization_id', params.project.organization_id)
    .eq('project_id', params.projectId)
    .eq('document_id', documentId)
    .in('status', [...ACTIVE_CONTRACT_DECISION_STATUSES]);

  if (error) {
    throw new Error(`Failed to load active contract intelligence decisions for ${documentId}: ${error.message}`);
  }

  const decisions = (data ?? []) as ExistingContractDecisionRow[];
  const closedDecisionIds = new Set<string>();
  let closed = 0;

  for (const issue of relevantIssues) {
    const decision = decisions.find((row) =>
      !closedDecisionIds.has(row.id) && contractDecisionMatchesSuppressedIssue(row, issue),
    );
    if (!decision) continue;

    try {
      await finalizeDecision({
        admin,
        decision: {
          id: decision.id,
          organization_id: decision.organization_id,
          project_id: decision.project_id,
          document_id: decision.document_id,
          status: decision.status,
          severity: decision.severity,
        },
        organizationId: params.project.organization_id,
        actorId,
        status: 'dismissed',
        operatorAction: issue.reason,
        writeLegacyFeedback: false,
      });
      closedDecisionIds.add(decision.id);
      closed += 1;
    } catch (err) {
      console.error('[closeSuppressedContractDecisions] failed to close decision', {
        decisionId: decision.id,
        issueId: issue.issue_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return closed;
}

async function markRunComplete(
  runId: string,
  findings: readonly ValidationFinding[],
): Promise<void> {
  const admin = requireAdminClient();
  const summary = summarizeFindings(findings);
  const { error } = await admin
    .from('project_validation_runs')
    .update({
      status: 'complete',
      findings_count: summary.findings_count,
      critical_count: summary.critical_count,
      warning_count: summary.warning_count,
      info_count: summary.info_count,
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);

  if (error) {
    throw new Error(`Failed to finalize validation run ${runId}: ${error.message}`);
  }
}

async function createValidationRunActivityEvent(params: {
  project: ProjectValidationActivityContext;
  runId: string;
  triggerSource: ValidationTriggerSource;
  triggeredByUserId?: string;
  result: ValidatorResult;
  findingSummary: ReturnType<typeof summarizeFindings>;
  findingDiff: ValidationFindingDiff;
}): Promise<void> {
  const actorType = params.triggerSource === 'manual' ? 'user' : 'system';
  const activityResult = await logActivityEvent({
    organization_id: params.project.organization_id,
    project_id: params.project.id,
    entity_type: 'project_validation_run',
    entity_id: params.runId,
    event_type: 'validation_run_completed',
    changed_by: params.triggeredByUserId ?? null,
    new_value: {
      actor_type: actorType,
      status: params.result.status,
      critical_count: params.findingSummary.critical_count,
      warning_count: params.findingSummary.warning_count,
      info_count: params.findingSummary.info_count,
      new_findings: params.findingDiff.new_findings,
      resolved_findings: params.findingDiff.resolved_findings,
      rules_applied: params.result.rulesApplied,
      rule_version: RULE_VERSION,
    },
  });

  if (!activityResult.ok) {
    throw new Error(`Failed to create validation activity event: ${activityResult.error}`);
  }
}

async function createValidationFindingGeneratedActivityEvent(params: {
  project: ProjectValidationActivityContext;
  findingId: string;
  finding: PersistableValidationFinding;
  changedBy: string | undefined;
}) {
  const normalized = normalizeValidationFinding(params.finding);
  const result = await logActivityEvent({
    organization_id: params.project.organization_id,
    project_id: params.project.id,
    entity_type: 'project_validation_finding',
    entity_id: params.findingId,
    event_type: 'validation_finding_generated',
    changed_by: params.changedBy ?? null,
    old_value: null,
    new_value: {
      check_key: params.finding.check_key,
      rule_id: params.finding.rule_id,
      severity: params.finding.severity,
      status: params.finding.status,
      problem: normalized.problem ?? null,
      impact: normalized.impact ?? null,
      required_action: normalized.required_action ?? null,
    },
  });

  if (!result.ok) {
    console.error('[persistValidationRun] failed to log validation finding event', {
      projectId: params.project.id,
      findingId: params.findingId,
      error: result.error,
    });
  }
}

async function updateProjectValidationState(
  projectId: string,
  result: ValidatorResult,
): Promise<void> {
  const admin = requireAdminClient();
  const { error } = await admin
    .from('projects')
    .update({
      validation_status: result.status,
      validation_summary_json: result.summary,
    })
    .eq('id', projectId);

  if (error) {
    throw new Error(`Failed to update project validation state for ${projectId}: ${error.message}`);
  }
}

function applyExecutionItemLinksToFindings(params: {
  findings: readonly PersistableValidationFinding[];
  executionItemIdsBySourceKey: ReadonlyMap<string, string>;
}): PersistableValidationFinding[] {
  return params.findings.map((finding) => ({
    ...finding,
    linked_action_id:
      params.executionItemIdsBySourceKey.get(finding.check_key)
      ?? finding.linked_action_id
      ?? null,
  }));
}

function buildEffectivePersistedFindings(params: {
  findings: readonly PersistableValidationFinding[];
  suppressedFindingIds: ReadonlySet<string>;
  executionItemIdsBySourceKey: ReadonlyMap<string, string>;
}): PersistableValidationFinding[] {
  return applyExecutionItemLinksToFindings({
    findings: params.findings,
    executionItemIdsBySourceKey: params.executionItemIdsBySourceKey,
  }).filter((finding) => !params.suppressedFindingIds.has(finding.id));
}

function buildEffectiveValidatorResult(params: {
  result: ValidatorResult;
  findings: readonly PersistableValidationFinding[];
  triggerSource: ValidationTriggerSource;
}): ValidatorResult {
  const status = deriveOperationalValidationStatus({
    baseStatus: params.result.status,
    findings: params.findings,
  });
  const summary = buildValidationSummary(params.findings, status, {
    contractInvoiceReconciliation:
      params.result.summary.contract_invoice_reconciliation
      ?? params.result.contract_invoice_reconciliation
      ?? null,
    invoiceTransactionReconciliation:
      params.result.summary.invoice_transaction_reconciliation
      ?? params.result.invoice_transaction_reconciliation
      ?? null,
    crossDocumentRateVerification:
      params.result.summary.cross_document_rate_verification
      ?? params.result.cross_document_rate_verification
      ?? null,
    reconciliation:
      params.result.summary.reconciliation
      ?? params.result.reconciliation
      ?? null,
    exposure:
      params.result.summary.exposure
      ?? params.result.exposure
      ?? null,
    nte_amount: params.result.summary.nte_amount ?? null,
    total_billed:
      params.result.summary.total_billed
      ?? params.result.exposure?.total_billed_amount
      ?? null,
    contractDocumentId: params.result.summary.contract_document_id ?? null,
    contractValidationContext:
      (params.result.summary.contract_validation_context as never) ?? null,
    validationPhase: params.result.summary.validation_phase ?? null,
  });

  return {
    ...params.result,
    status,
    blocked_reasons: summary.blocked_reasons,
    findings: [...params.findings],
    summary: {
      ...params.result.summary,
      ...summary,
      last_run_at:
        params.result.summary.last_run_at
        ?? new Date().toISOString(),
      trigger_source: params.triggerSource,
    },
    validator_status: summary.validator_status,
    validator_open_items: summary.validator_open_items,
    validator_blockers: summary.validator_blockers,
  };
}

async function markRunFailed(runId: string): Promise<void> {
  const admin = requireAdminClient();
  const { error } = await admin
    .from('project_validation_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', runId);

  if (error) {
    console.error('[persistValidationRun] failed to mark run as failed', {
      runId,
      error: error.message,
    });
  }
}

function logValidationSideEffectFailure(
  sideEffect: string,
  context: {
    projectId: string;
    runId: string;
  },
  error: unknown,
) {
  console.error('[persistValidationRun] non-core side effect failed', {
    ...context,
    sideEffect,
    error,
  });
}

async function runValidationSideEffect(
  sideEffect: string,
  context: {
    projectId: string;
    runId: string;
  },
  action: () => Promise<void>,
) {
  try {
    await action();
  } catch (error) {
    logValidationSideEffectFailure(sideEffect, context, error);
  }
}

export async function persistValidationRun(
  projectId: string,
  result: ValidatorResult,
  triggerSource: ValidationTriggerSource,
  triggeredByUserId?: string,
  inputsSnapshotHash?: string | null,
): Promise<{ runId: string }> {
  const findings = suppressOverlappingMissingContractRateFindings(
    (result.findings as PersistableValidationFinding[]).map(applyFindingRouting),
  );
  const persistedFindings: PersistableValidationFinding[] = [];
  let runId: string | null = null;

  try {
    const project = await loadProjectValidationActivityContext(projectId);
    const previousCompletedRun = await loadPreviousCompletedRun(projectId);
    const previousFindings = previousCompletedRun
      ? await loadRunFindingIdentities(previousCompletedRun.id)
      : [];

    runId = await insertRunRow({
      projectId,
      triggerSource,
      triggeredByUserId,
      rulesApplied: result.rulesApplied,
      inputsSnapshotHash: inputsSnapshotHash ?? null,
    });

    const existingOpenFindings = await loadExistingOpenFindings(
      projectId,
      findings.map((finding) => finding.check_key),
    );
    const historicalResolvedFindings = await loadHistoricalResolvedFindings(
      projectId,
      findings.map((finding) => finding.check_key),
    );

    for (const finding of findings) {
      const matchingResolvedFinding = finding.status === 'open'
        ? historicalResolvedFindings
          .get(finding.check_key)
          ?.find((historical) => isSameClearedFinding({
            projectId,
            finding,
            historical,
          }))
        : null;
      if (matchingResolvedFinding) {
        continue;
      }

      const existingOpenFinding =
        finding.status === 'open'
          ? existingOpenFindings.get(finding.check_key)
          : undefined;
      const existingOpenFindingId = existingOpenFinding?.id;

      const persistedFindingId = await persistFinding({
        runId,
        projectId,
        finding,
        existingOpenFindingId,
      });

      if (finding.status === 'open') {
        existingOpenFindings.set(finding.check_key, {
          ...finding,
          id: persistedFindingId,
        });

        if (!existingOpenFindingId) {
          await createValidationFindingGeneratedActivityEvent({
            project,
            findingId: persistedFindingId,
            finding,
            changedBy: triggeredByUserId,
          });
        }

        if (existingOpenFinding) {
          const activityResult = await emitValidationFindingLifecycleActivity({
            organizationId: project.organization_id,
            projectId,
            findingId: persistedFindingId,
            changedBy: triggeredByUserId,
            previousFinding: existingOpenFinding,
            currentFinding: finding,
            runId,
          });
          if (!activityResult.ok) {
            console.error('[persistValidationRun] failed to log validation finding lifecycle event', {
              projectId,
              findingId: persistedFindingId,
              error: activityResult.error,
            });
          }
        }
      }

      persistedFindings.push({
        ...finding,
        id: persistedFindingId,
      });
    }

    const effectivePersistedFindings = buildEffectivePersistedFindings({
      findings: persistedFindings,
      suppressedFindingIds: new Set<string>(),
      executionItemIdsBySourceKey: new Map<string, string>(),
    });
    const effectiveResult = buildEffectiveValidatorResult({
      result,
      findings: effectivePersistedFindings,
      triggerSource,
    });
    const currentOpenCheckKeys = new Set(
      effectivePersistedFindings
        .filter((finding) => finding.status === 'open')
        .map((finding) => finding.check_key),
    );
    const findingSummary = summarizeFindings(effectivePersistedFindings);
    const findingDiff = diffFindings({
      currentFindings: effectivePersistedFindings,
      previousFindings,
    });

    await markStaleOpenFindingsResolved({
      project,
      projectId,
      currentOpenCheckKeys,
      actorId: triggeredByUserId,
      runId,
    });
    await closeSuppressedContractDecisions({
      project,
      projectId,
      result: effectiveResult,
      actorId: triggeredByUserId,
    });

    await markRunComplete(runId, effectivePersistedFindings);
    await updateProjectValidationState(projectId, effectiveResult);

    const completedRunId = runId;
    const sideEffectContext = { projectId, runId: completedRunId };

    await runValidationSideEffect('syncExecutionItems', sideEffectContext, async () => {
      const executionItemSync = await syncExecutionItems({
        admin: requireAdminClient(),
        projectId,
        organizationId: project.organization_id,
        runId: completedRunId,
        actorId: triggeredByUserId,
        findings: persistedFindings,
      });

      if (executionItemSync.executionItemIdsBySourceKey.size === 0) return;

      const linkedFindings = applyExecutionItemLinksToFindings({
        findings: persistedFindings,
        executionItemIdsBySourceKey: executionItemSync.executionItemIdsBySourceKey,
      });

      for (const finding of linkedFindings) {
        if (!finding.id || !finding.linked_action_id) continue;

        const { error } = await requireAdminClient()
          .from('project_validation_findings')
          .update({ linked_action_id: finding.linked_action_id })
          .eq('id', finding.id);

        if (error) {
          throw new Error(`Failed to link execution item for finding ${finding.check_key}: ${error.message}`);
        }
      }
    });

    await runValidationSideEffect('syncValidatorDecisions', sideEffectContext, async () => {
      await syncValidatorDecisions({
        admin: requireAdminClient(),
        projectId,
        organizationId: project.organization_id,
        projectContext: {
          label: project.name ?? project.code ?? project.id,
          project_id: project.id,
          project_code: project.code ?? null,
        },
        runId: completedRunId,
        result: effectiveResult,
        findings: effectivePersistedFindings,
      });
    });

    await runValidationSideEffect('createValidationRunActivityEvent', sideEffectContext, async () => {
      await createValidationRunActivityEvent({
        project,
        runId: completedRunId,
        triggerSource,
        triggeredByUserId,
        result: effectiveResult,
        findingSummary,
        findingDiff,
      });
    });

    // Persist approval snapshot for audit trail (Phase 6)
    // Construct a minimal ProjectOperationalRollup from validation findings
    const rollupStatus = {
      label: effectiveResult.status === 'VALIDATED' ? 'Approved' :
             effectiveResult.status === 'BLOCKED' ? 'Blocked' :
             effectiveResult.status === 'FINDINGS_OPEN' ? 'Needs Review' : 'Not Evaluated',
    };

    const pendingActions = effectivePersistedFindings
      .filter((f) => f.decision_eligible && f.status === 'open')
      .map((f, index) => {
        const normalized = normalizeValidationFinding(f);
        return ({
        id: `finding-${f.check_key}`,
        title: normalized.problem || f.blocked_reason || f.category,
        description: normalized.impact || (f.actual ? `Expected: ${f.expected}, Actual: ${f.actual}` : f.category),
        status_label: isBlockingFinding(f) ? 'Blocked' : 'Needs Review',
        due_tone: isBlockingFinding(f) ? 'danger' : 'warning',
        impacted_amount: normalized.affected_amount ?? null,
        at_risk_amount: normalized.affected_amount ?? null,
        blocked_amount: null,
        next_step: normalized.required_action || `Review finding: ${f.check_key}`,
        href: `/platform/projects/${projectId}#validator`,
        invoice_number: null,
        approval_status: null,
        decision_id: f.rule_id || f.check_key,
        entity_type: 'finding',
        index,
      })});

    const rollup = {
      status: rollupStatus,
      project_clear: effectiveResult.status === 'VALIDATED',
      pending_actions: pendingActions,
      needs_review_document_count: 0,
      unresolved_finding_count: effectivePersistedFindings.filter((f) => f.status === 'open').length,
      blocked_count: effectivePersistedFindings.filter((f) => f.status === 'open' && isBlockingFinding(f)).length,
      open_document_action_count: 0,
    };

    let approvalSnapshot: Awaited<ReturnType<typeof persistApprovalSnapshot>> | null = null;
    await runValidationSideEffect('persistApprovalSnapshot', sideEffectContext, async () => {
      approvalSnapshot = await persistApprovalSnapshot(
        projectId,
        (effectiveResult.summary as unknown as ProjectValidatorSummarySnapshot) || null,
        (rollup as unknown as ProjectOperationalRollup),
      );
    });

    // Phase 10: Execute operator graph actions from approval decision
    // Run after snapshot persists so executeApprovalActions can use the fresh snapshot.
    // Non-blocking: action execution failure must not fail the validation run.
    await runValidationSideEffect('executeApprovalActions', sideEffectContext, async () => {
      const actionResult = await executeApprovalActions({
        projectId,
        organizationId: project.organization_id,
        // Pass snapshot directly to avoid a redundant DB query
        snapshot: approvalSnapshot,
      });

      if (actionResult.errors.length > 0) {
        console.warn('[persistValidationRun] approval action engine completed with errors', {
          projectId,
          runId: completedRunId,
          errors: actionResult.errors,
        });
      } else {
        console.info('[persistValidationRun] approval actions executed', {
          projectId,
          runId: completedRunId,
          approval_status: actionResult.approval_status,
          tasks_created: actionResult.tasks_created,
          tasks_updated: actionResult.tasks_updated,
        });
      }
    });
      // Never throw — action execution is a side effect, not part of validation correctness
    return { runId };
  } catch (error) {
    if (runId) {
      await markRunFailed(runId);
    }

    console.error('[persistValidationRun] persistence failed', {
      projectId,
      runId,
      triggerSource,
      error,
    });

    throw error;
  }
}
