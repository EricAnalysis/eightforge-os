// lib/server/legacyWorkflowEngine.ts
// LEGACY: Workflow engine driven by workflow_rules table (condition_type/condition_value matching).
// Preserved for the existing jobs/process pipeline. New rule-based workflow task creation
// lives in workflowEngine.ts.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { WorkflowEvent, WorkflowRule } from '@/lib/types/workflow';

type DecisionInput = { decision_type: string; decision_value: string | null };

type ReviewsInsertColumns = {
  document_id: boolean;
  title: boolean;
  review_type: boolean;
  priority: boolean;
};

let _reviewCols: ReviewsInsertColumns | null = null;

async function detectReviewsColumns(): Promise<ReviewsInsertColumns> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { document_id: false, title: false, review_type: false, priority: false };
  }

  const probe = async (col: keyof ReviewsInsertColumns): Promise<boolean> => {
    // This is a lightweight runtime schema check: if PostgREST errors on unknown
    // columns, we treat it as absent. We keep the insert minimal when in doubt.
    const { error } = await admin.from('reviews').select(col).limit(1);
    return !error;
  };

  return {
    document_id: await probe('document_id'),
    title: await probe('title'),
    review_type: await probe('review_type'),
    priority: await probe('priority'),
  };
}

async function getReviewsInsertColumns(): Promise<ReviewsInsertColumns> {
  if (_reviewCols) return _reviewCols;
  _reviewCols = await detectReviewsColumns();
  return _reviewCols;
}

async function insertWorkflowEvent(params: {
  organizationId: string;
  documentId: string | null;
  ruleId: string | null;
  eventType: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  payload: Record<string, unknown> | null;
  errorMessage: string | null;
}): Promise<WorkflowEvent | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data, error } = await admin
    .from('workflow_events')
    .insert({
      organization_id: params.organizationId,
      document_id: params.documentId,
      rule_id: params.ruleId,
      event_type: params.eventType,
      status: params.status,
      payload: params.payload,
      error_message: params.errorMessage,
      created_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error || !data) {
    console.error('[workflowEngine] workflow_event insert error:', error);
    return null;
  }
  return data as WorkflowEvent;
}

export async function runWorkflowEngine(params: {
  documentId: string;
  organizationId: string;
  decisions: DecisionInput[];
}): Promise<WorkflowEvent[]> {
  try {
    const admin = getSupabaseAdmin();
    if (!admin) return [];

    const { data: rules, error: rulesError } = await admin
      .from('workflow_rules')
      .select('*')
      .eq('organization_id', params.organizationId)
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (rulesError) {
      console.error('[workflowEngine] rules load error:', rulesError);
      return [];
    }

    const ruleRows = (rules ?? []) as WorkflowRule[];
    if (ruleRows.length === 0) return [];

    const createdEvents: WorkflowEvent[] = [];

    const hasMatch = (rule: WorkflowRule) =>
      params.decisions.some(
        (d) =>
          d.decision_type === rule.condition_type &&
          (d.decision_value ?? null) === rule.condition_value
      );

    const reviewCols = await getReviewsInsertColumns();

    for (const rule of ruleRows) {
      if (!hasMatch(rule)) continue;

      const payload = rule.action_payload ?? {};
      const action = rule.action_type;

      if (action === 'create_review') {
        let status: WorkflowEvent['status'] = 'completed';
        let errorMessage: string | null = null;
        let reviewId: string | null = null;

        try {
          const insertRow: Record<string, unknown> = {
            organization_id: params.organizationId,
            status: 'pending',
            created_at: new Date().toISOString(),
          };

          if (reviewCols.document_id) insertRow.document_id = params.documentId;
          if (reviewCols.title) {
            insertRow.title =
              (typeof payload.title === 'string' && payload.title.trim()) ||
              'Document Review';
          }
          if (reviewCols.review_type) {
            insertRow.review_type =
              (typeof payload.review_type === 'string' && payload.review_type.trim()) ||
              'general';
          }
          if (reviewCols.priority) {
            insertRow.priority =
              (typeof payload.priority === 'string' && payload.priority.trim()) ||
              'normal';
          }

          const { data: reviewRow, error: reviewErr } = await admin
            .from('reviews')
            .insert(insertRow)
            .select('id')
            .single();

          if (reviewErr) {
            status = 'failed';
            errorMessage = reviewErr.message;
          } else {
            reviewId = (reviewRow as { id?: string } | null)?.id ?? null;
          }
        } catch (e) {
          status = 'failed';
          errorMessage = e instanceof Error ? e.message : 'Unknown error';
        }

        const ev = await insertWorkflowEvent({
          organizationId: params.organizationId,
          documentId: params.documentId,
          ruleId: rule.id,
          eventType: 'review_created',
          status,
          payload: {
            rule_name: rule.name,
            review_id: reviewId,
            action_payload: payload,
          },
          errorMessage,
        });
        if (ev) createdEvents.push(ev);
        continue;
      }

      if (action === 'flag_document') {
        const flag = typeof payload.flag === 'string' ? payload.flag : 'flagged';
        const note = typeof payload.note === 'string' ? payload.note : null;
        const ev = await insertWorkflowEvent({
          organizationId: params.organizationId,
          documentId: params.documentId,
          ruleId: rule.id,
          eventType: 'document_flagged',
          status: 'completed',
          payload: { flag, note, document_id: params.documentId },
          errorMessage: null,
        });
        if (ev) createdEvents.push(ev);
        continue;
      }

      // log_event and unimplemented actions: create an event row only
      const ev = await insertWorkflowEvent({
        organizationId: params.organizationId,
        documentId: params.documentId,
        ruleId: rule.id,
        eventType: action === 'log_event' ? 'event_logged' : 'action_stubbed',
        status: 'completed',
        payload: {
          rule_name: rule.name,
          action_type: action,
          action_payload: payload,
        },
        errorMessage: null,
      });
      if (ev) createdEvents.push(ev);
    }

    return createdEvents;
  } catch (err) {
    console.error('[workflowEngine] unhandled error:', err);
    return [];
  }
}

