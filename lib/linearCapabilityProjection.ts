import { z } from 'zod';

import {
  ApprovedEngineeringRequestSchema,
  type ApprovedEngineeringRequest,
} from '@/lib/approvedEngineeringRequest';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { RepositoryRelativePathSchema } from '@/lib/repositoryPlanEvidence';

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceRef = z.string().regex(/^ev_[a-f0-9]{64}$/);

export const LinearProjectionEvidenceBindingSchema = z.object({
  evidenceRef,
  filePath: RepositoryRelativePathSchema,
  blobSha: sha1,
  commitSha: sha1,
}).strict();
export type LinearProjectionEvidenceBinding = z.infer<typeof LinearProjectionEvidenceBindingSchema>;

const projectionSourceSchema = z.object({
  engineeringRequestDigestSha256: sha256,
  planV2RunId: z.string().uuid(),
  planV2DigestSha256: sha256,
  recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/),
  reviewId: z.string().uuid(),
  reviewVersion: z.number().int().positive(),
  reviewRequestDigestSha256: sha256,
  repositoryCommitSha: sha1,
}).strict();

const scopeLabelSchema = z.enum([
  'Client-specific',
  'Workflow-specific',
  'Reusable platform capability',
]);

const projectionEnvelopeSchema = z.object({
  domain: z.literal('eightforge.linear-capability-projection'),
  schemaVersion: z.literal(1),
  linearAuthority: z.literal('none'),
  linearIsInputAuthority: z.literal(false),
  projectionDirection: z.literal('eightforge_to_linear_only'),
  executable: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  source: projectionSourceSchema,
  idempotencyKey: z.string().regex(/^linear-projection:[a-f0-9]{64}$/),
  title: z.string().min(19).max(139).refine((value) => !/[\r\n]/.test(value)),
  labels: z.tuple([
    z.literal('Client Request'),
    z.literal('Forgewing Proposed'),
    z.literal('Approved for backlog'),
    scopeLabelSchema,
  ]),
  capabilitySummary: z.string().min(1).max(120).refine((value) => !/[\r\n]/.test(value)),
  approvedScope: ApprovedEngineeringRequestSchema.innerType().shape.approvedScope,
  scopeSource: z.enum(['forgewing_recommendation', 'human_reviewed_replacement']),
  capabilityScope: z.enum(['client_specific', 'workflow_specific', 'reusable_platform_capability']),
  reviewerRationale: z.string().min(1).max(4_000),
  repositoryEvidence: z.array(LinearProjectionEvidenceBindingSchema).max(20),
  description: z.string().min(1).max(100_000),
}).strict();

export const LinearCapabilityProjectionSchema = projectionEnvelopeSchema.extend({
  digest: z.object({
    algorithm: z.literal('sha256'),
    encoding: z.literal('recursive-key-sorted-json-v1'),
    value: sha256,
  }).strict(),
}).superRefine((projection, ctx) => {
  const { digest, ...envelope } = projection;
  if (hashCanonical(envelope) !== digest.value) {
    ctx.addIssue({ code: 'custom', message: 'Linear projection digest mismatch' });
  }
  const expectedKey = `linear-projection:${projection.source.engineeringRequestDigestSha256}`;
  const expectedTitle = `${projection.capabilitySummary} [EF-${projection.source.engineeringRequestDigestSha256.slice(0, 12)}]`;
  if (projection.idempotencyKey !== expectedKey || projection.title !== expectedTitle) {
    ctx.addIssue({ code: 'custom', message: 'Linear projection identity mismatch' });
  }
});
export type LinearCapabilityProjection = z.infer<typeof LinearCapabilityProjectionSchema>;

export type BuildLinearCapabilityProjectionResult =
  | Readonly<{ ok: true; projection: LinearCapabilityProjection }>
  | Readonly<{
      ok: false;
      code: 'invalid_approved_request' | 'invalid_evidence_bindings' | 'evidence_binding_mismatch';
    }>;

const capabilityScopeLabels = {
  client_specific: 'Client-specific',
  workflow_specific: 'Workflow-specific',
  reusable_platform_capability: 'Reusable platform capability',
} as const;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function bulletList(values: readonly string[]): string {
  return values.length === 0 ? '- None' : values.map((value) => `- ${value}`).join('\n');
}

function regressionGateLines(request: ApprovedEngineeringRequest): readonly string[] {
  return request.approvedScope.regressionGates.map((gate) => gate.gate === 'evidence_test'
    ? `Evidence test: ${gate.testPath} (${gate.evidenceRef})`
    : gate.gate === 'typecheck' ? 'TypeScript typecheck' : 'Production build');
}

function descriptionFor(
  request: ApprovedEngineeringRequest,
  source: z.infer<typeof projectionSourceSchema>,
  idempotencyKey: string,
  repositoryEvidence: readonly LinearProjectionEvidenceBinding[],
): string {
  const machineBlock = canonicalJson({
    schemaVersion: 1,
    linearAuthority: 'none',
    linearIsInputAuthority: false,
    projectionDirection: 'eightforge_to_linear_only',
    idempotencyKey,
    ...source,
  });
  const evidenceLines = repositoryEvidence.map((entry) =>
    `${entry.filePath} @ ${entry.commitSha}:${entry.blobSha} (${entry.evidenceRef})`);
  return [
    'NON-AUTHORITATIVE COPY — EightForge remains the source of truth.',
    '',
    '```json',
    machineBlock,
    '```',
    '',
    '## Approved capability scope',
    request.approvedScope.summary,
    '',
    `Scope source: ${request.scopeSource}`,
    `Capability scope: ${request.capabilityScope}`,
    '',
    '## Reviewer rationale',
    request.reviewer.rationale,
    '',
    '## Architecture risks',
    bulletList(request.approvedScope.architectureRisks),
    '',
    '## Regression gates',
    bulletList(regressionGateLines(request)),
    '',
    '## Stop conditions',
    bulletList(request.approvedScope.stopConditions),
    '',
    '## Repository evidence',
    bulletList(evidenceLines),
  ].join('\n');
}

/**
 * Produces the immutable one-way Linear copy contract. It performs no network,
 * persistence, repository, provider, or clock access.
 *
 * Evidence display bindings are supplied separately because the approved
 * request intentionally contains only opaque evidence IDs. They must form an
 * exact, duplicate-free closure over those IDs at the request's pinned commit.
 */
export function buildLinearCapabilityProjection(
  approvedRequest: ApprovedEngineeringRequest,
  evidenceBindings: readonly LinearProjectionEvidenceBinding[],
): BuildLinearCapabilityProjectionResult {
  const parsedRequest = ApprovedEngineeringRequestSchema.safeParse(approvedRequest);
  if (!parsedRequest.success) return { ok: false, code: 'invalid_approved_request' };
  const parsedBindings = z.array(LinearProjectionEvidenceBindingSchema).max(20).safeParse(evidenceBindings);
  if (!parsedBindings.success) return { ok: false, code: 'invalid_evidence_bindings' };

  const request = parsedRequest.data;
  const bindings = parsedBindings.data;
  const byId = new Map(bindings.map((entry) => [entry.evidenceRef, entry]));
  const expected = request.approvedScope.evidenceRefs;
  if (byId.size !== bindings.length || byId.size !== expected.length
    || bindings.some((entry) => entry.commitSha !== request.source.repositoryCommitSha)
    || expected.some((id) => !byId.has(id))
    || request.approvedScope.regressionGates.some((gate) => gate.gate === 'evidence_test'
      && byId.get(gate.evidenceRef)?.filePath !== gate.testPath)) {
    return { ok: false, code: 'evidence_binding_mismatch' };
  }

  // Preserve the approved evidence order; caller binding order is not identity.
  const repositoryEvidence = expected.map((id) => byId.get(id)!);
  const source = {
    engineeringRequestDigestSha256: request.digest.value,
    planV2RunId: request.source.planV2RunId,
    planV2DigestSha256: request.source.planV2DigestSha256,
    recommendationId: request.source.recommendationId,
    reviewId: request.source.reviewId,
    reviewVersion: request.source.reviewVersion,
    reviewRequestDigestSha256: request.source.reviewRequestDigestSha256,
    repositoryCommitSha: request.source.repositoryCommitSha,
  };
  const idempotencyKey = `linear-projection:${request.digest.value}`;
  const envelope = {
    domain: 'eightforge.linear-capability-projection' as const,
    schemaVersion: 1 as const,
    linearAuthority: 'none' as const,
    linearIsInputAuthority: false as const,
    projectionDirection: 'eightforge_to_linear_only' as const,
    executable: false as const,
    grantsExecutionAuthority: false as const,
    source,
    idempotencyKey,
    title: `${request.capabilitySummary} [EF-${request.digest.value.slice(0, 12)}]`,
    labels: [
      'Client Request',
      'Forgewing Proposed',
      'Approved for backlog',
      capabilityScopeLabels[request.capabilityScope],
    ] as const,
    capabilitySummary: request.capabilitySummary,
    approvedScope: request.approvedScope,
    scopeSource: request.scopeSource,
    capabilityScope: request.capabilityScope,
    reviewerRationale: request.reviewer.rationale,
    repositoryEvidence,
    description: descriptionFor(request, source, idempotencyKey, repositoryEvidence),
  };
  const projection = {
    ...envelope,
    digest: {
      algorithm: 'sha256' as const,
      encoding: 'recursive-key-sorted-json-v1' as const,
      value: hashCanonical(envelope),
    },
  };
  return {
    ok: true,
    projection: freeze(JSON.parse(canonicalJson(projection)) as LinearCapabilityProjection),
  };
}
