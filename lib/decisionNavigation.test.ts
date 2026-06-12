import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildDecisionContextHref,
  buildDecisionEvidenceHref,
} from '@/lib/decisionNavigation';

describe('decisionNavigation', () => {
  it('preserves decision context when routing back from evidence review', () => {
    assert.equal(
      buildDecisionContextHref('decision-42'),
      '/platform/decisions/decision-42#decision-context',
    );
    assert.equal(
      buildDecisionEvidenceHref('decision-42'),
      '/platform/decisions/decision-42#decision-context',
    );
  });
});
