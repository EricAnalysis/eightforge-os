import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { syncExecutionItems } from '@/lib/execution/syncExecutionItems';
import { evaluateFindingRouting } from '@/lib/validator/validatorRouting';
import { persistApprovalSnapshot } from '@/lib/server/approvalSnapshots';
import { executeApprovalActions } from '@/lib/server/approvalActionEngine';
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

type PersistableValidationFinding = ValidationFinding & {
  evidence?: ValidationEvidence[];
};

type ExistingOpenFindingRow = {
  id: string;
  check_key: string;
};

type ExistingOpenFindingStatusRow = Pick<
  ValidationFinding,
  'id' | 'check_key' | 'status'
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

function buildEvidenceInserts(
  findingId: string,
  evidence: readonly ValidationEvidence[],
) {
  return evidence.map((row) => ({
    finding_id: findingId,
    evidence_type: row.evidence_type,
    source_document_id: row.source_document_id,
    source_page: row.source_page,
    fact_id: row.fact_id,
    record_id: row.record_id,
    field_name: row.field_name,
    field_value: row.field_value,
    note: row.note,
  }));
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

function findingIdentity(
  finding: Pick<ValidationFinding, 'check_key' | 'rule_id' | 'subject_id'>,
): string {
  const checkKey = finding.check_key.trim();
  return checkKey.length > 0 ? checkKey : `${finding.rule_id}:${finding.subject_id}`;
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
  const uniqueCheckKeys = Array.from(new Set(checkKeys));
  const { data, error } = await admin
    .from('project_validation_findings')
    .select('id, check_key')
    .eq('project_id', projectId)
    .eq('status', 'open')
    .in('check_key', uniqueCheckKeys)
    .order('updated_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load existing validation findings: ${error.message}`);
  }

  const findingsByCheckKey = new Map<string, ExistingOpenFindingRow>();
  for (const row of (data ?? []) as ExistingOpenFindingRow[]) {
    if (!findingsByCheckKey.has(row.check_key)) {
      findingsByCheckKey.set(row.check_key, row);
    }
  }

  return findingsByCheckKey;
}

async function loadAllExistingOpenFindings(
  projectId: string,
): Promise<ExistingOpenFindingStatusRow[]> {
  const admin = requireAdminClient();
  const { data, error } = await admin
    .from('project_validation_findings')
    .select('id, check_key, status')
    .eq('project_id', projectId)
    .eq('status', 'open');

  if (error) {
    throw new Error(`Failed to load open validation findings for ${projectId}: ${error.message}`);
  }

  return (data ?? []) as ExistingOpenFindingStatusRow[];
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
  projectId: string;
  currentOpenCheckKeys: Set<string>;
  actorId?: string;
}) {
  const admin = requireAdminClient();
  const existingOpenFindings = await loadAllExistingOpenFindings(params.projectId);
  const staleFindingIds = existingOpenFindings
    .filter((finding) => !params.currentOpenCheckKeys.has(finding.check_key))
    .map((finding) => finding.id);

  if (staleFindingIds.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await admin
    .from('project_validation_findings')
    .update({
      status: 'resolved',
      resolved_by_user_id: params.actorId ?? null,
      resolved_at: now,
      updated_at: now,
    })
    .in('id', staleFindingIds);

  if (error) {
    throw new Error(`Failed to resolve stale validation findings for ${params.projectId}: ${error.message}`);
  }
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

export async function persistValidationRun(
  projectId: string,
  result: ValidatorResult,
  triggerSource: ValidationTriggerSource,
  triggeredByUserId?: string,
  inputsSnapshotHash?: string | null,
): Promise<{ runId: string }> {
  const findings = (result.findings as PersistableValidationFinding[]).map(applyFindingRouting);
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

    for (const finding of findings) {
      const existingOpenFindingId =
        finding.status === 'open'
          ? existingOpenFindings.get(finding.check_key)?.id
          : undefined;

      const persistedFindingId = await persistFinding({
        runId,
        projectId,
        finding,
        existingOpenFindingId,
      });

      if (finding.status === 'open') {
        existingOpenFindings.set(finding.check_key, {
          id: persistedFindingId,
          check_key: finding.check_key,
        });

        if (!existingOpenFindingId) {
          await createValidationFindingGeneratedActivityEvent({
            project,
            findingId: persistedFindingId,
            finding,
            changedBy: triggeredByUserId,
          });
        }
      }

      persistedFindings.push({
        ...finding,
        id: persistedFindingId,
      });
    }

    const executionItemSync = await syncExecutionItems({
      admin: requireAdminClient(),
      projectId,
      organizationId: project.organization_id,
      actorId: triggeredByUserId,
      findings: persistedFindings,
    });
    const effectivePersistedFindings = buildEffectivePersistedFindings({
      findings: persistedFindings,
      suppressedFindingIds: executionItemSync.suppressedFindingIds,
      executionItemIdsBySourceKey: executionItemSync.executionItemIdsBySourceKey,
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
      projectId,
      currentOpenCheckKeys,
      actorId: triggeredByUserId,
    });

    await markRunComplete(runId, effectivePersistedFindings);
    await syncValidatorDecisions({
      admin: requireAdminClient(),
      projectId,
      organizationId: project.organization_id,
      projectContext: {
        label: project.name ?? project.code ?? project.id,
        project_id: project.id,
        project_code: project.code ?? null,
      },
      runId,
      result: effectiveResult,
      findings: effectivePersistedFindings,
    });
    await createValidationRunActivityEvent({
      project,
      runId,
      triggerSource,
      triggeredByUserId,
      result: effectiveResult,
      findingSummary,
      findingDiff,
    });
    await updateProjectValidationState(projectId, effectiveResult);

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

    let approvalSnapshot = null;
    try {
      approvalSnapshot = await persistApprovalSnapshot(
        projectId,
        (effectiveResult.summary as unknown as ProjectValidatorSummarySnapshot) || null,
        (rollup as unknown as ProjectOperationalRollup),
      );
    } catch (snapshotError) {
      console.error('[persistValidationRun] failed to persist approval snapshot', {
        projectId,
        runId,
        error: snapshotError,
      });
      // Don't throw - snapshot failure shouldn't block validation completion
    }

    // Phase 10: Execute operator graph actions from approval decision
    // Run after snapshot persists so executeApprovalActions can use the fresh snapshot.
    // Non-blocking: action execution failure must not fail the validation run.
    try {
      const actionResult = await executeApprovalActions({
        projectId,
        organizationId: project.organization_id,
        // Pass snapshot directly to avoid a redundant DB query
        snapshot: approvalSnapshot,
      });

      if (actionResult.errors.length > 0) {
        console.warn('[persistValidationRun] approval action engine completed with errors', {
          projectId,
          runId,
          errors: actionResult.errors,
        });
      } else {
        console.info('[persistValidationRun] approval actions executed', {
          projectId,
          runId,
          approval_status: actionResult.approval_status,
          tasks_created: actionResult.tasks_created,
          tasks_updated: actionResult.tasks_updated,
        });
      }
    } catch (actionError) {
      console.error('[persistValidationRun] approval action engine threw unexpectedly', {
        projectId,
        runId,
        error: actionError,
      });
      // Never throw — action execution is a side effect, not part of validation correctness
    }

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
