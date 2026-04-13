/**
 * lib/decisionToWorkflow.ts
 *
 * Decision-to-workflow adapter.
 * Takes decision state, gate impact, validation state, and causal chain,
 * and returns a deterministic workflow action: what to do, where to route it,
 * who should own it, and how urgent it is.
 *
 * Rules:
 *   Requires Verification  → nextAction "Request verification"
 *   Needs Review           → nextAction "Send to reviewer"
 *   Approved with Notes    → nextAction "Execute with notes"
 *   Approved / Not Evaluated → nextAction "Allow but mark watch"
 *
 *   Blocking gate impact   → priority highest
 *   Scope or rate conflict → priority high
 *   Missing evidence       → priority medium
 *   Informational          → priority low
 */

import {
  approvalGateImpact,
  approvalNextAction,
  type OperatorApprovalLabel,
  type TruthValidationState,
} from '@/lib/truthToAction';

// Re-export so callers don't need to import from two places
export type { OperatorApprovalLabel, TruthValidationState };

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type WorkflowPriority = 'highest' | 'high' | 'medium' | 'low';

export type WorkflowTarget =
  | 'verification_queue'
  | 'review_queue'
  | 'approval_queue'
  | 'watch_list';

export type DecisionWorkflowInput = {
  /** The operator-friendly approval label derived from decision status + severity. */
  approvalLabel: OperatorApprovalLabel;
  /** Gate impact text (e.g. "Blocks approval until verified"). */
  gateImpact: string;
  /** Truth validation state. */
  validationState: TruthValidationState;
  /** Causal chain signals (blocking_reasons, causal_chain, etc.) for scope/rate detection. */
  causalChain?: string[];
  /** Decision type string, used to derive ownerHint. */
  decisionType?: string;
};

export type DecisionWorkflowOutput = {
  /** Short operator action label for routing. */
  nextAction: string;
  /** Queue priority for sorting. */
  priority: WorkflowPriority;
  /** Whether this decision requires approval sign-off before workflow can proceed. */
  approvalRequired: boolean;
  /** Which workflow queue this decision routes to. */
  workflowTarget: WorkflowTarget;
  /** Suggested owner hint, derived from causal chain or decision type. */
  ownerHint: string | null;
};

// ---------------------------------------------------------------------------
// Scope / rate conflict detection
// ---------------------------------------------------------------------------

const SCOPE_RATE_SIGNALS: string[] = [
  'rate',
  'scope',
  'out of scope',
  'not in scope',
  'rate mismatch',
  'rate conflict',
  'scope conflict',
  'rate not applicable',
  'unauthorized scope',
  'contract scope',
  'billing category',
  'rate code',
  'markup',
  'unit price',
  'contract line',
  'unauthorized',
];

function hasScopeRateConflict(causalChain: string[]): boolean {
  const combined = causalChain.join(' ').toLowerCase();
  return SCOPE_RATE_SIGNALS.some((signal) => combined.includes(signal));
}

// ---------------------------------------------------------------------------
// Priority derivation
// ---------------------------------------------------------------------------

function derivePriority(
  approvalLabel: OperatorApprovalLabel,
  gateImpact: string,
  validationState: TruthValidationState,
  causalChain: string[],
): WorkflowPriority {
  const impact = gateImpact.toLowerCase();

  // Blocking gate impact → highest
  if (impact.includes('block')) return 'highest';
  if (approvalLabel === 'Requires Verification') return 'highest';

  // Scope or rate conflicts → high
  if (hasScopeRateConflict(causalChain)) return 'high';
  if (approvalLabel === 'Needs Review') return 'high';

  // Missing evidence → medium
  if (validationState === 'Missing' || validationState === 'Unknown') return 'medium';
  if (approvalLabel === 'Not Evaluated') return 'medium';
  if (approvalLabel === 'Approved with Notes') return 'medium';

  // Informational (approved / clear) → low
  return 'low';
}

// ---------------------------------------------------------------------------
// Workflow target routing
// ---------------------------------------------------------------------------

function deriveWorkflowTarget(approvalLabel: OperatorApprovalLabel): WorkflowTarget {
  switch (approvalLabel) {
    case 'Requires Verification': return 'verification_queue';
    case 'Needs Review':          return 'review_queue';
    case 'Approved with Notes':   return 'approval_queue';
    default:                      return 'watch_list';
  }
}

// ---------------------------------------------------------------------------
// Next action (routing label — not the human instruction from decision details)
// ---------------------------------------------------------------------------

function deriveNextAction(approvalLabel: OperatorApprovalLabel): string {
  switch (approvalLabel) {
    case 'Requires Verification': return 'Request verification';
    case 'Needs Review':          return 'Send to reviewer';
    case 'Approved with Notes':   return 'Execute with notes';
    case 'Approved':
    case 'Not Evaluated':         return 'Allow but mark watch';
    default:                      return 'Open and confirm next step';
  }
}

// ---------------------------------------------------------------------------
// Owner hint
// ---------------------------------------------------------------------------

function deriveOwnerHint(
  causalChain: string[],
  decisionType: string | undefined,
  workflowTarget: WorkflowTarget,
): string | null {
  // Use causal chain head as the most specific hint
  if (causalChain.length > 0) {
    const head = causalChain[0].trim();
    if (head.length > 0) {
      return head.length <= 80 ? head : `${head.slice(0, 80)}…`;
    }
  }

  // Fall back to type-based hints
  const type = (decisionType ?? '').toLowerCase();
  if (type.includes('contract')) return 'Contract administrator';
  if (type.includes('invoice') || type.includes('billing')) return 'Billing specialist';
  if (type.includes('rate')) return 'Rate schedule reviewer';
  if (type.includes('scope')) return 'Scope authority';

  // Fall back to target-based hints
  if (workflowTarget === 'verification_queue') return 'Verification lead';
  if (workflowTarget === 'review_queue')       return 'Approval officer';

  return null;
}

// ---------------------------------------------------------------------------
// Causal chain extraction helper
// ---------------------------------------------------------------------------

/**
 * Extracts a causal chain from a decision's details blob.
 * Checks blocking_reasons → causal_chain → single reason string.
 */
export function extractCausalChain(
  details: Record<string, unknown> | null | undefined,
): string[] {
  if (!details) return [];

  const blocking = details['blocking_reasons'];
  if (Array.isArray(blocking)) {
    return blocking.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  }

  const chain = details['causal_chain'];
  if (Array.isArray(chain)) {
    return chain.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  }

  const reason =
    details['reason'] ?? details['detail'] ?? details['explanation'];
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return [reason.trim()];
  }

  return [];
}

/**
 * Derives the operator approval label from a decision's status + severity.
 * Status takes precedence; severity is the fallback for unrecognised statuses
 * (e.g. 'open', 'in_review') that sit outside the status map.
 */
export function decisionApprovalLabelFromStatus(
  status: string,
  severity: string,
): OperatorApprovalLabel {
  switch (status) {
    case 'blocked':                return 'Requires Verification';
    case 'needs_review':           return 'Needs Review';
    case 'approved_with_exceptions': return 'Approved with Notes';
    case 'approved':               return 'Approved';
    case 'not_evaluated':          return 'Not Evaluated';
    // Unrecognised statuses — fall back to severity
    default:
      if (severity === 'critical') return 'Requires Verification';
      if (severity === 'high')     return 'Needs Review';
      if (severity === 'medium')   return 'Needs Review';
      return 'Not Evaluated';
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Maps a decision's approval state + gate impact + causal chain to a
 * deterministic workflow action, priority, routing target, and owner hint.
 */
export function decisionToWorkflow(input: DecisionWorkflowInput): DecisionWorkflowOutput {
  const {
    approvalLabel,
    gateImpact,
    validationState,
    causalChain = [],
    decisionType,
  } = input;

  const priority      = derivePriority(approvalLabel, gateImpact, validationState, causalChain);
  const workflowTarget = deriveWorkflowTarget(approvalLabel);
  const nextAction    = deriveNextAction(approvalLabel);
  const ownerHint     = deriveOwnerHint(causalChain, decisionType, workflowTarget);
  const approvalRequired =
    approvalLabel === 'Requires Verification' || approvalLabel === 'Needs Review';

  return { nextAction, priority, approvalRequired, workflowTarget, ownerHint };
}
