import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdmin = vi.hoisted(() => vi.fn());
const loadIntake = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getAdmin }));
vi.mock('@/lib/server/workflowIntakeRead', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/workflowIntakeRead')>()),
  loadWorkflowIntakeSubmission: loadIntake,
}));

import { WORKFLOW_ASSESSMENT_TABLE } from '@/lib/server/workflowAssessment';
import {
  WORKFLOW_ASSESSMENT_REVIEW_TABLE as CANONICAL_REVIEW_TABLE,
  WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE as CANONICAL_STEP_TABLE,
} from '@/lib/server/workflowAssessmentReview';
import {
  readWorkflowReviewPacket,
  readWorkflowReviewQueue,
  WORKFLOW_ASSESSMENT_REVIEW_TABLE,
  WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE,
  WORKFLOW_REVIEW_QUEUE_FUNCTION,
} from '@/lib/server/workflowAssessmentReviewRead';

const ASSESSMENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUBMISSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const QUEUE_ROW = {
  assessment_id: ASSESSMENT,
  assessment_version: 2,
  source_submission_id: SUBMISSION,
  created_at: '2026-09-01T00:00:00.000Z',
  summary: 'Freight ticket reconciliation.',
  step_count: 7,
  grounded_unverified_count: 3,
  steps_with_gaps_count: 1,
  human_decision_count: 2,
  review_state: 'pending_review',
};

describe('workflow review table names', () => {
  // The read seam restates these rather than importing the guarded write seams.
  // This is what stops the restatement from becoming a second source of truth.
  it('matches the canonical table names', () => {
    expect(WORKFLOW_ASSESSMENT_REVIEW_TABLE).toBe(CANONICAL_REVIEW_TABLE);
    expect(WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE).toBe(CANONICAL_STEP_TABLE);
    expect(WORKFLOW_ASSESSMENT_TABLE).toBe('workflow_assessments');
  });
});

describe('workflow review queue read', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('projects rows through the database function', async () => {
    const rpc = vi.fn(async (_name: string, _args?: Record<string, unknown>) =>
      ({ data: [QUEUE_ROW], error: null }));
    getAdmin.mockReturnValue({ rpc });
    const result = await readWorkflowReviewQueue();
    expect(rpc.mock.calls[0]![0]).toBe(WORKFLOW_REVIEW_QUEUE_FUNCTION);
    expect(result).toEqual({
      status: 'ok',
      rows: [{
        assessmentId: ASSESSMENT,
        assessmentVersion: 2,
        sourceSubmissionId: SUBMISSION,
        createdAt: '2026-09-01T00:00:00.000Z',
        summary: 'Freight ticket reconciliation.',
        stepCount: 7,
        groundedUnverifiedCount: 3,
        stepsWithGapsCount: 1,
        humanDecisionCount: 2,
        reviewState: 'pending_review',
      }],
    });
  });

  it('never exposes the assessment payload to a list view', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ ...QUEUE_ROW, assessment: { workflowSteps: [{ stepId: 's1' }] } }],
      error: null,
    }));
    getAdmin.mockReturnValue({ rpc });
    const result = await readWorkflowReviewQueue();
    expect(JSON.stringify(result)).not.toContain('workflowSteps');
  });

  it.each([
    ['a row missing an id', { ...QUEUE_ROW, assessment_id: null }],
    ['a row missing a submission', { ...QUEUE_ROW, source_submission_id: null }],
    ['a non-object row', 'nonsense'],
  ])('drops %s rather than emitting a broken entry', async (_l, row) => {
    getAdmin.mockReturnValue({ rpc: vi.fn(async () => ({ data: [row], error: null })) });
    const result = await readWorkflowReviewQueue();
    expect(result).toEqual({ status: 'ok', rows: [] });
  });

  it('reports read failure without leaking the database reason upward', async () => {
    getAdmin.mockReturnValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: 'relation denied' } })),
    });
    const result = await readWorkflowReviewQueue();
    expect(result.status).toBe('read_failed');
  });

  it('reports not_configured without a service client', async () => {
    getAdmin.mockReturnValue(null);
    await expect(readWorkflowReviewQueue()).resolves.toEqual({ status: 'not_configured' });
  });
});

describe('workflow review packet read', () => {
  const assessmentPayload = {
    summary: 'Freight ticket reconciliation.',
    workflowSteps: [{ stepId: 's1', classification: 'RULE' }],
  };

  function client(overrides: {
    assessment?: unknown; assessmentError?: unknown;
    review?: unknown[]; steps?: unknown[];
  } = {}) {
    const from = vi.fn((table: string) => {
      if (table === 'workflow_assessments') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                // `in` rather than `??`, so an explicit null can express a
                // missing row instead of silently falling back to the default.
                data: 'assessment' in overrides ? overrides.assessment : {
                  id: ASSESSMENT, source_submission_id: SUBMISSION,
                  assessment_version: 1, assessment: assessmentPayload,
                  authority: 'non_authoritative', requires_human_review: true,
                  created_at: '2026-09-01T00:00:00.000Z',
                },
                error: overrides.assessmentError ?? null,
              }),
            }),
          }),
        };
      }
      if (table === 'workflow_assessment_reviews') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: async () => ({ data: overrides.review ?? [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: async () => ({ data: overrides.steps ?? [], error: null }),
        }),
      };
    });
    getAdmin.mockReturnValue({ from });
    return from;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadIntake.mockResolvedValue({
      submissionId: SUBMISSION,
      submissionSchemaVersion: 'workflow_intake_v1',
      answers: { workflowDescription: 'We reconcile freight tickets.' },
    });
  });

  it('returns intake, assessment, and a null review when none exists', async () => {
    client();
    const result = await readWorkflowReviewPacket(ASSESSMENT);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.packet.existingReview).toBeNull();
    expect(result.packet.assessment).toEqual(assessmentPayload);
    expect(result.packet.intake.workflowDescription).toContain('freight tickets');
    expect(result.packet.authority).toBe('non_authoritative');
    expect(result.packet.requiresHumanReview).toBe(true);
  });

  it('includes a recorded review so the surface can render read-only', async () => {
    client({
      review: [{
        id: 'r1', review_version: 1, overall_disposition: 'changes_required',
        reviewer_summary: null, reviewer_actor_id: 'u1',
        created_at: '2026-09-01T01:00:00.000Z',
      }],
      steps: [{
        assessment_step_id: 's1', proposed_classification: 'RULE',
        reviewed_classification: 'HUMAN', disposition: 'reclassified',
        reviewer_notes: 'Not delegable.', accepted_specification: { description: 'x' },
      }],
    });
    const result = await readWorkflowReviewPacket(ASSESSMENT);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.packet.existingReview?.overallDisposition).toBe('changes_required');
    expect(result.packet.existingReview?.stepReviews[0]).toMatchObject({
      proposedClassification: 'RULE', reviewedClassification: 'HUMAN',
    });
  });

  it('reports assessment_not_found for a missing row', async () => {
    client({ assessment: null });
    await expect(readWorkflowReviewPacket(ASSESSMENT))
      .resolves.toEqual({ status: 'assessment_not_found' });
  });

  it('reports assessment_not_found when the intake cannot be read', async () => {
    client();
    loadIntake.mockResolvedValue(null);
    await expect(readWorkflowReviewPacket(ASSESSMENT))
      .resolves.toEqual({ status: 'assessment_not_found' });
  });

  it('never writes anything', async () => {
    const from = client();
    await readWorkflowReviewPacket(ASSESSMENT);
    for (const call of from.mock.results) {
      const builder = call.value as Record<string, unknown>;
      expect(builder.insert).toBeUndefined();
      expect(builder.update).toBeUndefined();
      expect(builder.delete).toBeUndefined();
    }
  });
});
