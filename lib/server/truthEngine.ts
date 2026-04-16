/**
 * lib/server/truthEngine.ts
 *
 * Query-to-truth engine.
 * Takes a typed query (invoice, rate_code, project, contract) and returns validated truth
 * instead of raw rows. Reuses validator findings, decision context, and approval
 * snapshots as the authoritative source of record.
 */

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  operatorApprovalLabel,
  approvalGateImpact,
  approvalNextAction,
  findingApprovalLabel,
  findingGateImpact,
  findingNextAction,
  type TruthValidationState,
  type OperatorApprovalLabel,
} from '@/lib/truthToAction';
import type { InvoiceApprovalSnapshot, ProjectApprovalSnapshot } from '@/lib/server/approvalSnapshots';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TruthQueryType = 'invoice' | 'rate_code' | 'project' | 'contract';

/** A single piece of secondary evidence. IDs and raw keys are omitted. */
export type TruthEvidence = {
  kind: 'finding' | 'decision' | 'snapshot';
  label: string;
  detail: string;
};

/** The validated truth result for any query. */
export type TruthResult = {
  queryType: TruthQueryType;
  /** The human-readable form of the queried value (e.g. "Invoice 2026-003"). */
  queryLabel: string;
  /** The primary fact: what the system knows (e.g. "$42,500 billed"). */
  value: string;
  validationState: TruthValidationState;
  /** Operator-friendly approval label (Requires Verification, Needs Review, …). */
  approvalLabel: OperatorApprovalLabel;
  /** What this means for the approval gate. */
  gateImpact: string;
  /** What the operator should do next. */
  nextAction: string;
  /** Secondary evidence. Raw row values surfaced here only. */
  evidence: TruthEvidence[];
  /** Deep link to the validator surface for this project. */
  sourceHref: string | null;
};

// ---------------------------------------------------------------------------
// Internal DB row types
// ---------------------------------------------------------------------------

type FindingRow = {
  id: string;
  rule_id: string;
  severity: string;
  status: string;
  subject_type: string;
  subject_id: string;
  field: string | null;
  expected: string | null;
  actual: string | null;
  blocked_reason: string | null;
  decision_eligible: boolean;
  action_eligible: boolean;
  linked_decision_id: string | null;
  linked_action_id: string | null;
};

type ProjectValidationRow = {
  validation_status: string | null;
  validation_summary_json: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(amount) >= 1000 ? 0 : 2,
  }).format(amount);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/^\((.+)\)$/, '-$1')
    .replace(/[$,%\s,]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function truthFromApprovalLabel(
  label: OperatorApprovalLabel,
): TruthValidationState {
  switch (label) {
    case 'Approved':
      return 'Verified';
    case 'Approved with Notes':
    case 'Needs Review':
      return 'Needs Review';
    case 'Requires Verification':
      return 'Requires Verification';
    case 'Not Evaluated':
      return 'Missing';
    default:
      return 'Unknown';
  }
}

function snapshotStatusToTruth(
  status: string,
): TruthValidationState {
  switch (status) {
    case 'blocked': return 'Requires Verification';
    case 'needs_review': return 'Needs Review';
    case 'approved': return 'Verified';
    case 'approved_with_exceptions': return 'Needs Review';
    case 'not_evaluated': return 'Unknown';
    default: return 'Unknown';
  }
}

function findingToTruth(
  finding: FindingRow,
): TruthValidationState {
  const label = findingApprovalLabel({
    status: finding.status as 'open' | 'resolved' | 'dismissed' | 'muted',
    severity: finding.severity as 'critical' | 'warning' | 'info',
    blocked_reason: finding.blocked_reason,
    decision_eligible: finding.decision_eligible,
    action_eligible: finding.action_eligible,
  });
  switch (label) {
    case 'Requires Verification': return 'Requires Verification';
    case 'Needs Review': return 'Needs Review';
    case 'Approved with Notes': return 'Needs Review';
    case 'Approved': return 'Verified';
    default: return 'Unknown';
  }
}

function findingEvidenceDetail(finding: FindingRow): string {
  const parts: string[] = [];
  if (finding.field) parts.push(`Field: ${finding.field}`);
  if (finding.expected != null && finding.actual != null) {
    parts.push(`Expected ${finding.expected}, found ${finding.actual}`);
  } else if (finding.blocked_reason) {
    parts.push(finding.blocked_reason);
  }
  return parts.join(' · ') || 'Finding detail not available.';
}

function decisionEvidenceDetail(decision: {
  title: string;
  summary: string | null;
  status: string;
}): string {
  const base = decision.summary?.trim() || decision.title;
  return `${base} (${decision.status.replace(/_/g, ' ')})`;
}

const CONTRACT_FINDING_FIELDS = new Set([
  'activation_trigger_type',
  'contract_ceiling',
  'nte_amount',
  'pricing_applicability',
  'rate_row_count',
  'rate_schedule_pages',
  'rate_schedule_present',
  'rate_units_detected',
]);

function isContractFinding(finding: FindingRow): boolean {
  const ruleId = finding.rule_id.toUpperCase();
  const field = finding.field?.toLowerCase() ?? '';

  return (
    finding.subject_type === 'contract'
    || CONTRACT_FINDING_FIELDS.has(field)
    || ruleId.includes('CONTRACT_CEILING')
    || ruleId.includes('RATE_BASED')
    || ruleId.includes('_NTE_')
    || ruleId === 'SOURCES_NO_CONTRACT'
    || ruleId === 'SOURCES_NO_RATE_SCHEDULE'
  );
}

function isRateBasedContractFinding(finding: FindingRow): boolean {
  const ruleId = finding.rule_id.toUpperCase();
  return (
    ruleId.includes('RATE_BASED')
    || ruleId === 'SOURCES_NO_RATE_SCHEDULE'
    || finding.field === 'rate_schedule_present'
    || finding.field === 'rate_row_count'
    || finding.field === 'rate_schedule_pages'
  );
}

function formatRemainingCapacity(
  contractCeiling: number | null,
  billedToDate: number | null,
  hasRateBasedSignal: boolean,
): string {
  if (hasRateBasedSignal && contractCeiling == null) {
    return 'Depends on verified rate schedule';
  }

  if (contractCeiling == null) return 'Awaiting contract ceiling';
  if (billedToDate == null) return 'Awaiting billed-to-date total';

  const remaining = contractCeiling - billedToDate;
  if (remaining < 0) {
    return `Over by ${fmtCurrency(Math.abs(remaining))}`;
  }

  return fmtCurrency(remaining);
}

function contractGateImpact(params: {
  approvalLabel: OperatorApprovalLabel;
  contractCeiling: number | null;
  billedToDate: number | null;
  hasRateBasedSignal: boolean;
}): string {
  const {
    approvalLabel,
    contractCeiling,
    billedToDate,
    hasRateBasedSignal,
  } = params;

  if (hasRateBasedSignal && contractCeiling == null) {
    return approvalLabel === 'Approved'
      ? 'Uses the verified rate schedule as the approval basis'
      : 'Holds approval until the rate schedule is verified';
  }

  if (contractCeiling == null) {
    return 'Approval limit is not established';
  }

  if (billedToDate == null) {
    return 'Remaining capacity is not established';
  }

  const remaining = contractCeiling - billedToDate;
  if (remaining < 0) return 'Blocks approval until capacity is restored';
  if (remaining === 0) return 'No remaining contract capacity';
  if (approvalLabel !== 'Approved') return approvalGateImpact(approvalLabel);
  return 'Shows remaining contract capacity';
}

function contractNextAction(params: {
  approvalLabel: OperatorApprovalLabel;
  contractCeiling: number | null;
  billedToDate: number | null;
  hasRateBasedSignal: boolean;
  worstFinding: FindingRow | null;
}): string {
  const {
    approvalLabel,
    contractCeiling,
    billedToDate,
    hasRateBasedSignal,
    worstFinding,
  } = params;

  if (worstFinding) {
    if (isRateBasedContractFinding(worstFinding)) {
      return 'Verify rate schedule.';
    }

    const ruleId = worstFinding.rule_id.toUpperCase();
    if (ruleId === 'SOURCES_NO_CONTRACT') {
      return 'Attach the governing contract before continuing.';
    }
    if (ruleId.includes('CONTRACT_CEILING') || ruleId.includes('_NTE_')) {
      return 'Confirm the governing contract ceiling.';
    }

    return findingNextAction({
      status: worstFinding.status as 'open' | 'resolved' | 'dismissed' | 'muted',
      severity: worstFinding.severity as 'critical' | 'warning' | 'info',
      blocked_reason: worstFinding.blocked_reason,
      decision_eligible: worstFinding.decision_eligible,
      action_eligible: worstFinding.action_eligible,
    });
  }

  if (hasRateBasedSignal && contractCeiling == null) {
    return approvalLabel === 'Approved'
      ? 'Use the verified rate schedule when approving contract-backed spend.'
      : 'Verify rate schedule.';
  }

  if (contractCeiling == null) {
    return 'Confirm the governing contract ceiling.';
  }

  if (billedToDate == null) {
    return 'Publish billed-to-date totals to calculate remaining capacity.';
  }

  return contractCeiling - billedToDate < 0
    ? 'Resolve the over-ceiling exposure before approving additional spend.'
    : 'Use the remaining capacity when making the approval decision.';
}

function contractQueryLabel(queryValue: string): string {
  switch (queryValue.trim().toLowerCase()) {
    case 'ceiling':
      return 'Contract ceiling';
    case 'remaining':
      return 'Contract remaining capacity';
    case 'status':
      return 'Contract status';
    default:
      return 'Contract';
  }
}

async function loadContractFactHints(projectId: string): Promise<{
  contractCeilingType: string | null;
}> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { contractCeilingType: null };
  }

  const { data: documentRows } = await admin
    .from('documents')
    .select('id, document_type')
    .eq('project_id', projectId)
    .in('document_type', ['contract', 'rate_sheet']);

  const documentIds = ((documentRows ?? []) as Array<{ id: string }>).map((row) => row.id);
  if (documentIds.length === 0) {
    return { contractCeilingType: null };
  }

  const { data: factRows } = await admin
    .from('document_extractions')
    .select('field_key, field_value_text')
    .in('document_id', documentIds)
    .eq('status', 'active')
    .in('field_key', ['contract_ceiling_type']);

  const contractCeilingType = ((factRows ?? []) as Array<{
    field_key: string | null;
    field_value_text: string | null;
  }>)
    .find((row) => row.field_key === 'contract_ceiling_type')
    ?.field_value_text
    ?.trim()
    .toLowerCase() ?? null;

  return { contractCeilingType };
}

// ---------------------------------------------------------------------------
// Invoice truth
// ---------------------------------------------------------------------------

async function resolveInvoiceTruth(
  projectId: string,
  invoiceNumber: string,
): Promise<TruthResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // 1. Latest invoice snapshot
  const { data: snapshotRows } = await admin
    .from('invoice_approval_snapshots')
    .select('invoice_number, approval_status, billed_amount, supported_amount, at_risk_amount, blocking_reasons, reconciliation_status')
    .eq('project_id', projectId)
    .ilike('invoice_number', invoiceNumber)
    .order('created_at', { ascending: false })
    .limit(1);

  const snap = ((snapshotRows ?? []) as InvoiceApprovalSnapshot[])[0] ?? null;

  // 2. Open findings for this invoice
  const { data: findingRows } = await admin
    .from('project_validation_findings')
    .select('id, rule_id, severity, status, subject_type, subject_id, field, expected, actual, blocked_reason, decision_eligible, action_eligible, linked_decision_id, linked_action_id')
    .eq('project_id', projectId)
    .eq('status', 'open')
    .or(`subject_id.ilike.${invoiceNumber},field.ilike.%${invoiceNumber}%`);

  const findings = (findingRows ?? []) as FindingRow[];

  // 3. Linked decisions
  const decisionIds = findings
    .map((f) => f.linked_decision_id)
    .filter((id): id is string => id != null);

  const { data: decisionRows } = decisionIds.length > 0
    ? await admin
        .from('decisions')
        .select('id, title, summary, status')
        .in('id', decisionIds)
    : { data: [] };

  // 4. Determine truth
  const approvalStatus = snap?.approval_status ?? (findings.length > 0 ? 'needs_review' : 'not_evaluated');
  const approvalLabel = operatorApprovalLabel(approvalStatus);
  const validationState = snapshotStatusToTruth(approvalStatus);

  const billed = snap?.billed_amount ?? null;
  const atRisk = snap?.at_risk_amount ?? null;

  const valueParts: string[] = [];
  if (billed != null) valueParts.push(`${fmtCurrency(billed)} billed`);
  if (atRisk != null && atRisk > 0) valueParts.push(`${fmtCurrency(atRisk)} at risk`);
  if (valueParts.length === 0) valueParts.push('No billed amount on record');

  // Custom next action from blocking reasons if available
  const blockingReasons = snap?.blocking_reasons ?? [];
  const derivedNextAction = blockingReasons.length > 0
    ? `Review: ${blockingReasons[0]}`
    : approvalNextAction(approvalLabel);

  // 5. Build evidence (raw rows as secondary)
  const evidence: TruthEvidence[] = [];

  for (const finding of findings.slice(0, 3)) {
    evidence.push({
      kind: 'finding',
      label: `${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} finding`,
      detail: findingEvidenceDetail(finding),
    });
  }

  for (const decision of ((decisionRows ?? []) as { id: string; title: string; summary: string | null; status: string }[]).slice(0, 2)) {
    evidence.push({
      kind: 'decision',
      label: 'Related decision',
      detail: decisionEvidenceDetail(decision),
    });
  }

  return {
    queryType: 'invoice',
    queryLabel: `Invoice ${invoiceNumber}`,
    value: valueParts.join(', '),
    validationState,
    approvalLabel,
    gateImpact: approvalGateImpact(approvalLabel),
    nextAction: derivedNextAction,
    evidence,
    sourceHref: `/platform/workspace/projects/${projectId}?tab=validator`,
  };
}

// ---------------------------------------------------------------------------
// Rate code truth
// ---------------------------------------------------------------------------

async function resolveRateCodeTruth(
  projectId: string,
  rateCode: string,
): Promise<TruthResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // Search findings that reference this rate code in subject_id, field, expected, actual
  const pattern = `%${rateCode}%`;
  const { data: findingRows } = await admin
    .from('project_validation_findings')
    .select('id, rule_id, severity, status, subject_type, subject_id, field, expected, actual, blocked_reason, decision_eligible, action_eligible, linked_decision_id, linked_action_id')
    .eq('project_id', projectId)
    .eq('status', 'open')
    .or(
      `subject_id.ilike.${pattern},field.ilike.${pattern},expected.ilike.${pattern},actual.ilike.${pattern}`,
    );

  const findings = (findingRows ?? []) as FindingRow[];

  if (findings.length === 0) {
    // No active findings for this rate code — clear
    return {
      queryType: 'rate_code',
      queryLabel: `Rate ${rateCode}`,
      value: `Rate ${rateCode} — no active findings`,
      validationState: 'Verified',
      approvalLabel: 'Approved',
      gateImpact: approvalGateImpact('Approved'),
      nextAction: approvalNextAction('Approved'),
      evidence: [],
      sourceHref: `/platform/workspace/projects/${projectId}?tab=validator`,
    };
  }

  // Pick the worst finding to drive the truth output
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const worst = [...findings].sort(
    (a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9),
  )[0];

  const findingLabel = findingApprovalLabel({
    status: worst.status as 'open' | 'resolved' | 'dismissed' | 'muted',
    severity: worst.severity as 'critical' | 'warning' | 'info',
    blocked_reason: worst.blocked_reason,
    decision_eligible: worst.decision_eligible,
    action_eligible: worst.action_eligible,
  });

  const validationState = findingToTruth(worst);

  // Value: what the rate code resolves to
  const valueParts: string[] = [`Rate ${rateCode}`];
  if (worst.actual != null && worst.expected != null) {
    valueParts.push(`${worst.actual} (expected ${worst.expected})`);
  } else if (worst.actual != null) {
    valueParts.push(worst.actual);
  }

  const evidence: TruthEvidence[] = findings.slice(0, 4).map((finding) => ({
    kind: 'finding' as const,
    label: `${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} finding`,
    detail: findingEvidenceDetail(finding),
  }));

  return {
    queryType: 'rate_code',
    queryLabel: `Rate ${rateCode}`,
    value: valueParts.join(' — '),
    validationState,
    approvalLabel: findingLabel,
    gateImpact: findingGateImpact({
      status: worst.status as 'open' | 'resolved' | 'dismissed' | 'muted',
      severity: worst.severity as 'critical' | 'warning' | 'info',
      blocked_reason: worst.blocked_reason,
      decision_eligible: worst.decision_eligible,
      action_eligible: worst.action_eligible,
    }),
    nextAction: findingNextAction({
      status: worst.status as 'open' | 'resolved' | 'dismissed' | 'muted',
      severity: worst.severity as 'critical' | 'warning' | 'info',
      blocked_reason: worst.blocked_reason,
      decision_eligible: worst.decision_eligible,
      action_eligible: worst.action_eligible,
    }),
    evidence,
    sourceHref: `/platform/workspace/projects/${projectId}?tab=validator`,
  };
}

// ---------------------------------------------------------------------------
// Project truth
// ---------------------------------------------------------------------------

async function resolveProjectTruth(projectId: string): Promise<TruthResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  // 1. Latest project snapshot
  const { data: snapData } = await admin
    .from('project_approval_snapshots')
    .select('approval_status, total_billed, blocked_amount, at_risk_amount, invoice_count, blocked_invoice_count, needs_review_invoice_count')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const snap = snapData as ProjectApprovalSnapshot | null;

  // 2. Critical open findings
  const { data: criticalRows } = await admin
    .from('project_validation_findings')
    .select('id, rule_id, severity, status, subject_type, subject_id, field, expected, actual, blocked_reason, decision_eligible, action_eligible, linked_decision_id, linked_action_id')
    .eq('project_id', projectId)
    .eq('status', 'open')
    .in('severity', ['critical', 'warning'])
    .order('severity', { ascending: true }) // critical first
    .limit(5);

  const findings = (criticalRows ?? []) as FindingRow[];

  const approvalStatus = snap?.approval_status ?? 'not_evaluated';
  const approvalLabel = operatorApprovalLabel(approvalStatus);
  const validationState = snapshotStatusToTruth(approvalStatus);

  // Value: total billed + invoice breakdown
  const valueParts: string[] = [];
  if (snap?.total_billed != null) valueParts.push(`${fmtCurrency(snap.total_billed)} total billed`);
  if (snap != null) valueParts.push(`${snap.invoice_count} invoice${snap.invoice_count === 1 ? '' : 's'}`);
  if (snap?.blocked_invoice_count && snap.blocked_invoice_count > 0) {
    valueParts.push(`${snap.blocked_invoice_count} blocked`);
  }
  if (valueParts.length === 0) valueParts.push('No financial data on record');

  const evidence: TruthEvidence[] = [];

  if (snap != null) {
    const snapDetail: string[] = [];
    if (snap.blocked_amount != null && snap.blocked_amount > 0) {
      snapDetail.push(`${fmtCurrency(snap.blocked_amount)} blocked`);
    }
    if (snap.at_risk_amount != null && snap.at_risk_amount > 0) {
      snapDetail.push(`${fmtCurrency(snap.at_risk_amount)} at risk`);
    }
    if (snap.needs_review_invoice_count > 0) {
      snapDetail.push(`${snap.needs_review_invoice_count} invoice${snap.needs_review_invoice_count === 1 ? '' : 's'} need review`);
    }
    if (snapDetail.length > 0) {
      evidence.push({ kind: 'snapshot', label: 'Approval snapshot', detail: snapDetail.join(' · ') });
    }
  }

  for (const finding of findings.slice(0, 3)) {
    evidence.push({
      kind: 'finding',
      label: `${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} finding`,
      detail: findingEvidenceDetail(finding),
    });
  }

  return {
    queryType: 'project',
    queryLabel: `Project ${projectId.slice(0, 8)}`,
    value: valueParts.join(', '),
    validationState,
    approvalLabel,
    gateImpact: approvalGateImpact(approvalLabel),
    nextAction: approvalNextAction(approvalLabel),
    evidence,
    sourceHref: `/platform/workspace/projects/${projectId}?tab=validator`,
  };
}

// ---------------------------------------------------------------------------
// Contract truth
// ---------------------------------------------------------------------------

async function resolveContractTruth(
  projectId: string,
  queryValue: string,
): Promise<TruthResult | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const [{ data: projectData }, { data: findingRows }, factHints] = await Promise.all([
    admin
      .from('projects')
      .select('validation_status, validation_summary_json')
      .eq('id', projectId)
      .maybeSingle(),
    admin
      .from('project_validation_findings')
      .select('id, rule_id, severity, status, subject_type, subject_id, field, expected, actual, blocked_reason, decision_eligible, action_eligible, linked_decision_id, linked_action_id')
      .eq('project_id', projectId)
      .eq('status', 'open')
      .limit(50),
    loadContractFactHints(projectId),
  ]);

  const project = (projectData ?? null) as ProjectValidationRow | null;
  if (!project) return null;

  const summary = isRecord(project.validation_summary_json)
    ? project.validation_summary_json
    : null;
  const exposure = isRecord(summary?.exposure)
    ? summary.exposure
    : null;
  const findings = ((findingRows ?? []) as FindingRow[]).filter(isContractFinding);

  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  const worstFinding = findings.length > 0
    ? [...findings].sort(
        (left, right) => (severityOrder[left.severity] ?? 9) - (severityOrder[right.severity] ?? 9),
      )[0] ?? null
    : null;

  const validatorRaw =
    readString(summary?.validator_status)
    ?? readString(summary?.validator_readiness)
    ?? readString(project.validation_status)
    ?? null;

  const contractCeiling =
    readNumber(summary?.nte_amount)
    ?? readNumber(summary?.nteAmount)
    ?? null;
  const billedToDate =
    readNumber(summary?.total_billed)
    ?? readNumber(summary?.totalBilled)
    ?? (exposure
      ? readNumber(exposure.total_billed_amount)
        ?? readNumber(exposure.totalBilledAmount)
        ?? null
      : null);

  const hasRateBasedSignal =
    factHints.contractCeilingType === 'rate_based'
    || findings.some(isRateBasedContractFinding);

  const fallbackApprovalLabel =
    validatorRaw != null ? operatorApprovalLabel(validatorRaw) : 'Not Evaluated';
  const approvalLabel = worstFinding
    ? findingApprovalLabel({
        status: worstFinding.status as 'open' | 'resolved' | 'dismissed' | 'muted',
        severity: worstFinding.severity as 'critical' | 'warning' | 'info',
        blocked_reason: worstFinding.blocked_reason,
        decision_eligible: worstFinding.decision_eligible,
        action_eligible: worstFinding.action_eligible,
      })
    : hasRateBasedSignal || contractCeiling != null
      ? 'Approved'
      : fallbackApprovalLabel === 'Unknown'
        ? 'Not Evaluated'
        : fallbackApprovalLabel;

  const validationState = worstFinding
    ? findingToTruth(worstFinding)
    : hasRateBasedSignal || contractCeiling != null
      ? 'Verified'
      : truthFromApprovalLabel(approvalLabel);

  const contractCeilingValue = contractCeiling != null
    ? fmtCurrency(contractCeiling)
    : hasRateBasedSignal
      ? 'Rate-based schedule'
      : 'Awaiting contract ceiling';
  const remainingCapacityValue = formatRemainingCapacity(
    contractCeiling,
    billedToDate,
    hasRateBasedSignal,
  );

  const evidence: TruthEvidence[] = [
    {
      kind: 'snapshot',
      label: 'Contract ceiling',
      detail: contractCeilingValue,
    },
    {
      kind: 'snapshot',
      label: 'Billed to date',
      detail: billedToDate != null ? fmtCurrency(billedToDate) : 'Not established',
    },
    {
      kind: 'snapshot',
      label: 'Validator status',
      detail:
        fallbackApprovalLabel === 'Unknown'
          ? (validatorRaw ?? 'Not Evaluated')
          : fallbackApprovalLabel,
    },
  ];

  for (const finding of findings.slice(0, 2)) {
    evidence.push({
      kind: 'finding',
      label: `${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)} finding`,
      detail: findingEvidenceDetail(finding),
    });
  }

  return {
    queryType: 'contract',
    queryLabel: contractQueryLabel(queryValue),
    value: `Contract ceiling ${contractCeilingValue}, Remaining capacity ${remainingCapacityValue}`,
    validationState,
    approvalLabel,
    gateImpact: contractGateImpact({
      approvalLabel,
      contractCeiling,
      billedToDate,
      hasRateBasedSignal,
    }),
    nextAction: contractNextAction({
      approvalLabel,
      contractCeiling,
      billedToDate,
      hasRateBasedSignal,
      worstFinding,
    }),
    evidence,
    sourceHref: `/platform/workspace/projects/${projectId}?tab=validator`,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function resolveTruth(
  projectId: string,
  queryType: TruthQueryType,
  queryValue: string,
): Promise<TruthResult | null> {
  switch (queryType) {
    case 'invoice':  return resolveInvoiceTruth(projectId, queryValue);
    case 'rate_code': return resolveRateCodeTruth(projectId, queryValue);
    case 'project':  return resolveProjectTruth(projectId);
    case 'contract': return resolveContractTruth(projectId, queryValue);
  }
}
