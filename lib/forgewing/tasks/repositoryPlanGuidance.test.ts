import { describe, expect, it, vi } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { ForgewingProviderOutputError, loadRepositoryPlanGuidancePrompt } from '@/lib/forgewing/runtime/client';
import { RepositoryAwareImplementationPlanV2Schema, RepositoryPlanRawProviderEvidenceSchema,
  runForgewingRepositoryPlanGuidance } from '@/lib/forgewing/tasks/repositoryPlanGuidance';
import { buildRepositoryPlanContent, repositoryContentEvidenceId } from '@/lib/repositoryPlanContent';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import { prepareRepositoryPlanGuidance, type RepositoryPlanGuidanceInputArtifact } from '@/lib/repositoryPlanGuidance';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

const commitSha = 'a'.repeat(40);
const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };
const provenance = { ...pin, sourceSubmissionId: '33333333-3333-4333-8333-333333333333',
  stepReviewId: '44444444-4444-4444-8444-444444444444',
  reviewerActorId: '55555555-5555-4555-8555-555555555555', reviewerNotes: null };
const snapshot = { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha,
  branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest',
  submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot;
const enabled = { enabled: true, model: 'claude-test', timeoutMs: 60_000, maxOutputTokens: 8_000 } as const;

function plan(classification: 'RULE' | 'ADVISORY'): WorkflowImplementationPlanArtifact {
  const step = classification === 'RULE' ? { stepId: 'step-1', originalClassification: 'RULE' as const,
    effectiveClassification: 'RULE' as const, disposition: 'modified' as const, provenance,
    specificationSource: { mode: 'reviewed_replacement' as const,
      sourceField: 'workflow_assessment_step_reviews.accepted_specification' as const },
    implementationReadiness: { state: 'blocked_structural' as const, blocker: 'rule_definition_is_code' as const },
    specification: { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check' as const,
      expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] } }
    : { stepId: 'step-1', originalClassification: 'ADVISORY' as const, effectiveClassification: 'ADVISORY' as const,
      disposition: 'modified' as const, provenance, specificationSource: { mode: 'reviewed_replacement' as const,
        sourceField: 'workflow_assessment_step_reviews.accepted_specification' as const },
      implementationReadiness: { state: 'specification_complete' as const }, specification: { description: 'No code' } };
  const envelope = { domain: 'eightforge.implementation-plan' as const, schemaVersion: 1 as const,
    authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
    source: { pin, effectiveReviewedSpecificationDigestSha256: 'd'.repeat(64) }, plannedSteps: [step], rejectedSteps: [] };
  return { ...envelope, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1',
    value: hashCanonical(envelope) } } as WorkflowImplementationPlanArtifact;
}

function input(classification: 'RULE' | 'ADVISORY' = 'RULE', withEvidence = true): RepositoryPlanGuidanceInputArtifact {
  const trustedPlanV1 = plan(classification);
  const manifest = classification === 'RULE' ? [{ filePath: 'lib/rules/example.ts', commitSha,
    blobSha: 'b'.repeat(40), classification: 'RULE' as const }] : [];
  const evidence = classification === 'RULE' && withEvidence ? [{ filePath: 'lib/rules/example.ts', commitSha,
    classification: 'RULE' as const, evidenceKind: 'authored_rule' as const, reason: 'Existing seam' }] : [];
  const foundation = buildRepositoryPlanFoundation({ trustedPlanV1, repositorySnapshot: snapshot,
    manifest, evidence } as RepositoryPlanFoundationInput);
  if (!foundation.ok) throw new Error(foundation.code);
  const content = 'export const value = 1;\n';
  const collected = classification === 'RULE' && withEvidence ? [{ evidenceId: repositoryContentEvidenceId(manifest[0]!),
    mode: '100644' as const, contentEncoding: 'utf8' as const, byteLength: new TextEncoder().encode(content).byteLength,
    contentSha256: sha256Hex(content), content }] : [];
  const bundle = buildRepositoryPlanContent({ foundation: foundation.artifact, classification, collected });
  if (!bundle.ok) throw new Error(bundle.code);
  const prepared = prepareRepositoryPlanGuidance({ trustedPlanV1, foundation: foundation.artifact, content: bundle.artifact });
  if (!prepared.ok) throw new Error(prepared.code);
  return prepared.artifact;
}

function validOutput(prepared: RepositoryPlanGuidanceInputArtifact): string {
  const step = prepared.steps[0]!; const candidate = step.recommendationCandidates[0]!;
  return JSON.stringify({ classification: 'RULE', stepGuidance: [{ stepId: step.stepId,
    recommendationKind: candidate.recommendationKind, recommendationId: candidate.recommendationId,
    capabilitySummary: 'Reuse evidence rule', summary: 'Reuse the existing bounded seam.',
    evidenceRefs: [prepared.repositoryContent.files[0]!.evidenceId], existingSeamEvaluation: 'existing_seam_cited',
    architectureRisks: [], regressionGates: [{ gate: 'typecheck' }], stopConditions: [], unresolvedQuestions: [] }],
  operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [], insufficientEvidence: [] });
}

describe('bounded Forgewing repository-plan reasoning', () => {
  it('is default-off before provider access for a ready unit', async () => {
    const provider = vi.fn();
    await expect(runForgewingRepositoryPlanGuidance(input(), { provider,
      config: { ...enabled, enabled: false } })).resolves.toEqual({ status: 'skipped', reason: 'forgewing_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('makes one bounded call over canonical nested data and returns raw plus validated artifacts', async () => {
    const prepared = input(); const provider = vi.fn().mockResolvedValue(validOutput(prepared));
    const result = await runForgewingRepositoryPlanGuidance(prepared, { provider, config: enabled });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0]).toMatchObject({ model: 'claude-test', timeoutMs: 60_000,
      maxOutputTokens: 8_000 });
    // Exact canonical input comparison without depending on ordinary JSON key order.
    expect(JSON.parse(provider.mock.calls[0]![0].inputJson)).toEqual(prepared);
    expect(result).toMatchObject({ status: 'completed', mode: 'provider_validated',
      rawProviderEvidence: { authority: 'non_authoritative', trustedGuidance: false, rawOutputSha256: expect.any(String),
        providerProvenance: { callCount: 1, temperature: 0, maxRetries: 0 } },
      planV2: { domain: 'eightforge.repository-aware-implementation-plan', schemaVersion: 2,
        authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false, requiresHumanReview: true,
        source: { implementationPlanV1DigestSha256: prepared.source.implementationPlanV1DigestSha256,
          foundationDigestSha256: prepared.source.foundationDigestSha256,
          contentBundleDigestSha256: prepared.source.contentBundleDigestSha256,
          guidanceInputDigestSha256: prepared.digest.value, reviewPin: pin,
          repositorySnapshot: { commitSha } },
        providerProvenance: { promptSha256: sha256Hex(loadRepositoryPlanGuidancePrompt()), callCount: 1 },
        rawOutputSha256: expect.any(String), validatedOutputSha256: expect.any(String) } });
    if (result.status !== 'completed') throw new Error(result.reason);
    const { digest, ...envelope } = result.planV2;
    expect(digest.value).toBe(hashCanonical(envelope));
    expect(RepositoryAwareImplementationPlanV2Schema.safeParse(result.planV2).success).toBe(true);
    expect(RepositoryPlanRawProviderEvidenceSchema.safeParse(result.rawProviderEvidence).success).toBe(true);
    expect(RepositoryAwareImplementationPlanV2Schema.safeParse({ ...result.planV2,
      rawOutputSha256: 'f'.repeat(64) }).success).toBe(false);
  });

  it('does not retry malformed output and preserves it only as untrusted raw evidence', async () => {
    const provider = vi.fn().mockResolvedValue('not json');
    const result = await runForgewingRepositoryPlanGuidance(input(), { provider, config: enabled });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'failed', reason: 'invalid_model_output', callCount: 1,
      rawProviderEvidence: { rawOutput: 'not json', trustedGuidance: false } });
  });

  it('preserves truncated raw evidence and never falls back', async () => {
    const provider = vi.fn().mockRejectedValue(new ForgewingProviderOutputError('provider_truncated_output', '{"partial":'));
    const result = await runForgewingRepositoryPlanGuidance(input(), { provider, config: enabled });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'failed', reason: 'provider_truncated_output', callCount: 1,
      rawProviderEvidence: { rawOutput: '{"partial":' } });
  });

  it('classifies bounded-output overflow separately and does not retry', async () => {
    const provider = vi.fn().mockResolvedValue('x'.repeat(262_145));
    const result = await runForgewingRepositoryPlanGuidance(input(), { provider, config: enabled });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'failed', reason: 'output_too_large', callCount: 1,
      rawProviderEvidence: { trustedGuidance: false, rawOutputSha256: expect.any(String) } });
  });

  it('returns deterministic zero-call ADVISORY and insufficient-evidence Plan V2 artifacts', async () => {
    const provider = vi.fn();
    const advisory = await runForgewingRepositoryPlanGuidance(input('ADVISORY'), { provider, config: enabled });
    const insufficient = await runForgewingRepositoryPlanGuidance(input('RULE', false), { provider, config: enabled });
    expect(provider).not.toHaveBeenCalled();
    expect(advisory).toMatchObject({ status: 'completed', mode: 'advisory', rawProviderEvidence: null,
      planV2: { providerProvenance: { callCount: 0 }, rawOutputSha256: null } });
    expect(insufficient).toMatchObject({ status: 'completed', mode: 'insufficient_evidence', rawProviderEvidence: null,
      planV2: { guidance: { insufficientEvidence: [{ stepId: 'step-1' }] }, providerProvenance: { callCount: 0 } } });
  });

  it('fails before provider access when the one-call budget is unavailable', async () => {
    const provider = vi.fn();
    await expect(runForgewingRepositoryPlanGuidance(input(), { provider, config: enabled,
      budget: new ForgewingCallBudget(0) })).resolves.toMatchObject({ status: 'failed', reason: 'budget_exhausted', callCount: 0 });
    expect(provider).not.toHaveBeenCalled();
  });

  it('durably marks provider start only for an eligible call and fails closed when marking fails', async () => {
    const prepared = input();
    const provider = vi.fn().mockResolvedValue(validOutput(prepared));
    const beforeProviderCall = vi.fn().mockRejectedValue(new Error('claim lost'));
    await expect(runForgewingRepositoryPlanGuidance(prepared, {
      provider, config: enabled, beforeProviderCall,
    })).resolves.toEqual({
      status: 'failed', reason: 'provider_start_failed', rawProviderEvidence: null, callCount: 0,
    });
    expect(beforeProviderCall).toHaveBeenCalledExactlyOnceWith();
    expect(provider).not.toHaveBeenCalled();

    beforeProviderCall.mockClear();
    await runForgewingRepositoryPlanGuidance(input('ADVISORY'), {
      provider, config: enabled, beforeProviderCall,
    });
    await runForgewingRepositoryPlanGuidance(input('RULE', false), {
      provider, config: enabled, beforeProviderCall,
    });
    await runForgewingRepositoryPlanGuidance(prepared, {
      provider, config: { ...enabled, enabled: false }, beforeProviderCall,
    });
    expect(beforeProviderCall).not.toHaveBeenCalled();
  });
});
