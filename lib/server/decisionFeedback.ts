// lib/server/decisionFeedback.ts
// Server-only: logs human decision status changes to public.decision_feedback.
// Use from API routes / server code with getSupabaseAdmin().

import type { SupabaseClient } from '@supabase/supabase-js';

export type LogDecisionFeedbackParams = {
  organization_id: string;
  decision_id: string;
  new_status: string;
  previous_status: string | null;
  created_by: string;
};

function feedbackTypeAndDisposition(status: string): {
  feedback_type: 'triage' | 'resolution' | 'suppression';
  disposition: 'resolved' | 'suppressed' | null;
} {
  switch (status) {
    case 'resolved':
      return { feedback_type: 'resolution', disposition: 'resolved' };
    case 'suppressed':
      return { feedback_type: 'suppression', disposition: 'suppressed' };
    case 'open':
    case 'in_review':
    default:
      return { feedback_type: 'triage', disposition: null };
  }
}

/**
 * Inserts one row into public.decision_feedback for a status change (audit log).
 * Does not throw; returns { ok, error } so callers can log and continue.
 */
export async function logDecisionFeedback(
  admin: SupabaseClient,
  params: LogDecisionFeedbackParams
): Promise<{ ok: boolean; error?: string }> {
  const { feedback_type, disposition } = feedbackTypeAndDisposition(params.new_status);
  const now = new Date().toISOString();
  const metadata = {
    previous_status: params.previous_status,
    source: 'ui_status_change',
  };

  const { error } = await admin.from('decision_feedback').insert({
    organization_id: params.organization_id,
    decision_id: params.decision_id,
    feedback_type,
    is_correct: null,
    disposition,
    notes: null,
    created_by: params.created_by,
    created_at: now,
    updated_at: now,
    decision_status_at_feedback: params.new_status,
    metadata,
  });

  if (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
