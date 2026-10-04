import { describe, expect, it } from 'vitest';

import { findingClosureKind, operatorClearanceOf, type OperatorClearanceRecords } from '@/lib/validator/persistedFindingProjection';

const none: OperatorClearanceRecords = { executionItems: [], decisions: [], decisionFeedback: [], rateLinks: [] };
const finding = (overrides: Partial<Parameters<typeof operatorClearanceOf>[0]> = {}) => ({
  rule_id: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE', subject_id: 'line-1',
  linked_decision_id: null, linked_action_id: null, resolved_at: '2026-10-04T00:00:00.000Z', ...overrides,
});
const feedback = (overrides: Record<string, unknown> = {}) => ({
  id: 'fb-1', decision_id: 'd-1', created_by: 'operator-1', decision_status_at_feedback: null,
  disposition: null, is_correct: null, feedback_type: null, ...overrides,
}) as OperatorClearanceRecords['decisionFeedback'][number];

describe('operator clearance of a closed finding', () => {
  it('a finding with no operator record was only not observed', () => {
    expect(operatorClearanceOf(finding(), none)).toBeNull();
    expect(findingClosureKind({ operatorClearance: null })).toBe('not_observed');
    // A resolved_by stamp or a linked decision status alone proves nothing.
    expect(operatorClearanceOf(finding({ linked_decision_id: 'd-1' }),
      { ...none, decisions: [{ id: 'd-1', status: 'resolved' }] })).toBeNull();
  });

  it('accepts each operator path\'s own record', () => {
    expect(operatorClearanceOf(finding({ linked_action_id: 'i-1' }),
      { ...none, executionItems: [{ id: 'i-1', outcome: 'confirmed' }] })).toEqual({ kind: 'execution_outcome', recordId: 'i-1' });
    // Status route: the recorded terminal status.
    expect(operatorClearanceOf(finding({ linked_decision_id: 'd-1' }), { ...none, decisions: [{ id: 'd-1', status: 'resolved' }],
      decisionFeedback: [feedback({ decision_status_at_feedback: 'resolved' })] })).toEqual({ kind: 'decision_feedback', recordId: 'fb-1' });
    // Feedback route: the disposition that closes the decision.
    expect(operatorClearanceOf(finding({ linked_decision_id: 'd-1' }), { ...none, decisions: [{ id: 'd-1', status: 'resolved' }],
      decisionFeedback: [feedback({ is_correct: true, feedback_type: 'correct', disposition: 'accept' })] })).not.toBeNull();
    expect(operatorClearanceOf(finding({ rule_id: 'FINANCIAL_RATE_CODE_MISSING' }), { ...none,
      rateLinks: [{ id: 'l-1', invoice_line_subject_id: 'line-1', actor_id: 'operator-1', created_at: '2026-10-03T00:00:00.000Z' }] }))
      .toEqual({ kind: 'manual_rate_link', recordId: 'l-1' });
  });

  it('rejects records that do not prove an operator closed this finding', () => {
    const closed = { ...none, decisions: [{ id: 'd-1', status: 'resolved' }] };
    // Review-only feedback closed nothing.
    expect(operatorClearanceOf(finding({ linked_decision_id: 'd-1' }),
      { ...closed, decisionFeedback: [feedback({ is_correct: false, feedback_type: 'incorrect' })] })).toBeNull();
    // Unattributed feedback is not an operator's.
    expect(operatorClearanceOf(finding({ linked_decision_id: 'd-1' }),
      { ...closed, decisionFeedback: [feedback({ created_by: null, decision_status_at_feedback: 'resolved' })] })).toBeNull();
    // An execution item with no outcome was never decided.
    expect(operatorClearanceOf(finding({ linked_action_id: 'i-1' }), { ...none, executionItems: [{ id: 'i-1', outcome: null }] })).toBeNull();
    // A link for another line, a link made after the finding closed, or a rule a link does not close.
    const link = { id: 'l-1', invoice_line_subject_id: 'line-1', actor_id: 'operator-1', created_at: '2026-10-05T00:00:00.000Z' };
    expect(operatorClearanceOf(finding({ rule_id: 'FINANCIAL_RATE_CODE_MISSING' }), { ...none, rateLinks: [link] })).toBeNull();
    expect(operatorClearanceOf(finding({ rule_id: 'FINANCIAL_RATE_CODE_MISSING', subject_id: 'line-2' }),
      { ...none, rateLinks: [{ ...link, created_at: '2026-10-01T00:00:00.000Z' }] })).toBeNull();
    expect(operatorClearanceOf(finding(), { ...none, rateLinks: [{ ...link, created_at: '2026-10-01T00:00:00.000Z' }] })).toBeNull();
  });
});
