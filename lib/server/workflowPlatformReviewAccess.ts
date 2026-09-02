// lib/server/workflowPlatformReviewAccess.ts
// Who is allowed to review workflow assessments, platform-wide.
//
// Workflow intake is public and unassigned: a submission has no actor and no
// organization, and the assessment derived from it is global. Organization
// membership therefore cannot scope it. Reusing owner/admin meant any tenant's
// administrator could enumerate and review every other tenant's submitted
// business process, which is the defect this module exists to close.
//
// The repository already has exactly one platform-wide authorization concept:
// the explicit internal-operator allowlists behind
// INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS / INTERNAL_ORCHESTRATOR_ALLOWED_ROLES.
// This reuses that vocabulary rather than inventing a second one, and reuses it
// WITHOUT the project-admin fallback that isAllowedInternalOrchestratorOperator
// applies. That fallback is precisely what re-admits every organization
// administrator, so inheriting it would rename the defect rather than fix it.
//
// Fail-closed by construction: with neither allowlist configured, nobody is a
// platform reviewer. An unconfigured deployment therefore has no reviewers
// rather than every administrator, which is the safe direction for a surface
// whose output is immutable audit truth.
//
// Server-only. It reads process.env, and eligibility is never a client
// decision: hiding a control is a courtesy, this is the authority.

export const WORKFLOW_REVIEW_ALLOWED_EMAILS_ENV =
  'INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS' as const;
export const WORKFLOW_REVIEW_ALLOWED_ROLES_ENV =
  'INTERNAL_ORCHESTRATOR_ALLOWED_ROLES' as const;

export type WorkflowPlatformReviewer = Readonly<{
  email: string | null | undefined;
  role: string | null | undefined;
}>;

export type WorkflowPlatformReviewAccess =
  | Readonly<{ allowed: true; basis: 'allowlisted_email' | 'allowlisted_role' }>
  | Readonly<{
      allowed: false;
      reason: 'not_configured' | 'identity_missing' | 'not_allowlisted';
    }>;

/**
 * Case-insensitive, whitespace-tolerant list parsing.
 *
 * Empty entries are dropped so a stray comma cannot widen access, and a value
 * of "" yields an empty list rather than a list containing "".
 */
function parseAllowlist(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolves platform review access for one authenticated actor.
 *
 * Both identity fields come from the verified session -- the email from
 * Supabase Auth, the role from the actor's user_profiles row -- never from a
 * request body.
 */
export function resolveWorkflowPlatformReviewAccess(
  reviewer: WorkflowPlatformReviewer,
): WorkflowPlatformReviewAccess {
  const allowedEmails = parseAllowlist(process.env[WORKFLOW_REVIEW_ALLOWED_EMAILS_ENV]);
  const allowedRoles = parseAllowlist(process.env[WORKFLOW_REVIEW_ALLOWED_ROLES_ENV]);

  // No allowlist means no platform reviewers. Deliberately not "everyone with
  // an admin role": an unconfigured deployment must not silently grant global
  // access to every tenant administrator.
  if (allowedEmails.length === 0 && allowedRoles.length === 0) {
    return { allowed: false, reason: 'not_configured' };
  }

  const email = normalize(reviewer?.email);
  const role = normalize(reviewer?.role);
  if (!email && !role) return { allowed: false, reason: 'identity_missing' };

  if (email && allowedEmails.includes(email)) {
    return { allowed: true, basis: 'allowlisted_email' };
  }
  if (role && allowedRoles.includes(role)) {
    return { allowed: true, basis: 'allowlisted_role' };
  }

  return { allowed: false, reason: 'not_allowlisted' };
}

export function isWorkflowPlatformReviewer(reviewer: WorkflowPlatformReviewer): boolean {
  return resolveWorkflowPlatformReviewAccess(reviewer).allowed;
}
