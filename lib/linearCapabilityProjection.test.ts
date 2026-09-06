import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { ApprovedEngineeringRequest } from '@/lib/approvedEngineeringRequest';
import golden from '@/lib/fixtures/linearCapabilityProjection.golden.json';
import {
  LinearCapabilityProjectionSchema,
  buildLinearCapabilityProjection,
  type LinearProjectionEvidenceBinding,
} from '@/lib/linearCapabilityProjection';

const sourceEvidenceRef = `ev_${'1'.repeat(64)}`;
const testEvidenceRef = `ev_${'2'.repeat(64)}`;
const repositoryCommitSha = '3'.repeat(40);

function approvedRequest(): ApprovedEngineeringRequest {
  const envelope = {
    domain: 'eightforge.approved-engineering-request' as const,
    schemaVersion: 1 as const,
    authorizes: 'backlog_projection' as const,
    executable: false as const,
    grantsExecutionAuthority: false as const,
    authorizesCodeExecution: false as const,
    authorizesRepositoryWrites: false as const,
    authorizesMigrations: false as const,
    authorizesDeployment: false as const,
    authorizesCanonicalFactMutation: false as const,
    authorizesWorkflowOperationalDecision: false as const,
    source: {
      planV2RunId: '11111111-1111-4111-8111-111111111111',
      planV2DigestSha256: '4'.repeat(64),
      recommendationId: `rec_${'5'.repeat(64)}`,
      reviewId: '22222222-2222-4222-8222-222222222222',
      reviewVersion: 2,
      reviewRequestDigestSha256: '6'.repeat(64),
      repositoryCommitSha,
    },
    capabilitySummary: 'Reuse canonical invoice validation',
    approvedScope: {
      capabilitySummary: 'Reuse canonical invoice validation',
      summary: 'Extend the existing validator seam without creating a second truth path.',
      evidenceRefs: [sourceEvidenceRef, testEvidenceRef],
      architectureRisks: ['Duplicate validator logic could diverge from canonical truth.'],
      regressionGates: [
        { gate: 'evidence_test' as const, evidenceRef: testEvidenceRef,
          testPath: 'lib/validator/rulePacks/invoice.test.ts' },
        { gate: 'typecheck' as const },
      ],
      stopConditions: ['canonical_truth_owner_unclear'],
      unresolvedQuestions: ['Whether the existing rule vocabulary covers the client term.'],
    },
    scopeSource: 'human_reviewed_replacement' as const,
    capabilityScope: 'reusable_platform_capability' as const,
    reviewer: {
      actorId: '33333333-3333-4333-8333-333333333333',
      rationale: 'The replacement keeps the implementation inside the reviewed validator seam.',
      disposition: 'modified' as const,
    },
  };
  return {
    ...envelope,
    digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1',
      value: hashCanonical(envelope) },
  };
}

function bindings(): LinearProjectionEvidenceBinding[] {
  return [
    { evidenceRef: sourceEvidenceRef, filePath: 'lib/validator/rulePacks/invoice.ts',
      blobSha: '7'.repeat(40), commitSha: repositoryCommitSha },
    { evidenceRef: testEvidenceRef, filePath: 'lib/validator/rulePacks/invoice.test.ts',
      blobSha: '8'.repeat(40), commitSha: repositoryCommitSha },
  ];
}

describe('deterministic Linear capability projection', () => {
  it('matches the golden projection and is independent of binding input order', () => {
    const first = buildLinearCapabilityProjection(approvedRequest(), bindings());
    const second = buildLinearCapabilityProjection(approvedRequest(), [...bindings()].reverse());
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, projection: golden });
    if (!first.ok) throw new Error(first.code);
    expect(LinearCapabilityProjectionSchema.parse(first.projection)).toEqual(first.projection);
    expect(Object.isFrozen(first.projection)).toBe(true);
    expect(Object.isFrozen(first.projection.repositoryEvidence)).toBe(true);
  });

  it('derives title, labels and idempotency only from the approved request', () => {
    const result = buildLinearCapabilityProjection(approvedRequest(), bindings());
    if (!result.ok) throw new Error(result.code);
    const digest = approvedRequest().digest.value;
    expect(result.projection.title).toBe(`Reuse canonical invoice validation [EF-${digest.slice(0, 12)}]`);
    expect(result.projection.idempotencyKey).toBe(`linear-projection:${digest}`);
    expect(result.projection.labels).toEqual([
      'Client Request', 'Forgewing Proposed', 'Approved for backlog',
      'Reusable platform capability',
    ]);
    expect(result.projection.description.startsWith(
      'NON-AUTHORITATIVE COPY — EightForge remains the source of truth.\n',
    )).toBe(true);
  });

  it.each([
    ['missing', bindings().slice(0, 1)],
    ['extra', [...bindings(), { ...bindings()[0]!, evidenceRef: `ev_${'9'.repeat(64)}` }]],
    ['duplicate', [...bindings(), bindings()[0]!]],
    ['wrong commit', [{ ...bindings()[0]!, commitSha: 'a'.repeat(40) }, bindings()[1]!]],
    ['wrong test path', [bindings()[0]!, { ...bindings()[1]!, filePath: 'lib/other.test.ts' }]],
  ])('fails closed on %s evidence bindings', (_name, evidence) => {
    expect(buildLinearCapabilityProjection(approvedRequest(), evidence))
      .toEqual({ ok: false, code: 'evidence_binding_mismatch' });
  });

  it('rejects malformed portable paths before identity reconciliation', () => {
    const evidence = [{ ...bindings()[0]!, filePath: '../private/intake.txt' }, bindings()[1]!];
    expect(buildLinearCapabilityProjection(approvedRequest(), evidence))
      .toEqual({ ok: false, code: 'invalid_evidence_bindings' });
  });

  it('projects no private intake, organization, raw-provider, operator-decision, or execution data', () => {
    const request = approvedRequest();
    const result = buildLinearCapabilityProjection(request, bindings());
    if (!result.ok) throw new Error(result.code);
    const serialized = JSON.stringify(result.projection);
    for (const forbidden of [
      'sourceSubmissionId', 'organizationId', 'workflowDescription', 'rawOutput',
      'operatorDecisionSuggestion', 'authorizesCodeExecution', request.reviewer.actorId,
    ]) expect(serialized).not.toContain(forbidden);
    expect(result.projection).toMatchObject({
      linearAuthority: 'none', linearIsInputAuthority: false,
      projectionDirection: 'eightforge_to_linear_only', executable: false,
      grantsExecutionAuthority: false,
    });
  });

  it('rejects privacy sentinel fields even when their digest is recomputed', () => {
    const sentinel = 'PRIVATE-INTAKE-SENTINEL-7f58';
    const request = approvedRequest() as ApprovedEngineeringRequest & Record<string, unknown>;
    const { digest: _digest, ...envelope } = request;
    const poisoned = { ...envelope, workflowDescription: sentinel };
    const candidate = { ...poisoned, digest: { algorithm: 'sha256',
      encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(poisoned) } };
    expect(buildLinearCapabilityProjection(candidate as ApprovedEngineeringRequest, bindings()))
      .toEqual({ ok: false, code: 'invalid_approved_request' });
    expect(JSON.stringify(golden)).not.toContain(sentinel);
  });

  it('allows consciously authored reviewer rationale and discloses it in the copy', () => {
    const request = approvedRequest();
    const rationale = 'REVIEWER-AUTHORED-SENTINEL may be projected.';
    const { digest: _digest, ...envelope } = request;
    const revisedEnvelope = { ...envelope, reviewer: { ...request.reviewer, rationale } };
    const revised = { ...revisedEnvelope, digest: { algorithm: 'sha256' as const,
      encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(revisedEnvelope) } };
    const result = buildLinearCapabilityProjection(revised, bindings());
    if (!result.ok) throw new Error(result.code);
    expect(result.projection.reviewerRationale).toBe(rationale);
    expect(result.projection.description).toContain(rationale);
  });

  it('rejects a mutated approved-request digest rather than repairing it', () => {
    const request = approvedRequest();
    const mutated = { ...request, capabilitySummary: 'Different capability' };
    expect(buildLinearCapabilityProjection(mutated, bindings()))
      .toEqual({ ok: false, code: 'invalid_approved_request' });
  });
});
