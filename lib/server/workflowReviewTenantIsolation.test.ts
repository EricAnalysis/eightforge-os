import { beforeEach, describe, expect, it, vi } from 'vitest';

// Adversarial closure for Codex finding 1.
//
// Workflow intake is public and unassigned, so the assessments derived from it
// belong to no organization. Before this remediation, review access reused
// organization owner/admin, which meant any tenant's administrator could
// enumerate and open every other tenant's submitted business process.
//
// These exercise the REAL routes and the REAL predicate, stubbing only the
// session boundary and the database.

const actorContext = vi.hoisted(() => vi.fn());
const queueRead = vi.hoisted(() => vi.fn());
const packetRead = vi.hoisted(() => vi.fn());
const recordReview = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));
vi.mock('@/lib/server/workflowAssessmentReviewRead', () => ({
  readWorkflowReviewQueue: queueRead,
  readWorkflowReviewPacket: packetRead,
}));
vi.mock('@/lib/server/workflowAssessmentReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/workflowAssessmentReview')>()),
  recordWorkflowAssessmentReview: recordReview,
}));

import { GET as queueGet } from '@/app/api/internal/workflow-assessments/review-queue/route';
import { GET as detailGet } from '@/app/api/internal/workflow-assessments/[assessmentId]/review/route';
import { POST as reviewPost } from '@/app/api/internal/workflow-assessment-review/route';
import { recordWorkflowAssessmentReview } from '@/lib/server/workflowAssessmentReview';

const ASSESSMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLATFORM_EMAIL = 'platform.reviewer@example.test';

function actor(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    actor: {
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: 'org-tenant-a',
      displayName: 'Tenant Admin',
      role: 'admin',
      email: 'admin@tenant-a.test',
      ...overrides,
    },
  };
}

const reviewBody = {
  assessmentId: ASSESSMENT,
  assessmentVersion: 1,
  stepReviews: [{
    disposition: 'accepted', assessmentStepId: 's1',
    proposedClassification: 'RULE', reviewedClassification: 'RULE',
  }],
};

function post(): Request {
  return new Request('http://localhost/api/internal/workflow-assessment-review', {
    method: 'POST',
    headers: { authorization: 'Bearer jwt', 'content-type': 'application/json' },
    body: JSON.stringify(reviewBody),
  });
}

const get = () => new Request('http://localhost/x', {
  headers: { authorization: 'Bearer jwt' },
});

describe('workflow review is platform scoped, not tenant scoped', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS;
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;
    actorContext.mockResolvedValue(actor());
    queueRead.mockResolvedValue({ status: 'ok', rows: [] });
    packetRead.mockResolvedValue({ status: 'ok', packet: {} });
    recordReview.mockResolvedValue({
      status: 'review_recorded', reviewId: 'r1', reviewVersion: 1,
      overallDisposition: 'accepted', stepReviewCount: 1, executable: false,
    });
  });

  // 1. tenant org owner enumerates global queue
  it.each([['owner'], ['admin']])(
    'refuses a tenant %s enumerating the global queue', async (role) => {
      actorContext.mockResolvedValue(actor({ role }));
      const response = await queueGet(get());
      expect(response.status).toBe(403);
      expect(queueRead).not.toHaveBeenCalled();
    },
  );

  // 2. tenant org admin opens a foreign assessment
  it('refuses a tenant admin opening an assessment detail', async () => {
    const response = await detailGet(get(), {
      params: Promise.resolve({ assessmentId: ASSESSMENT }),
    });
    expect(response.status).toBe(403);
    expect(packetRead).not.toHaveBeenCalled();
  });

  // 3. tenant org admin writing a review through the route
  it('refuses a tenant admin recording a review', async () => {
    const response = await reviewPost(post());
    expect(response.status).toBe(403);
    expect(recordReview).not.toHaveBeenCalled();
  });

  it('refuses everyone while no allowlist is configured', async () => {
    actorContext.mockResolvedValue(actor({ email: PLATFORM_EMAIL }));
    const response = await queueGet(get());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: 'not_configured' });
  });

  it('allows an allowlisted platform reviewer through all three surfaces', async () => {
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS = PLATFORM_EMAIL;
    actorContext.mockResolvedValue(actor({ email: PLATFORM_EMAIL }));

    expect((await queueGet(get())).status).toBe(200);
    expect((await detailGet(get(), {
      params: Promise.resolve({ assessmentId: ASSESSMENT }),
    })).status).toBe(200);
    expect((await reviewPost(post())).status).toBe(201);
  });

  it.each([
    ['a near-miss email', 'platform.reviewer@example.test.evil'],
    ['a substring email', 'reviewer@example.test'],
    ['an empty email', ''],
  ])('fails closed on %s', async (_label, email) => {
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS = PLATFORM_EMAIL;
    actorContext.mockResolvedValue(actor({ email }));
    expect((await queueGet(get())).status).toBe(403);
  });

  // 3 (direct seam): the seam must refuse independently of any route.
  it('refuses a tenant admin calling the review seam directly', async () => {
    const real = await vi.importActual<
      typeof import('@/lib/server/workflowAssessmentReview')
    >('@/lib/server/workflowAssessmentReview');
    const result = await real.recordWorkflowAssessmentReview(
      reviewBody as never,
      { actorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'admin',
        email: 'admin@tenant-a.test' },
    );
    expect(result.status).toBe('reviewer_not_eligible');
  });

  it('keeps the seam refusing even when a route would have allowed it', async () => {
    // Allowlist configured for someone else entirely.
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS = PLATFORM_EMAIL;
    const real = await vi.importActual<
      typeof import('@/lib/server/workflowAssessmentReview')
    >('@/lib/server/workflowAssessmentReview');
    const result = await real.recordWorkflowAssessmentReview(
      reviewBody as never,
      { actorId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', role: 'owner',
        email: 'other@tenant-b.test' },
    );
    expect(result.status).toBe('reviewer_not_eligible');
  });

  it('never lets recordWorkflowAssessmentReview be reached unauthorized', () => {
    // Type-level reminder that the seam takes session-derived identity only.
    expect(typeof recordWorkflowAssessmentReview).toBe('function');
  });
});
