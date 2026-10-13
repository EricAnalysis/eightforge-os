import { describe, expect, it, vi } from 'vitest';
import { handleReadOwnWorkflowAssessment } from '@/app/api/workflow-intake/[submissionId]/route';
const ID = '11111111-1111-4111-8111-111111111111';
const actor = async () => ({ ok: true as const, actor: {
  actorId: 'actor-a', organizationId: 'org-a', role: 'member', email: null, displayName: null,
} });
const request = () => new Request('https://example.test/api/workflow-intake/' + ID);
describe('customer assessment reads are authenticated and organization scoped', () => {
  it('denies anonymous access without any evidence read', async () => {
    const rpc = vi.fn();
    const result = await handleReadOwnWorkflowAssessment(request(), ID, {
      actor: async () => ({ ok: false as const, status: 401, error: 'Unauthorized' }), admin: { rpc } as never,
    });
    expect(result.status).toBe(401); expect(rpc).not.toHaveBeenCalled();
  });
  it('uses only verified actor organization and returns own-source proposals', async () => {
    const rpc = vi.fn(async () => ({ data: { source: { organization_id: 'org-a' }, assessment: { authority: 'non_authoritative' } }, error: null }));
    const result = await handleReadOwnWorkflowAssessment(new Request('https://example.test/x?organizationId=org-b'), ID, { actor, admin: { rpc } as never });
    expect(result.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('read_organization_workflow_assessment', { p_submission_id: ID, p_organization_id: 'org-a' });
  });
  it('foreign tenant and historic unassigned sources are not found', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    expect((await handleReadOwnWorkflowAssessment(request(), ID, { actor, admin: { rpc } as never })).status).toBe(404);
  });
});
