// lib/server/workflowPlatformReviewAccess.ts
// Who may use EightForge's and Forgewing's platform-wide tools: the processing
// hold, workflow assessment review, improvement lifecycle, project
// intelligence signals and repository plan runs.
//
// One authority: the PLATFORM OWNER. An account is the platform owner iff its
// latest event in the append-only public.platform_owner_grant_events ledger is
// a grant (migration 20261105120200; read by public.is_platform_owner).
// getActorContext resolves it server-side, from the verified session's user
// id, on every authenticated request. Nothing a client sends can set it.
//
// What does NOT grant platform authority:
//   * organization roles (owner/admin). They are tenant-scoped; reusing them
//     would let any tenant's administrator review every tenant's submissions,
//     which is the defect this module exists to prevent;
//   * an email address, a role name or any environment variable. The
//     INTERNAL_ORCHESTRATOR_ALLOWED_* allowlists no longer apply here.
//
// Fail-closed: no ledger grant (or a failed lookup) means no platform owner,
// so the tools refuse everyone, which is today's production state.
//
// Server-only. Eligibility is never a client decision: hiding a control is a
// courtesy, this is the authority.

export type WorkflowPlatformReviewer = Readonly<{
  email?: string | null | undefined;
  role?: string | null | undefined;
  /** Resolved by getActorContext from the platform-owner ledger. */
  platformOwner?: boolean | null | undefined;
}>;

export type WorkflowPlatformReviewAccess =
  | Readonly<{ allowed: true; basis: 'platform_owner' }>
  | Readonly<{ allowed: false; reason: 'identity_missing' | 'not_platform_owner' }>;

/** Resolves platform-wide access for one authenticated actor. */
export function resolveWorkflowPlatformReviewAccess(
  reviewer: WorkflowPlatformReviewer | null | undefined,
): WorkflowPlatformReviewAccess {
  if (!reviewer) return { allowed: false, reason: 'identity_missing' };
  // Strictly `true`: a missing, null or truthy-but-not-boolean value refuses.
  if (reviewer.platformOwner === true) return { allowed: true, basis: 'platform_owner' };
  return { allowed: false, reason: 'not_platform_owner' };
}

export function isWorkflowPlatformReviewer(reviewer: WorkflowPlatformReviewer | null | undefined): boolean {
  return resolveWorkflowPlatformReviewAccess(reviewer).allowed;
}
