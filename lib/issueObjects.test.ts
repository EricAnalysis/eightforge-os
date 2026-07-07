import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isIssueRequiringReview, type IssueObject, type IssueLifecycleState } from './issueObjects';

function issueWithLifecycle(lifecycleState: IssueLifecycleState): IssueObject {
  return { lifecycleState } as IssueObject;
}

describe('isIssueRequiringReview', () => {
  it('treats every non-resolved lifecycle state as requiring review', () => {
    const openStates: IssueLifecycleState[] = [
      'open',
      'blocked',
      'needs_verification',
      'ready_for_authorization',
      'escalated',
    ];

    for (const state of openStates) {
      assert.equal(isIssueRequiringReview(issueWithLifecycle(state)), true, `expected ${state} to require review`);
    }
  });

  it('excludes resolved issues, matching the Validator Findings panel definition of closed work', () => {
    assert.equal(isIssueRequiringReview(issueWithLifecycle('resolved')), false);
  });
});
