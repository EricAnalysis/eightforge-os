import type { ValidationFinding } from '@/types/validator';

export type FindingRoutingEvaluation = {
  decision_eligible: boolean;
  action_eligible: boolean;
  routing_reason: string;
};

function hasBlockedReason(finding: ValidationFinding): boolean {
  return typeof finding.blocked_reason === 'string' && finding.blocked_reason.trim().length > 0;
}

export function evaluateFindingRouting(
  finding: ValidationFinding,
): FindingRoutingEvaluation {
  const blocked = hasBlockedReason(finding);

  if (finding.status === 'muted') {
    return {
      decision_eligible: false,
      action_eligible: false,
      routing_reason: 'Muted findings are not eligible for routing.',
    };
  }

  if (finding.status === 'dismissed') {
    return {
      decision_eligible: false,
      action_eligible: false,
      routing_reason: 'Dismissed findings are not eligible for routing.',
    };
  }

  if (finding.severity === 'info') {
    return {
      decision_eligible: false,
      action_eligible: blocked,
      routing_reason: blocked
        ? 'Info findings are not decision eligible, but blocked findings are eligible to route to an action.'
        : 'Info findings do not meet the routing threshold.',
    };
  }

  let decision_eligible = false;
  let decision_reason: string | null = null;

  if (
    finding.severity === 'critical' &&
    finding.rule_id === 'TICKET_QTY_CYD_MISMATCH' &&
    finding.variance != null &&
    finding.variance > 5
  ) {
    decision_eligible = true;
    decision_reason = 'Critical CYD ticket quantity mismatches above 5 require a decision.';
  }
  else if (
    finding.severity === 'critical' &&
    finding.rule_id === 'FINANCIAL_NTE_EXCEEDED'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical not-to-exceed overages require a decision.';
  }
  else if (
    finding.severity === 'critical' &&
    finding.rule_id === 'FINANCIAL_RATE_NOT_IN_SCHEDULE'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical rate schedule mismatches require a decision.';
  }
  else if (
    finding.severity === 'critical' &&
    finding.rule_id === 'IDENTITY_DUPLICATE_TICKET'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical duplicate ticket findings require a decision.';
  }
  else if (
    finding.severity === 'critical' &&
    finding.category === 'financial_integrity'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical financial integrity findings require a decision.';
  }

  if (decision_eligible && blocked) {
    return {
      decision_eligible: true,
      action_eligible: true,
      routing_reason: `${decision_reason} Blocked findings are also eligible to route to an action.`,
    };
  }

  if (decision_eligible) {
    return {
      decision_eligible: true,
      action_eligible: false,
      routing_reason: decision_reason ?? 'This finding is eligible for decision routing.',
    };
  }

  if (blocked) {
    return {
      decision_eligible: false,
      action_eligible: true,
      routing_reason: 'Blocked findings are eligible to route to an action.',
    };
  }

  if (finding.severity === 'critical' || finding.severity === 'warning') {
    if (
      finding.rule_id === 'TICKET_QTY_CYD_MISMATCH' &&
      finding.severity === 'critical' &&
      finding.variance != null &&
      finding.variance <= 5
    ) {
      return {
        decision_eligible: false,
        action_eligible: true,
        routing_reason: 'Critical CYD ticket mismatches at or below 5 route to an action instead of a decision.',
      };
    }

    return {
      decision_eligible: false,
      action_eligible: true,
      routing_reason: 'Critical and warning findings route to an action when no decision is required.',
    };
  }

  return {
    decision_eligible: false,
    action_eligible: false,
    routing_reason: 'This finding does not meet any routing eligibility rule.',
  };
}
