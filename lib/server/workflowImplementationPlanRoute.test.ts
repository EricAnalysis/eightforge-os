import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/server/workflowImplementationPlanRead', () => ({ readWorkflowImplementationPlan: mocks.read }));
import * as route from '@/app/api/internal/workflow-assessments/[assessmentId]/implementation-plan/route';

const pin = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 3,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 7,
};
const context = { params: Promise.resolve({ assessmentId: pin.assessmentId }) };
function request(query = new URLSearchParams({
  assessmentVersion: String(pin.assessmentVersion), reviewId: pin.reviewId, reviewVersion: String(pin.reviewVersion),
})) {
  return new Request(`https://example.test/api/internal/workflow-assessments/${pin.assessmentId}/implementation-plan?${query}`);
}

describe('trusted implementation plan GET route', () => {
  beforeEach(() => vi.resetAllMocks());

  it('passes the unchanged request and full exact pin; returns the complete plan unchanged', async () => {
    const plan = {
      domain: 'eightforge.implementation-plan', schemaVersion: 1,
      authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
      source: { pin, effectiveReviewedSpecificationDigestSha256: 'resolver-digest' },
      plannedSteps: [{ stepId: 'recover', specification: { recoveryType: 'unresolved' },
        provenance: { ...pin, stepReviewId: 'immutable-child' },
        implementationReadiness: { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' } }],
      rejectedSteps: [{ stepId: 'rejected', disposition: 'rejected' }],
      digest: { algorithm: 'sha256', value: 'plan-digest' },
    };
    mocks.read.mockResolvedValue({
      ok: true, artifact: plan, evidence: { private: 'resolver evidence' }, paths: ['private.evidence.path'],
    });
    const req = request();
    const parse = vi.spyOn(req, 'json');
    const text = vi.spyOn(req, 'text');
    const response = await route.GET(req, context);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(req, pin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body).toEqual({ ok: true, plan });
    expect(parse).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthorized', 401], ['reviewer_not_eligible', 403], ['not_configured', 503],
    ['invalid_pin', 400], ['assessment_not_found', 404], ['review_not_found', 404],
    ['invalid_json', 422], ['invalid_evidence', 422], ['assessment_pin_mismatch', 422],
    ['review_pin_mismatch', 422], ['source_submission_mismatch', 422],
    ['step_review_parent_mismatch', 422], ['duplicate_step_review', 422], ['orphan_step_review', 422],
    ['missing_step_review', 422], ['classification_mismatch', 422], ['incoherent_disposition', 422],
    ['proposal_not_composable', 422], ['invalid_specification', 422], ['overall_disposition_mismatch', 422],
    ['plan_not_composable', 500], ['read_failed', 500],
  ])('maps %s to %s without partial plans or internal details', async (code, status) => {
    mocks.read.mockResolvedValue({
      ok: false, code, evidence: { private: 'resolver evidence' }, paths: ['private.evidence.path'],
    });
    const response = await route.GET(request(), context);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: false, error: code });
    expect(mocks.read).toHaveBeenCalledOnce();
  });

  it.each(['assessmentVersion', 'reviewVersion'])('rejects malformed %s without reads', async (key) => {
    for (const value of ['', '0', '-1', '1.0', '1.5', '1e2', '+1', ' 1', '1 ', '01', '0x10', 'NaN', 'Infinity', '2147483648', '9007199254740993']) {
      const query = new URL(request().url).searchParams;
      query.set(key, value);
      const response = await route.GET(request(query), context);
      expect(response.status, value).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: 'invalid_pin' });
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(['assessmentVersion', 'reviewVersion'])('accepts maximum valid %s', async (key) => {
    const query = new URL(request().url).searchParams;
    query.set(key, '2147483647');
    mocks.read.mockResolvedValue({ ok: false, code: 'review_not_found' });
    await route.GET(request(query), context);
    expect(mocks.read.mock.calls[0]![1]).toEqual({ ...pin, [key]: 2147483647 });
  });

  it.each(['assessmentVersion', 'reviewId', 'reviewVersion'])('rejects missing or duplicate %s', async (key) => {
    const missing = new URL(request().url).searchParams;
    missing.delete(key);
    const duplicate = new URL(request().url).searchParams;
    duplicate.append(key, duplicate.get(key)!);
    for (const query of [missing, duplicate]) {
      expect((await route.GET(request(query), context)).status).toBe(400);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(['assessmentId', 'effectiveReviewedSpecification', 'resolverArtifact', 'resolverDigest',
    'implementationPlan', 'planArtifact', 'planDigest', 'steps', 'readiness', 'unknown'])('rejects injected %s', async (key) => {
    const query = new URL(request().url).searchParams;
    query.set(key, '{}');
    expect((await route.GET(request(query), context)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('passes malformed UUIDs unchanged for authoritative seam validation', async () => {
    const query = new URL(request().url).searchParams;
    query.set('reviewId', 'not-a-uuid');
    mocks.read.mockResolvedValue({ ok: false, code: 'invalid_pin' });
    const response = await route.GET(request(query), { params: Promise.resolve({ assessmentId: 'bad-id' }) });
    expect(response.status).toBe(400);
    expect(mocks.read.mock.calls[0]![1]).toEqual({ ...pin, assessmentId: 'bad-id', reviewId: 'not-a-uuid' });
  });

  it('rejects a non-null body without parsing it or reading evidence', async () => {
    const req = request();
    // Fetch prohibits constructing GET bodies; simulate a nonconforming adapter.
    Object.defineProperty(req, 'body', { value: new ReadableStream() });
    const parse = vi.spyOn(req, 'json');
    const text = vi.spyOn(req, 'text');
    expect((await route.GET(req, context)).status).toBe(400);
    expect(parse).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('does not expose transport exceptions', async () => {
    mocks.read.mockRejectedValue(new Error('private database detail'));
    const response = await route.GET(request(), context);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: 'read_failed' });
  });

  it('exports only GET and explicit uncached Node runtime configuration', () => {
    expect(Object.keys(route).sort()).toEqual(['GET', 'dynamic', 'runtime']);
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
  });
});
