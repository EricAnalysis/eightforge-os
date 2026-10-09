import type { RecoveryReviewState } from '@/lib/server/forgewingRecoveryReviewRead';

/**
 * Whether a reviewer may still record a decision. A deferral postpones the
 * decision rather than making one, so it stays open; reviews are versioned and
 * the latest one is effective. Approved, rejected and ambiguous states are closed.
 */
export function recoveryReviewAcceptsDecision(state: RecoveryReviewState): boolean {
  return state === 'pending_review' || state === 'deferred';
}
