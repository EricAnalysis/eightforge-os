import { describe, expect, it } from 'vitest';

import { recoveryReviewAcceptsDecision } from '@/lib/recovery/recoveryReviewDecision';

describe('recovery review decision state', () => {
  it('keeps pending and deferred proposals open for a decision', () => {
    expect(recoveryReviewAcceptsDecision('pending_review')).toBe(true);
    expect(recoveryReviewAcceptsDecision('deferred')).toBe(true);
  });

  it('closes approved, rejected and ambiguous proposals', () => {
    expect(recoveryReviewAcceptsDecision('accepted_awaiting_reprocess')).toBe(false);
    expect(recoveryReviewAcceptsDecision('rejected')).toBe(false);
    expect(recoveryReviewAcceptsDecision('ambiguous_authority')).toBe(false);
  });
});
