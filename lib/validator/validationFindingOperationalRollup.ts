import type {
  ProjectOperationalRollup,
  ProjectOverviewStatus,
} from '@/lib/projectOverview';
import {
  countApprovalBlockers,
  isApprovalBlocker,
  normalizeValidationFinding,
} from '@/lib/validator/findingSemantics';
import type { ValidationFinding, ValidationStatus } from '@/types/validator';

function operationalStatusForValidationStatus(
  validationStatus: ValidationStatus,
): ProjectOverviewStatus {
  switch (validationStatus) {
    case 'VALIDATED':
      return {
        key: 'operationally_clear',
        label: 'Approved',
        tone: 'success',
        detail: 'Validation completed with no open approval blockers.',
        is_clear: true,
      };
    case 'BLOCKED':
      return {
        key: 'blocked',
        label: 'Blocked',
        tone: 'danger',
        detail: 'Open validation findings are blocking approval.',
        is_clear: false,
      };
    case 'FINDINGS_OPEN':
      return {
        key: 'needs_review',
        label: 'Needs Review',
        tone: 'warning',
        detail: 'Open validation findings require operator review.',
        is_clear: false,
      };
    case 'NOT_READY':
      return {
        key: 'attention_required',
        label: 'Not Evaluated',
        tone: 'muted',
        detail: 'Validation has not produced an approval decision.',
        is_clear: false,
      };
  }
}

export function buildValidationFindingOperationalRollup(params: {
  projectId: string;
  validationStatus: ValidationStatus;
  findings: readonly ValidationFinding[];
}): ProjectOperationalRollup {
  const { projectId, validationStatus } = params;
  const openFindings = params.findings.filter((finding) => finding.status === 'open');
  const pendingActions = openFindings
    .filter((finding) => finding.decision_eligible)
    .map((finding, index) => {
      const normalized = normalizeValidationFinding(finding);
      const blocksApproval = isApprovalBlocker(finding);

      return {
        id: `finding-${finding.check_key}`,
        title: normalized.problem || finding.blocked_reason || finding.category,
        description:
          normalized.impact
          || (finding.actual
            ? `Expected: ${finding.expected}, Actual: ${finding.actual}`
            : finding.category),
        status_label: blocksApproval ? 'Blocked' : 'Needs Review',
        due_label: blocksApproval ? 'Approval blocker' : 'Review required',
        due_tone: blocksApproval ? 'danger' as const : 'warning' as const,
        assignee_label: 'Operator queue',
        priority_label:
          normalized.business_severity === 'critical'
            ? 'Critical'
            : normalized.business_severity === 'high'
              ? 'High'
              : 'Normal',
        priority_tone: blocksApproval ? 'danger' as const : 'warning' as const,
        impacted_amount: normalized.affected_amount ?? null,
        at_risk_amount: normalized.affected_amount ?? null,
        blocked_amount: null,
        next_step: normalized.required_action || `Review finding: ${finding.check_key}`,
        href: `/platform/projects/${projectId}#validator`,
        invoice_number: null,
        approval_status: null,
        decision_id: finding.rule_id || finding.check_key,
        entity_type: 'finding',
        index,
      };
    });

  const status = operationalStatusForValidationStatus(validationStatus);

  return {
    status,
    processed_document_count: 0,
    needs_review_document_count: 0,
    open_document_action_count: 0,
    unresolved_finding_count: openFindings.length,
    blocked_count: countApprovalBlockers(openFindings),
    anomaly_count: 0,
    project_clear: validationStatus === 'VALIDATED',
    pending_actions: pendingActions,
    document_status_by_id: {},
  };
}
