import type { ValidationFinding } from '@/types/validator';
import {
  isBlockingFinding,
  isReviewFinding,
  normalizeValidationFinding,
} from '@/lib/validator/findingSemantics';

export type FindingRoutingEvaluation = {
  decision_eligible: boolean;
  action_eligible: boolean;
  routing_reason: string;
};

export function evaluateFindingRouting(
  finding: ValidationFinding,
): FindingRoutingEvaluation {
  const normalized = normalizeValidationFinding(finding);
  const blocked = isBlockingFinding(normalized);
  const reviewOnly = isReviewFinding(normalized);

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

  if (normalized.finding_disposition === 'info') {
    return {
      decision_eligible: false,
      action_eligible: false,
      routing_reason: 'Informational findings do not meet the routing threshold.',
    };
  }

  let decision_eligible = false;
  let decision_reason: string | null = null;

  if (
    blocked &&
    finding.rule_id === 'TICKET_QTY_CYD_MISMATCH' &&
    finding.variance != null &&
    finding.variance > 5
  ) {
    decision_eligible = true;
    decision_reason = 'Critical CYD ticket quantity mismatches above 5 require a decision.';
  }
  else if (
    blocked &&
    finding.rule_id === 'FINANCIAL_NTE_EXCEEDED'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical not-to-exceed overages require a decision.';
  }
  else if (
    blocked &&
    finding.rule_id === 'FINANCIAL_RATE_NOT_IN_SCHEDULE'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical rate schedule mismatches require a decision.';
  }
  else if (
    blocked &&
    finding.rule_id === 'IDENTITY_DUPLICATE_TICKET'
  ) {
    decision_eligible = true;
    decision_reason = 'Critical duplicate ticket findings require a decision.';
  }
  else if (
    blocked &&
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

  if (blocked || reviewOnly) {
    if (
      finding.rule_id === 'TICKET_QTY_CYD_MISMATCH' &&
      blocked &&
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
      routing_reason: blocked
        ? 'Approval-blocking findings route to an action when no decision is required.'
        : 'Review findings route to an action when operator follow-up is required.',
    };
  }

  return {
    decision_eligible: false,
    action_eligible: false,
    routing_reason: 'This finding does not meet any routing eligibility rule.',
  };
}
