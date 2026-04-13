import type {
  ValidationFinding,
  ValidationStatus,
  ValidatorStatus,
} from '@/types/validator';

export type OperatorApprovalLabel =
  | 'Requires Verification'
  | 'Needs Review'
  | 'Approved with Notes'
  | 'Approved'
  | 'Not Evaluated'
  | 'Unknown';

export type TruthValidationState =
  | 'Verified'
  | 'Needs Review'
  | 'Requires Verification'
  | 'Missing'
  | 'Unknown';

export function humanizeTruthToken(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function operatorApprovalLabel(
  status: string | ValidationStatus | ValidatorStatus | null | undefined,
): OperatorApprovalLabel {
  switch (status) {
    case 'blocked':
    case 'BLOCKED':
      return 'Requires Verification';
    case 'needs_review':
    case 'NEEDS_REVIEW':
    case 'FINDINGS_OPEN':
      return 'Needs Review';
    case 'approved_with_exceptions':
      return 'Approved with Notes';
    case 'approved':
    case 'READY':
    case 'VALIDATED':
      return 'Approved';
    case 'not_evaluated':
    case 'NOT_READY':
      return 'Not Evaluated';
    default:
      return 'Unknown';
  }
}

export function approvalGateImpact(label: OperatorApprovalLabel): string {
  switch (label) {
    case 'Requires Verification':
      return 'Blocks approval until verified';
    case 'Needs Review':
      return 'Holds approval for operator review';
    case 'Approved with Notes':
      return 'Approval can proceed with documented notes';
    case 'Approved':
      return 'Clears the approval gate';
    case 'Not Evaluated':
      return 'Awaiting validation before approval';
    default:
      return 'Gate impact not established';
  }
}

export function approvalNextAction(label: OperatorApprovalLabel): string {
  switch (label) {
    case 'Requires Verification':
      return 'Review blocking evidence and resolve the mismatch.';
    case 'Needs Review':
      return 'Review supporting evidence and confirm operator next steps.';
    case 'Approved with Notes':
      return 'Record notes and continue the approval handoff.';
    case 'Approved':
      return 'Continue to the next operator step.';
    case 'Not Evaluated':
      return 'Run or refresh validation before taking approval action.';
    default:
      return 'Open the source record and confirm the next operator step.';
  }
}

type FindingTruthDescriptor = Pick<
  ValidationFinding,
  'status' | 'severity' | 'blocked_reason' | 'decision_eligible' | 'action_eligible'
>;

export function findingApprovalLabel(
  finding: FindingTruthDescriptor,
): OperatorApprovalLabel {
  if (finding.status === 'resolved') {
    return 'Approved';
  }

  if (finding.status === 'dismissed' || finding.status === 'muted') {
    return 'Approved with Notes';
  }

  if (finding.blocked_reason || finding.severity === 'critical') {
    return 'Requires Verification';
  }

  return 'Needs Review';
}

export function findingGateImpact(finding: FindingTruthDescriptor): string {
  const label = findingApprovalLabel(finding);

  if (label === 'Approved') {
    return 'Clears the approval gate';
  }

  return approvalGateImpact(label);
}

export function findingNextAction(finding: FindingTruthDescriptor): string {
  const label = findingApprovalLabel(finding);

  if (label === 'Approved') {
    return 'No operator action is currently required.';
  }

  if (label === 'Approved with Notes') {
    return 'Keep the note attached and continue the approval handoff.';
  }

  if (label === 'Requires Verification') {
    return finding.action_eligible
      ? 'Create the follow-up action and resolve the mismatch.'
      : 'Open the evidence and resolve the mismatch.';
  }

  if (finding.decision_eligible) {
    return 'Open the evidence and create the decision record.';
  }

  if (finding.action_eligible) {
    return 'Open the evidence and create the next action.';
  }

  return approvalNextAction(label);
}

export function invoiceBilledSourceLabel(
  source: string | null | undefined,
): string {
  switch (source) {
    case 'invoice_total':
      return 'Invoice total';
    case 'line_total_fallback':
      return 'Invoice line totals';
    case 'missing':
      return 'Missing billed source';
    default:
      return source ? humanizeTruthToken(source) : 'Unknown source';
  }
}

export function validationToneKey(
  validation: TruthValidationState,
): 'success' | 'warning' | 'danger' | 'muted' {
  switch (validation) {
    case 'Verified':
      return 'success';
    case 'Needs Review':
      return 'warning';
    case 'Requires Verification':
    case 'Missing':
      return 'danger';
    default:
      return 'muted';
  }
}
