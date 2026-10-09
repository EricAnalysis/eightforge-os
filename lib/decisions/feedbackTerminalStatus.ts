/**
 * When an operator's decision feedback closes a decision. Pure and shared:
 * the feedback route applies it to close decisions, and finding persistence
 * reads it to tell an operator's clearance from a run that simply did not
 * observe a finding.
 */

/**
 * The decision status a feedback submission finalizes, if any. The feedback
 * route closes a decision on exactly these submissions; it is shared so that
 * whoever asks "did an operator close this?" reads the same rule.
 */
export function terminalStatusForFeedback(params: {
  isCorrect: boolean;
  feedbackType: string;
  disposition: string | null;
}): 'resolved' | 'dismissed' | null {
  if (params.disposition === 'suppress') return 'dismissed';
  if (params.isCorrect && params.feedbackType === 'correct' && params.disposition === 'accept') {
    return 'resolved';
  }

  return null;
}

/** A persisted `decision_feedback` row as either feedback path writes it. */
export type DecisionFeedbackRecord = Readonly<{
  decision_id: string;
  created_by: string | null;
  decision_status_at_feedback: string | null;
  disposition: string | null;
  is_correct: boolean | null;
  feedback_type: string | null;
}>;

/**
 * The terminal status an operator's feedback row recorded: the status route
 * records it directly (`logDecisionFeedback`), the feedback route through its
 * disposition. Null for review-only feedback that closed nothing.
 */
export function terminalStatusOfFeedbackRecord(row: DecisionFeedbackRecord): 'resolved' | 'dismissed' | null {
  if (row.decision_status_at_feedback === 'resolved' || row.decision_status_at_feedback === 'dismissed') {
    return row.decision_status_at_feedback;
  }
  if (row.disposition === 'resolved' || row.disposition === 'dismissed') return row.disposition;
  return terminalStatusForFeedback({
    isCorrect: row.is_correct === true,
    feedbackType: row.feedback_type ?? '',
    disposition: row.disposition,
  });
}
