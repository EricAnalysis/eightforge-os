import {
  runValueReading,
  type ValueReadingEngineClient,
  type ValueReadingEngineDependencies,
  type ValueReadingRunResult,
} from '@/lib/server/valueReadingEngine';
import {
  loadValueReadingProposalById,
  recordValueReadingReview,
  VALUE_READING_PROPOSAL_ID_PATTERN,
  type ValueReadingClient,
  type ValueReadingReviewDisposition,
} from '@/lib/server/valueReadingProposals';

/**
 * The Resolution Workspace's two Forgewing value-reading writes (B4.4):
 * asking Forgewing to read an unread line, and rejecting or deferring a
 * reading. Neither writes truth. Using a reading is a reviewed value through
 * the unchanged B3 route, which cites the proposal for the database to verify.
 *
 * No provider and no region renderer are wired yet (B4.5), so an ask that
 * passes every gate records `recovery_disabled / provider_not_configured`.
 * In production the deployment gates refuse first, and that is recorded too.
 */

export type HttpResult = Readonly<{ status: number; body: Readonly<Record<string, unknown>> }>;

const DIGEST = /^[0-9a-f]{64}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;
}

export async function requestValueReadingFromWorkspace(params: Readonly<{
  admin: ValueReadingEngineClient;
  organizationId: string;
  actorId: string;
  projectId: string;
  body: unknown;
  engine?: ValueReadingEngineDependencies;
  run?: typeof runValueReading;
}>): Promise<HttpResult> {
  const body = params.body && typeof params.body === 'object' ? params.body as Record<string, unknown> : {};
  const caseId = text(body.caseId, 1000);
  const requestKey = text(body.requestKey, 200);
  // Malformed requests reach no engine and record nothing.
  if (!caseId || !requestKey) return { status: 400, body: { error: 'caseId and requestKey are required' } };
  const result: ValueReadingRunResult = await (params.run ?? runValueReading)(params.admin, {
    organizationId: params.organizationId,
    projectId: params.projectId,
    caseId,
    requestedBy: params.actorId,
    requestKey,
    // Text excerpts are opt-in and not yet offered in the workspace.
    includeTextExcerpts: false,
  }, params.engine ?? {});
  if (result.status === 'not_resolved') {
    if (result.reason === 'read_failed') return { status: 500, body: { error: 'The case could not be read' } };
    return result.reason === 'case_not_found'
      ? { status: 404, body: { error: 'Case not found' } }
      : { status: 409, body: { error: 'This line is no longer open for reading; reload the case.', code: result.reason } };
  }
  return {
    status: 200,
    body: {
      outcome: result.outcome,
      proposalId: result.proposal?.proposalId ?? null,
      replayed: result.replayed,
    },
  };
}

export async function reviewValueReadingFromWorkspace(params: Readonly<{
  admin: ValueReadingClient;
  organizationId: string;
  actorId: string;
  projectId: string;
  body: unknown;
}>): Promise<HttpResult> {
  const body = params.body && typeof params.body === 'object' ? params.body as Record<string, unknown> : {};
  const proposalId = typeof body.proposalId === 'string' && VALUE_READING_PROPOSAL_ID_PATTERN.test(body.proposalId)
    ? body.proposalId : null;
  const digest = typeof body.proposalDigestSha256 === 'string' && DIGEST.test(body.proposalDigestSha256)
    ? body.proposalDigestSha256 : null;
  const disposition: ValueReadingReviewDisposition | null = body.disposition === 'rejected' ? 'rejected'
    : body.disposition === 'deferred' ? 'deferred' : null;
  const rationale = text(body.rationale, 4000);
  const idempotencyKey = text(body.idempotencyKey, 200);
  if (!proposalId || !digest || !disposition || !rationale || !idempotencyKey) {
    return { status: 400, body: { error: 'proposalId, proposalDigestSha256, a rejected or deferred disposition, '
      + 'rationale and idempotencyKey are required' } };
  }
  // The proposal must belong to this organization and this project.
  const proposal = await loadValueReadingProposalById(params.admin, { organizationId: params.organizationId, proposalId });
  if (!proposal || proposal.binding.projectId !== params.projectId || proposal.proposalDigestSha256 !== digest) {
    return { status: 404, body: { error: 'Suggestion not found' } };
  }
  const recorded = await recordValueReadingReview(params.admin, {
    organizationId: params.organizationId, reviewerActorId: params.actorId, proposalId,
    proposalDigestSha256: digest, disposition, rationale, idempotencyKey,
  });
  if (recorded.status !== 'recorded') return { status: 422, body: { error: recorded.reason } };
  return {
    status: recorded.inserted ? 201 : 200,
    body: { reviewId: recorded.reviewId, reviewVersion: recorded.reviewVersion, disposition },
  };
}
