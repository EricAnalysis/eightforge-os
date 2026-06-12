import type {
  ValidationStatus,
  ValidatorStatus,
} from '@/types/validator';

export type PrimaryApprovalDecisionStatus =
  | 'approved'
  | 'blocked'
  | 'requires_review';

export type PrimaryApprovalContext = 'project' | 'invoice';

export type PrimaryApprovalDecisionInput = {
  id: string;
  title: string;
  summary: string | null;
  decision_type: string;
  status: string;
  severity: string;
  source?: string | null;
  document_id?: string | null;
  details?: Record<string, unknown> | null;
  last_detected_at?: string | null;
  created_at?: string | null;
};

export type ParsedPrimaryApprovalDecision = {
  id: string;
  title: string;
  summary: string | null;
  decision_type: string;
  status: string;
  severity: string;
  source: string | null;
  document_id: string | null;
  context: PrimaryApprovalContext;
  approval_status: PrimaryApprovalDecisionStatus;
  gate_approval_status:
    | 'approved'
    | 'approved_with_exceptions'
    | 'needs_review'
    | 'blocked'
    | null;
  blocked_amount: number | null;
  unsupported_amount: number | null;
  at_risk_amount: number | null;
  supported_amount: number | null;
  total_billed_amount: number | null;
  requires_verification_amount: number | null;
  required_reviews: number;
  blocking_reasons: string[];
  blocking_reason_codes: string[];
  evidence_refs: string[];
  source_validator_run_id: string | null;
  source_finding_ids: string[];
  approval_context_key: string | null;
  problem: string | null;
  impact: string | null;
  required_action: string | null;
  invoice_number: string | null;
  updated_at: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const next = readString(entry);
    return next ? [next] : [];
  });
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isPrimaryApprovalStatus(value: unknown): value is PrimaryApprovalDecisionStatus {
  return value === 'approved' || value === 'blocked' || value === 'requires_review';
}

function isPrimaryApprovalContext(value: unknown): value is PrimaryApprovalContext {
  return value === 'project' || value === 'invoice';
}

function isGateApprovalStatus(
  value: unknown,
): value is ParsedPrimaryApprovalDecision['gate_approval_status'] {
  return (
    value === 'approved'
    || value === 'approved_with_exceptions'
    || value === 'needs_review'
    || value === 'blocked'
  );
}

function parsePrimaryApprovalDecision(
  decision: PrimaryApprovalDecisionInput,
): ParsedPrimaryApprovalDecision | null {
  const details = asRecord(decision.details);
  if (!details) return null;
  if (readBoolean(details.primary_approval_decision) !== true) return null;

  const context = details.approval_context;
  const approvalStatus = details.approval_status;
  if (!isPrimaryApprovalContext(context) || !isPrimaryApprovalStatus(approvalStatus)) {
    return null;
  }

  const gateApprovalStatus = isGateApprovalStatus(details.gate_approval_status)
    ? details.gate_approval_status
    : null;

  return {
    id: decision.id,
    title: decision.title,
    summary: decision.summary ?? null,
    decision_type: decision.decision_type,
    status: decision.status,
    severity: decision.severity,
    source: readString(decision.source) ?? null,
    document_id: readString(decision.document_id) ?? null,
    context,
    approval_status: approvalStatus,
    gate_approval_status: gateApprovalStatus,
    blocked_amount: readNumber(details.blocked_amount),
    unsupported_amount: readNumber(details.unsupported_amount),
    at_risk_amount: readNumber(details.at_risk_amount),
    supported_amount: readNumber(details.supported_amount),
    total_billed_amount:
      readNumber(details.total_billed_amount)
      ?? readNumber(details.billed_amount),
    requires_verification_amount: readNumber(details.requires_verification_amount),
    required_reviews: readNumber(details.required_reviews) ?? 0,
    blocking_reasons: readStringArray(details.blocking_reasons),
    blocking_reason_codes: readStringArray(details.blocking_reason_codes),
    evidence_refs: readStringArray(details.evidence_refs),
    source_validator_run_id: readString(details.source_validator_run_id),
    source_finding_ids:
      readStringArray(details.source_finding_ids).length > 0
        ? readStringArray(details.source_finding_ids)
        : readStringArray(details.validator_finding_ids),
    approval_context_key: readString(details.approval_context_key),
    problem: readString(details.problem),
    impact: readString(details.impact),
    required_action: readString(details.required_action),
    invoice_number: readString(details.invoice_number),
    updated_at: readString(decision.last_detected_at) ?? readString(decision.created_at),
  };
}

function primaryDecisionOpenRank(status: string): number {
  return status === 'open' || status === 'in_review' ? 0 : 1;
}

function primaryDecisionPriorityRank(
  status: PrimaryApprovalDecisionStatus,
): number {
  switch (status) {
    case 'blocked':
      return 0;
    case 'requires_review':
      return 1;
    case 'approved':
    default:
      return 2;
  }
}

function comparePrimaryApprovalDecisions(
  left: ParsedPrimaryApprovalDecision,
  right: ParsedPrimaryApprovalDecision,
): number {
  const leftOpenRank = primaryDecisionOpenRank(left.status);
  const rightOpenRank = primaryDecisionOpenRank(right.status);
  if (leftOpenRank !== rightOpenRank) return leftOpenRank - rightOpenRank;

  const leftPriority = primaryDecisionPriorityRank(left.approval_status);
  const rightPriority = primaryDecisionPriorityRank(right.approval_status);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  const leftTimestamp = left.updated_at ? new Date(left.updated_at).getTime() : 0;
  const rightTimestamp = right.updated_at ? new Date(right.updated_at).getTime() : 0;
  return rightTimestamp - leftTimestamp;
}

export function resolvePrimaryApprovalDecisions(
  decisions: readonly PrimaryApprovalDecisionInput[] | null | undefined,
): ParsedPrimaryApprovalDecision[] {
  if (!Array.isArray(decisions)) return [];
  return decisions
    .flatMap((decision) => {
      const parsed = parsePrimaryApprovalDecision(decision);
      return parsed ? [parsed] : [];
    })
    .sort(comparePrimaryApprovalDecisions);
}

export function resolveProjectPrimaryApprovalDecision(
  decisions: readonly PrimaryApprovalDecisionInput[] | null | undefined,
): ParsedPrimaryApprovalDecision | null {
  return resolvePrimaryApprovalDecisions(decisions).find(
    (decision) => decision.context === 'project',
  ) ?? null;
}

export function resolveInvoicePrimaryApprovalDecisions(
  decisions: readonly PrimaryApprovalDecisionInput[] | null | undefined,
): ParsedPrimaryApprovalDecision[] {
  return resolvePrimaryApprovalDecisions(decisions).filter(
    (decision) => decision.context === 'invoice',
  );
}

export function isPrimaryApprovalDecisionRow(
  decision: PrimaryApprovalDecisionInput,
): boolean {
  return parsePrimaryApprovalDecision(decision) != null;
}

export function isProjectPrimaryApprovalDecisionRow(
  decision: PrimaryApprovalDecisionInput,
): boolean {
  const parsed = parsePrimaryApprovalDecision(decision);
  return parsed?.context === 'project';
}

export function primaryApprovalStatusToValidatorStatus(
  status: PrimaryApprovalDecisionStatus,
): ValidatorStatus {
  switch (status) {
    case 'approved':
      return 'READY';
    case 'blocked':
      return 'BLOCKED';
    case 'requires_review':
    default:
      return 'NEEDS_REVIEW';
  }
}

export function primaryApprovalStatusToValidationStatus(
  status: PrimaryApprovalDecisionStatus,
): ValidationStatus {
  switch (status) {
    case 'approved':
      return 'VALIDATED';
    case 'blocked':
      return 'BLOCKED';
    case 'requires_review':
    default:
      return 'FINDINGS_OPEN';
  }
}
