import { describe, expect, it } from 'vitest';

import { buildApprovedEngineeringRequest } from '@/lib/approvedEngineeringRequest';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { repositoryPlanRecommendationId } from '@/lib/repositoryPlanGuidance';
import type { RepositoryAwareImplementationPlanV2Artifact } from '@/lib/repositoryAwareImplementationPlan';
import type { WorkflowEngineeringReviewEvidence } from '@/lib/workflowEngineeringReview';

const planV1Digest = '1'.repeat(64);
const inputDigest = '2'.repeat(64);
const commitSha = 'a'.repeat(40);
const evidenceRef = `ev_${'b'.repeat(64)}`;
const recommendationId = repositoryPlanRecommendationId(planV1Digest, 'RULE', 'step-1', 'reuse_existing_rule');
const originalScope = {
  capabilitySummary: 'Reuse the qualified rule seam', summary: 'Use the exact qualified rule seam.',
  evidenceRefs: [evidenceRef], architectureRisks: ['Preserve the authority boundary.'],
  regressionGates: [{ gate: 'typecheck' as const }], stopConditions: [], unresolvedQuestions: [],
};

function plan(): RepositoryAwareImplementationPlanV2Artifact {
  const guidanceEnvelope = {
    domain: 'eightforge.repository-plan-guidance' as const, schemaVersion: 1 as const,
    stage: 'provider_output_validated' as const, authority: 'non_authoritative' as const,
    executable: false as const, grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    sourceGuidanceInputDigestSha256: inputDigest, sourceImplementationPlanV1DigestSha256: planV1Digest,
    classification: 'RULE' as const,
    recommendations: [{ stepId: 'step-1', recommendationKind: 'reuse_existing_rule' as const,
      recommendationId, ...originalScope, existingSeamEvaluation: 'existing_seam_cited' as const }],
    operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [], insufficientEvidence: [],
  };
  const guidance = { ...guidanceEnvelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(guidanceEnvelope) } };
  const providerProvenance = { provider: 'anthropic' as const, model: 'qualification-fixture',
    promptId: 'forgewing-repository-plan-guidance' as const, promptVersion: 'v1' as const,
    promptSha256: '3'.repeat(64), schemaVersion: 'repository-plan-guidance-output-v1' as const,
    timeoutMs: 60_000, maxOutputTokens: 8_000, callCount: 0 as const, temperature: 0 as const,
    maxRetries: 0 as const, repositoryCommitSha: commitSha, foundationDigestSha256: '4'.repeat(64),
    contentBundleDigestSha256: '5'.repeat(64), guidanceInputDigestSha256: inputDigest,
    rawOutputSha256: null, validatedOutputSha256: guidance.digest.value };
  const envelope = { domain: 'eightforge.repository-aware-implementation-plan' as const, schemaVersion: 2 as const,
    authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
    requiresHumanReview: true as const, source: { implementationPlanV1DigestSha256: planV1Digest,
      effectiveReviewedSpecificationDigestSha256: '6'.repeat(64), foundationDigestSha256: '4'.repeat(64),
      contentBundleDigestSha256: '5'.repeat(64), guidanceInputDigestSha256: inputDigest,
      reviewPin: { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 1,
        reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 1 },
      repositorySnapshot: { repositoryUrl: 'https://github.com/example/eightforge', objectFormat: 'sha1' as const,
        commitSha, branchName: 'main', worktreeDirty: false as const,
        untrackedPolicy: 'excluded_from_trusted_manifest' as const, submoduleStatus: { state: 'none' as const } } },
    guidance, providerProvenance, rawOutputSha256: null, validatedOutputSha256: guidance.digest.value };
  return JSON.parse(canonicalJson({ ...envelope, digest: { algorithm: 'sha256',
    encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(envelope) } }));
}

function review(disposition: 'accepted'|'modified'|'rejected'|'deferred', version: number): WorkflowEngineeringReviewEvidence {
  const approved = disposition === 'accepted' || disposition === 'modified';
  return { reviewId: `33333333-3333-4333-8333-33333333333${version}`, reviewVersion: version,
    reviewerActorId: '44444444-4444-4444-8444-444444444444', reviewRequestDigestSha256: `${version}`.repeat(64),
    planV2RunId: '55555555-5555-4555-8555-555555555555', planV2DigestSha256: plan().digest.value,
    recommendationId, disposition, capabilityScope: approved ? 'workflow_specific' : null,
    reviewerRationale: `Disposition ${disposition}.`, modifiedScope: disposition === 'modified'
      ? { ...originalScope, capabilitySummary: 'Human replacement', summary: 'Use the human-reviewed replacement.' }
      : null, repositoryCommitSha: commitSha } as WorkflowEngineeringReviewEvidence;
}

describe('Approved Engineering Request exact review derivation', () => {
  it('derives accepted original scope and modified human scope with backlog-only authority', () => {
    const artifact = plan();
    const accepted = buildApprovedEngineeringRequest(artifact, review('accepted',1));
    const modified = buildApprovedEngineeringRequest(artifact, review('modified',2));
    expect(accepted.ok && accepted.request.approvedScope).toEqual(originalScope);
    expect(accepted.ok && accepted.request.scopeSource).toBe('forgewing_recommendation');
    expect(modified.ok && modified.request.approvedScope.capabilitySummary).toBe('Human replacement');
    expect(modified.ok && modified.request.scopeSource).toBe('human_reviewed_replacement');
    for (const result of [accepted, modified]) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.request).toMatchObject({ authorizes: 'backlog_projection', executable: false,
        grantsExecutionAuthority: false, authorizesCodeExecution: false, authorizesRepositoryWrites: false,
        authorizesMigrations: false, authorizesDeployment: false, authorizesCanonicalFactMutation: false,
        authorizesWorkflowOperationalDecision: false });
    }
  });

  it('derives no request for rejected/deferred and preserves exact old-version pinning', () => {
    const artifact = plan();
    expect(buildApprovedEngineeringRequest(artifact, review('rejected',3))).toEqual({ok:false,code:'not_approved'});
    expect(buildApprovedEngineeringRequest(artifact, review('deferred',4))).toEqual({ok:false,code:'not_approved'});
    expect(buildApprovedEngineeringRequest(artifact, review('accepted',1)).ok).toBe(true);
  });
});
