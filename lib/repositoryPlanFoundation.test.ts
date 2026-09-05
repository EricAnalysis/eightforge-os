import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { buildRepositoryPlanFoundation, RepositoryPlanFoundationSchema, type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

const sha = 'a'.repeat(40);
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };
// Explicit trusted-memory fixture; hashing a fixture does not authenticate a request.
function fixture(): Mutable<RepositoryPlanFoundationInput> {
  const plan = { domain: 'eightforge.implementation-plan', schemaVersion: 1,
    authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
    source: { pin: { ...pin }, effectiveReviewedSpecificationDigestSha256: 'b'.repeat(64) },
    plannedSteps: [{ stepId: 'rule', originalClassification: 'RULE', effectiveClassification: 'RULE',
      disposition: 'modified', provenance: { ...pin, sourceSubmissionId: pin.assessmentId,
        stepReviewId: pin.reviewId, reviewerActorId: pin.assessmentId, reviewerNotes: null },
      specificationSource: { mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification' },
      implementationReadiness: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
      specification: { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check',
        expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] } }], rejectedSteps: [] };
  return { trustedPlanV1: { ...plan, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(plan) } } as Mutable<WorkflowImplementationPlanArtifact>,
    repositorySnapshot: { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha: sha,
      branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot,
    manifest: [{ filePath: 'lib/rules/example.ts', commitSha: sha, blobSha: 'c'.repeat(40), classification: 'RULE' },
      { filePath: 'lib/rules/example.test.ts', commitSha: sha, blobSha: 'd'.repeat(40), classification: 'RULE' }],
    evidence: [{ filePath: 'lib/rules/example.ts', commitSha: sha, classification: 'RULE', evidenceKind: 'authored_rule',
      reason: 'Existing authored rule seam', relevantTestPath: 'lib/rules/example.test.ts' }] };
}
function artifact(input: RepositoryPlanFoundationInput = fixture()) {
  const result = buildRepositoryPlanFoundation(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.artifact;
}
function rehash(plan: Mutable<WorkflowImplementationPlanArtifact>) {
  const { digest: _digest, ...envelope } = plan;
  plan.digest.value = hashCanonical(envelope);
}

describe('pre-provider repository foundation', () => {
  it('preserves exact V1 identity, resolver digest and review pin with literal authority', () => {
    const input = fixture(); const value = artifact(input);
    expect(value.source.implementationPlanV1.digestSha256).toBe(input.trustedPlanV1.digest.value);
    expect(value.source.reviewPin).toEqual(pin);
    expect(value.source.effectiveReviewedSpecificationDigestSha256).toBe(input.trustedPlanV1.source.effectiveReviewedSpecificationDigestSha256);
    expect(value).toMatchObject({ stage: 'pre_provider_foundation', authority: 'non_authoritative', executable: false,
      grantsExecutionAuthority: false, requiresHumanReview: true });
    expect(value).not.toHaveProperty('providerProvenance');
    expect(value).not.toHaveProperty('guidance');
    expect(RepositoryPlanFoundationSchema.safeParse(value).success).toBe(true);
  });
  it('detaches and deeply freezes source, snapshot, manifest and evidence', () => {
    const input = fixture(); const value = artifact(input); const bytes = canonicalJson(value);
    input.trustedPlanV1.source.pin.reviewVersion++;
    (input.manifest[0]!).blobSha = 'e'.repeat(40);
    (input.evidence[0]!).reason = 'changed';
    expect(value.source.repositorySnapshot).not.toBe(input.repositorySnapshot);
    expect(Object.isFrozen(value.source.reviewPin)).toBe(true);
    expect(Object.isFrozen(value.repositoryEvidence.manifest[0])).toBe(true);
    expect(canonicalJson(value)).toBe(bytes);
  });
  it('sorts and deduplicates identical entries independently of input order', () => {
    const input = fixture(); const first = artifact(input);
    const reordered = artifact({ ...input, manifest: [...input.manifest].reverse().concat(input.manifest), evidence: [...input.evidence, ...input.evidence] });
    expect(canonicalJson(reordered)).toBe(canonicalJson(first));
    expect(canonicalJson(artifact(input))).toBe(canonicalJson(first));
    expect(first.repositoryEvidence.manifest).toHaveLength(2);
    expect(first.repositoryEvidence.evidence).toHaveLength(1);
  });
  it('binds repository SHA, valid changed V1 digest and manifest blob identity', () => {
    const original = artifact().digest.value;
    const input = fixture(); const changedSha = 'f'.repeat(40);
    expect(artifact({ ...input, repositorySnapshot: { ...input.repositorySnapshot, commitSha: changedSha },
      manifest: input.manifest.map(x => ({ ...x, commitSha: changedSha })), evidence: input.evidence.map(x => ({ ...x, commitSha: changedSha })) }).digest.value).not.toBe(original);
    const changedPlan = fixture(); changedPlan.trustedPlanV1.source.effectiveReviewedSpecificationDigestSha256 = 'e'.repeat(64); rehash(changedPlan.trustedPlanV1);
    expect(artifact(changedPlan).digest.value).not.toBe(original);
    const changedManifest = fixture(); changedManifest.manifest[0]!.blobSha = 'f'.repeat(40);
    expect(artifact(changedManifest).digest.value).not.toBe(original);
  });
  it('rejects structurally invalid V1, provenance pin mismatch and invalid digest', () => {
    for (const mutate of [
      (p: Mutable<WorkflowImplementationPlanArtifact>) => { p.source.pin.reviewVersion = 0; },
      (p: Mutable<WorkflowImplementationPlanArtifact>) => { p.plannedSteps[0]!.provenance.reviewVersion++; },
    ]) { const input = fixture(); mutate(input.trustedPlanV1); expect(buildRepositoryPlanFoundation(input)).toEqual({ ok: false, code: 'invalid_plan_v1' }); }
    const input = fixture(); input.trustedPlanV1.digest.value = '0'.repeat(64);
    expect(buildRepositoryPlanFoundation(input)).toEqual({ ok: false, code: 'invalid_plan_v1_digest' });
  });
  it('rejects non-JSON source values without invoking serialization hooks or accessors', () => {
    let called = false; const input = fixture();
    Object.defineProperty(input.trustedPlanV1, 'toJSON', { value: () => { called = true; return {}; }, enumerable: true });
    expect(buildRepositoryPlanFoundation(input).ok).toBe(false); expect(called).toBe(false);
    const getter = fixture(); Object.defineProperty(getter.trustedPlanV1, 'domain', { get: () => { called = true; return 'eightforge.implementation-plan'; }, enumerable: true });
    expect(buildRepositoryPlanFoundation(getter).ok).toBe(false); expect(called).toBe(false);
  });
  it('rejects copied source edits and rehashed incoherent readiness or disposition', () => {
    const edited = fixture(); edited.trustedPlanV1.source.effectiveReviewedSpecificationDigestSha256 = '0'.repeat(64);
    expect(buildRepositoryPlanFoundation(edited)).toEqual({ ok: false, code: 'invalid_plan_v1_digest' });
    const readiness = fixture(); readiness.trustedPlanV1.plannedSteps[0]!.implementationReadiness = { state: 'specification_complete' };
    rehash(readiness.trustedPlanV1);
    expect(buildRepositoryPlanFoundation(readiness)).toEqual({ ok: false, code: 'invalid_plan_v1' });
    const disposition = fixture(); disposition.trustedPlanV1.plannedSteps[0]!.disposition = 'accepted';
    rehash(disposition.trustedPlanV1);
    expect(buildRepositoryPlanFoundation(disposition)).toEqual({ ok: false, code: 'invalid_plan_v1' });
    expect(buildRepositoryPlanFoundation({ ...fixture(), callerOverride: true } as RepositoryPlanFoundationInput).ok).toBe(false);
  });
  it('rejects evidence scoped to a classification absent from the trusted plan', () => {
    const input = fixture(); expect(buildRepositoryPlanFoundation({ ...input, evidence: [],
      manifest: [{ filePath: 'lib/documentTypes.ts', commitSha: sha, blobSha: 'c'.repeat(40), classification: 'EXTRACT' }] })).toEqual({ ok: false, code: 'invalid_repository_evidence' });
  });
  it('rejects artifact digest tampering and conflicting snapshot identity', () => {
    const value = JSON.parse(canonicalJson(artifact())); value.digest.value = '0'.repeat(64);
    expect(RepositoryPlanFoundationSchema.safeParse(value).success).toBe(false);
    const mismatch = JSON.parse(canonicalJson(artifact())); mismatch.source.repositorySnapshot.branchName = 'other';
    const { digest: _digest, ...envelope } = mismatch; mismatch.digest.value = hashCanonical(envelope);
    expect(RepositoryPlanFoundationSchema.safeParse(mismatch).success).toBe(false);
  });
});
