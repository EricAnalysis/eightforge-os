// app/api/decisions/[id]/feedback/route.ts
// POST: submit human feedback on a decision.
// Accepts { is_correct, review_error_type?, feedback_type?, notes?, disposition?, corrected_value? }.
// Upserts on (decision_id, reviewer_id) — one feedback record per reviewer per decision.

import { NextRequest, NextResponse } from 'next/server';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { finalizeDecision, type DecisionTerminalStatus } from '@/lib/server/decisionClosure';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';
import { requestDecisionFeedbackRevalidation } from '@/lib/validator/revalidationRequests';
import type { ReviewErrorType } from '@/lib/types/documentIntelligence';

const VALID_FEEDBACK_TYPES = ['correct', 'incorrect', 'needs_review', 'override'] as const;
const VALID_DISPOSITIONS = ['accept', 'reject', 'escalate', 'suppress'] as const;
const VALID_REVIEW_ERROR_TYPES = ['extraction_error', 'rule_error', 'edge_case'] as const;
const VALID_OPERATOR_ACTIONS = ['approve', 'confirm', 'correct', 'override', 'needs_review', 'escalate', 'verify'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function terminalStatusForFeedback(params: {
  isCorrect: boolean;
  feedbackType: string;
  disposition: string | null;
}): DecisionTerminalStatus | null {
  if (params.disposition === 'suppress') return 'dismissed';
  if (params.isCorrect && params.feedbackType === 'correct' && params.disposition === 'accept') {
    return 'resolved';
  }

  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: decisionId } = await params;

  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.is_correct !== 'boolean') {
    return jsonError('is_correct (boolean) is required', 400);
  }

  // Validate optional fields
  const feedbackType: string =
    typeof body.feedback_type === 'string' && VALID_FEEDBACK_TYPES.includes(body.feedback_type)
      ? body.feedback_type
      : body.is_correct ? 'correct' : 'incorrect';

  const disposition: string | null =
    typeof body.disposition === 'string' && VALID_DISPOSITIONS.includes(body.disposition)
      ? body.disposition
      : null;

  const notes: string | null =
    typeof body.notes === 'string' && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;
  const operatorAction: string | null =
    typeof body.operator_action === 'string' && VALID_OPERATOR_ACTIONS.includes(body.operator_action)
      ? body.operator_action
      : null;

  if (feedbackType === 'override' && !notes) {
    return jsonError('Override requires a reason.', 400);
  }

  const correctedValue: Record<string, unknown> | null =
    body.corrected_value && typeof body.corrected_value === 'object'
      ? (body.corrected_value as Record<string, unknown>)
      : null;
  const reviewErrorType: ReviewErrorType | null = !body.is_correct
    ? (
        typeof body.review_error_type === 'string' &&
        VALID_REVIEW_ERROR_TYPES.includes(body.review_error_type as ReviewErrorType)
          ? (body.review_error_type as ReviewErrorType)
          : 'edge_case'
      )
    : null;
  const metadata: Record<string, unknown> = {
    review_error_type: reviewErrorType,
  };

  // Verify decision exists and belongs to caller's org
  const { data: decision, error: fetchError } = await admin
    .from('decisions')
    .select('id, organization_id, project_id, document_id, status, severity')
    .eq('id', decisionId)
    .single();

  if (fetchError || !decision) return jsonError('Decision not found', 404);

  const dec = decision as {
    id: string;
    organization_id: string;
    project_id: string | null;
    document_id: string | null;
    status: string;
    severity: string | null;
  };
  if (dec.organization_id !== organizationId) {
    return jsonError('Decision not found', 404);
  }

  const now = new Date().toISOString();

  // Upsert feedback — one record per (decision_id, reviewer_id)
  const { error: upsertError } = await admin
    .from('decision_feedback')
    .upsert(
      {
        decision_id: decisionId,
        organization_id: organizationId,
        is_correct: body.is_correct,
        feedback_type: feedbackType,
        disposition,
        notes,
        corrected_value: correctedValue,
        review_error_type: reviewErrorType,
        metadata,
        reviewer_id: actorId,
        created_by: actorId,
        created_at: now,
      },
      { onConflict: 'decision_id,reviewer_id' },
    );

  if (upsertError) return jsonError(upsertError.message, 500);

  const terminalStatus = terminalStatusForFeedback({
    isCorrect: body.is_correct,
    feedbackType,
    disposition,
  });
  const nextStatus = terminalStatus ?? (!body.is_correct && dec.status === 'open'
    ? 'in_review'
    : dec.status);

  const reviewActivityResult = await logActivityEvent({
    organization_id: organizationId,
    project_id: dec.project_id,
    entity_type: 'decision',
    entity_id: decisionId,
    event_type: 'review_recorded',
    changed_by: actorId,
    old_value: {
      status: dec.status,
    },
    new_value: {
      is_correct: body.is_correct,
      feedback_type: feedbackType,
      disposition,
      operator_action: operatorAction,
      review_error_type: reviewErrorType,
      corrected_value: correctedValue,
      notes,
      status_after_feedback: nextStatus,
    },
  });

  if (!reviewActivityResult.ok) {
    console.error('[decision/feedback] activity event failed:', reviewActivityResult.error);
  }

  if (terminalStatus) {
    try {
      const result = await finalizeDecision({
        admin,
        decision: dec,
        organizationId,
        actorId,
        status: terminalStatus,
        operatorAction,
        writeLegacyFeedback: false,
      });

      if (terminalStatus === 'dismissed') {
        void requestDecisionFeedbackRevalidation({
          projectId: dec.project_id,
          actorId,
          feedbackType: feedbackType as 'correct' | 'incorrect' | 'needs_review' | 'override',
        });
      }

      return NextResponse.json({
        ok: true,
        feedback_type: feedbackType,
        review_error_type: reviewErrorType,
        status: result.decision.status,
      });
    } catch (err) {
      console.error('[decision/feedback] finalizeDecision failed', {
        decisionId,
        terminalStatus,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonError('Failed to finalize decision', 500);
    }
  }

  // If reviewer marks incorrect, auto-move decision to in_review if currently open
  if (!body.is_correct && dec.status === 'open') {
    const { error: statusUpdateError } = await admin
      .from('decisions')
      .update({ status: 'in_review', updated_at: now })
      .eq('id', decisionId)
      .eq('organization_id', organizationId);

    if (statusUpdateError) {
      return jsonError(statusUpdateError.message, 500);
    }

    const statusActivityResult = await logActivityEvent({
      organization_id: organizationId,
      project_id: dec.project_id,
      entity_type: 'decision',
      entity_id: decisionId,
      event_type: 'status_changed',
      changed_by: actorId,
      old_value: { status: dec.status },
      new_value: { status: 'in_review' },
    });

    if (!statusActivityResult.ok) {
      console.error('[decision/feedback] status activity event failed:', statusActivityResult.error);
    }

    await processWorkflowTriggers({
      organizationId,
      eventType: 'status_changed',
      entityType: 'decision',
      entityId: decisionId,
      payload: {
        from: dec.status,
        to: 'in_review',
        severity: dec.severity,
      },
    });
  }

  void requestDecisionFeedbackRevalidation({
    projectId: dec.project_id,
    actorId,
    feedbackType: feedbackType as 'correct' | 'incorrect' | 'needs_review' | 'override',
  });

  return NextResponse.json({ ok: true, feedback_type: feedbackType, review_error_type: reviewErrorType });
}
