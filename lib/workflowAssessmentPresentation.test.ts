import { describe, expect, it } from 'vitest';

import { workflowQualificationLabel } from '@/lib/workflowAssessmentPresentation';

describe('workflow qualification presentation', () => {
  it('labels legacy qualified evidence as historical without changing the evidence', () => {
    const persisted = Object.freeze({ stepId: 's1', state: 'qualified', reasons: [] });
    const original = JSON.stringify(persisted);
    expect(workflowQualificationLabel(persisted.state))
      .toBe('historical qualification (pre-current trust model)');
    expect(JSON.stringify(persisted)).toBe(original);
  });

  it.each([
    ['grounded_unverified', 'grounded unverified'],
    ['proposed', 'proposed'],
    ['proposed_with_gaps', 'proposed with gaps'],
  ])('preserves the existing display of current %s', (state, label) => {
    expect(workflowQualificationLabel(state)).toBe(label);
  });
});
