// lib/workflowReviewEligibility.ts
// Who is allowed to review a workflow assessment.
//
// This deliberately reuses the existing role model in lib/projectAdmin rather
// than introducing a parallel reviewer-role system. An audit of the repository
// found exactly one role vocabulary (owner/admin, normalized), already used by
// the project and document routes and by the internal orchestrator access seam,
// and `getActorContext` already returns the caller's role — so eligibility
// needs no new table, column, environment variable, or concept.
//
// The module is pure and framework-free so the review UI can import the same
// predicate to hide an action the operator cannot take. That is a convenience
// only: hiding a button is not authorization. The server rechecks this on
// submit, and the database remains the final authority on what gets written.

import { hasProjectAdminRole, normalizeUserRole } from '@/lib/projectAdmin';

/**
 * Reviewing a workflow assessment is an operator judgement that becomes
 * immutable audit truth, so it is restricted to the same roles trusted with
 * project administration.
 */
export function canReviewWorkflowAssessment(role: string | null | undefined): boolean {
  return hasProjectAdminRole(role);
}

/**
 * Why a caller may not review, as a stable reason code.
 *
 * Returning a reason rather than a bare boolean lets the route answer 403 with
 * something auditable, and lets the future UI explain the state instead of
 * silently omitting the action.
 */
export type WorkflowReviewEligibility =
  | Readonly<{ eligible: true; role: string }>
  | Readonly<{ eligible: false; reason: 'no_role_on_profile' | 'role_not_permitted' }>;

export function resolveWorkflowReviewEligibility(
  role: string | null | undefined,
): WorkflowReviewEligibility {
  const normalized = normalizeUserRole(role);
  if (!normalized) return { eligible: false, reason: 'no_role_on_profile' };
  if (!canReviewWorkflowAssessment(normalized)) {
    return { eligible: false, reason: 'role_not_permitted' };
  }
  return { eligible: true, role: normalized };
}
