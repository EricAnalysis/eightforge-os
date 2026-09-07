import { describe, expect, it, vi } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { runForgewingRepositoryPlanGuidance } from '@/lib/forgewing/tasks/repositoryPlanGuidance';
import { buildRepositoryPlanContent, repositoryContentEvidenceId } from '@/lib/repositoryPlanContent';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import { prepareRepositoryPlanGuidance } from '@/lib/repositoryPlanGuidance';
import { recordWorkflowRepositoryPlanV2, WORKFLOW_REPOSITORY_PLAN_V2_WRITE_FUNCTION } from '@/lib/server/workflowRepositoryPlanPersistence';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

const runId = '66666666-6666-4666-8666-666666666666';
const rawId = '77777777-7777-4777-8777-777777777777';
const commitSha = 'a'.repeat(40);
const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };

async function artifacts() {
  const provenance = { ...pin, sourceSubmissionId: '33333333-3333-4333-8333-333333333333',
    stepReviewId: '44444444-4444-4444-8444-444444444444',
    reviewerActorId: '55555555-5555-4555-8555-555555555555', reviewerNotes: null };
  const step = { stepId: 'step-1', originalClassification: 'RULE' as const,
    effectiveClassification: 'RULE' as const, disposition: 'modified' as const, provenance,
    specificationSource: { mode: 'reviewed_replacement' as const,
      sourceField: 'workflow_assessment_step_reviews.accepted_specification' as const },
    implementationReadiness: { state: 'blocked_structural' as const, blocker: 'rule_definition_is_code' as const },
    specification: { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check' as const,
      expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] } };
  const envelope = { domain: 'eightforge.implementation-plan' as const, schemaVersion: 1 as const,
    authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
    source: { pin, effectiveReviewedSpecificationDigestSha256: 'd'.repeat(64) }, plannedSteps: [step], rejectedSteps: [] };
  const trustedPlanV1 = { ...envelope, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1',
    value: hashCanonical(envelope) } } as WorkflowImplementationPlanArtifact;
  const snapshot = { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha,
    branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest',
    submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot;
  const inspected = { filePath: 'lib/rules/example.ts', commitSha, blobSha: 'b'.repeat(40), classification: 'RULE' as const };
  const foundationInput: RepositoryPlanFoundationInput = { trustedPlanV1, repositorySnapshot: snapshot,
    manifest: [inspected], evidence: [{ filePath: inspected.filePath, commitSha, classification: 'RULE',
      evidenceKind: 'authored_rule', reason: 'Existing seam' }] };
  const foundation = buildRepositoryPlanFoundation(foundationInput);
  if (!foundation.ok) throw new Error(foundation.code);
  const content = 'export const value = 1;\n';
  const bundle = buildRepositoryPlanContent({ foundation: foundation.artifact, classification: 'RULE', collected: [{
    evidenceId: repositoryContentEvidenceId(inspected), mode: '100644', contentEncoding: 'utf8',
    byteLength: new TextEncoder().encode(content).byteLength, contentSha256: sha256Hex(content), content }] });
  if (!bundle.ok) throw new Error(bundle.code);
  const prepared = prepareRepositoryPlanGuidance({ trustedPlanV1, foundation: foundation.artifact, content: bundle.artifact });
  if (!prepared.ok) throw new Error(prepared.code);
  const candidate = prepared.artifact.steps[0]!.recommendationCandidates[0]!;
  const output = JSON.stringify({ classification: 'RULE', stepGuidance: [{ stepId: 'step-1', ...candidate,
    capabilitySummary: 'Reuse evidence rule', summary: 'Reuse the existing bounded seam.',
    evidenceRefs: [prepared.artifact.repositoryContent.files[0]!.evidenceId], existingSeamEvaluation: 'existing_seam_cited',
    architectureRisks: [], regressionGates: [{ gate: 'typecheck' }], stopConditions: [], unresolvedQuestions: [] }],
  operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [], insufficientEvidence: [] });
  const result = await runForgewingRepositoryPlanGuidance(prepared.artifact, {
    config: { enabled: true, model: 'claude-test', timeoutMs: 60_000, maxOutputTokens: 8_000 },
    provider: async () => output,
  });
  if (result.status !== 'completed' || result.rawProviderEvidence === null) throw new Error(result.status);
  return result;
}

describe('repository Plan V2 persistence seam', () => {
  it('sends only derived canonical bytes to the sole atomic RPC', async () => {
    const value = await artifacts();
    const rpc = vi.fn().mockResolvedValue({ data: [{ plan_v2_run_id: runId, raw_evidence_id: rawId, inserted: true }], error: null });
    await expect(recordWorkflowRepositoryPlanV2(value.planV2, value.rawProviderEvidence, { admin: { rpc } }))
      .resolves.toEqual({ status: 'recorded', planV2RunId: runId, rawEvidenceId: rawId, inserted: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![0]).toBe(WORKFLOW_REPOSITORY_PLAN_V2_WRITE_FUNCTION);
    const args = rpc.mock.calls[0]![1];
    expect(JSON.parse(args.p_plan_v2_canonical_json)).toEqual(value.planV2);
    expect(JSON.parse(args.p_raw_artifact_canonical_json)).toEqual(value.rawProviderEvidence);
    expect(JSON.parse(args.p_plan_v2_envelope_canonical_json)).not.toHaveProperty('digest');
    expect(JSON.parse(args.p_raw_envelope_canonical_json)).not.toHaveProperty('digest');
  });

  it('fails before persistence for tampering or raw/validated mismatch', async () => {
    const value = await artifacts(); const rpc = vi.fn();
    await expect(recordWorkflowRepositoryPlanV2({ ...value.planV2, authority: 'authoritative' } as never,
      value.rawProviderEvidence, { admin: { rpc } })).resolves.toEqual({ status: 'invalid_artifact' });
    await expect(recordWorkflowRepositoryPlanV2(value.planV2, null, { admin: { rpc } }))
      .resolves.toEqual({ status: 'identity_mismatch' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts an identical idempotent receipt and rejects malformed or failed receipts', async () => {
    const value = await artifacts();
    const idempotent = vi.fn().mockResolvedValue({ data: { plan_v2_run_id: runId, raw_evidence_id: rawId, inserted: false }, error: null });
    await expect(recordWorkflowRepositoryPlanV2(value.planV2, value.rawProviderEvidence, { admin: { rpc: idempotent } }))
      .resolves.toMatchObject({ status: 'recorded', inserted: false });
    for (const response of [{ data: null, error: null }, { data: null, error: { message: 'private detail' } }]) {
      await expect(recordWorkflowRepositoryPlanV2(value.planV2, value.rawProviderEvidence,
        { admin: { rpc: vi.fn().mockResolvedValue(response) } })).resolves.toEqual({ status: 'persist_failed' });
    }
  });
});
