import { describe, expect, it } from 'vitest';
import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { buildRepositoryPlanFoundation, type RepositoryPlanFoundationArtifact,
  type RepositoryPlanFoundationInput } from '@/lib/repositoryPlanFoundation';
import { buildRepositoryPlanContent, REPOSITORY_PLAN_CONTENT_LIMITS, RepositoryPlanContentSchema,
  repositoryContentEvidenceId, selectRepositoryPlanContent,
  type RepositoryPlanCollectedContentInput } from '@/lib/repositoryPlanContent';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';

const commitSha = 'a'.repeat(40);
const sourceBlobSha = 'b'.repeat(40);
const testBlobSha = 'c'.repeat(40);
const pin = { assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 2,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 3 };
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function foundationInput(): Mutable<RepositoryPlanFoundationInput> {
  const plan = { domain: 'eightforge.implementation-plan', schemaVersion: 1,
    authority: 'non_authoritative', executable: false, grantsExecutionAuthority: false,
    source: { pin: { ...pin }, effectiveReviewedSpecificationDigestSha256: 'd'.repeat(64) },
    plannedSteps: [{ stepId: 'rule', originalClassification: 'RULE', effectiveClassification: 'RULE',
      disposition: 'modified', provenance: { ...pin, sourceSubmissionId: pin.assessmentId,
        stepReviewId: pin.reviewId, reviewerActorId: pin.assessmentId, reviewerNotes: null },
      specificationSource: { mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification' },
      implementationReadiness: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
      specification: { plainLanguageRule: 'Require evidence', requiredFacts: ['evidence'], conditionType: 'presence_check',
        expectedEvidence: ['source'], expectedOutcome: 'present', userDescribedExceptions: [], unresolvedAssumptions: [] } }],
    rejectedSteps: [] };
  return { trustedPlanV1: { ...plan, digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1',
    value: hashCanonical(plan) } } as Mutable<WorkflowImplementationPlanArtifact>,
  repositorySnapshot: { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha,
    branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest',
    submoduleStatus: { state: 'none' } } as VerifiedRepositorySnapshot,
  manifest: [
    { filePath: 'lib/rules/example.ts', commitSha, blobSha: sourceBlobSha, classification: 'RULE' },
    { filePath: 'lib/rules/example.test.ts', commitSha, blobSha: testBlobSha, classification: 'RULE' },
  ],
  evidence: [{ filePath: 'lib/rules/example.ts', commitSha, classification: 'RULE', evidenceKind: 'authored_rule',
    reason: 'Existing authored rule seam', relevantTestPath: 'lib/rules/example.test.ts' }] };
}
function foundation(input: RepositoryPlanFoundationInput = foundationInput()): RepositoryPlanFoundationArtifact {
  const result = buildRepositoryPlanFoundation(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.artifact;
}
function selection(value = foundation()) {
  const result = selectRepositoryPlanContent(value, 'RULE');
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.selection;
}
function collected(value = foundation(), contents = ['export const value = 1;\n', 'it("works", () => {});\n']): RepositoryPlanCollectedContentInput[] {
  return selection(value).map((entry, index) => ({ evidenceId: entry.evidenceId, mode: '100644', contentEncoding: 'utf8',
    byteLength: new TextEncoder().encode(contents[index]!).byteLength, contentSha256: sha256Hex(contents[index]!),
    content: contents[index]! }));
}
function artifact(value = foundation(), contents?: string[]) {
  const result = buildRepositoryPlanContent({ foundation: value, classification: 'RULE', collected: collected(value, contents) });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.ok).toBe(true);
  return result.artifact;
}

describe('repository committed-content contract', () => {
  it('creates full-width deterministic, scope/path/blob/commit-bound evidence IDs', () => {
    const identity = { commitSha, classification: 'RULE' as const, filePath: 'lib/rules/example.ts', blobSha: sourceBlobSha };
    const first = repositoryContentEvidenceId(identity);
    expect(first).toMatch(/^ev_[a-f0-9]{64}$/);
    expect(repositoryContentEvidenceId({ ...identity })).toBe(first);
    for (const changed of [{ ...identity, classification: 'VERIFY' as const }, { ...identity, filePath: 'lib/rules/other.ts' },
      { ...identity, blobSha: testBlobSha }, { ...identity, commitSha: 'e'.repeat(40) }])
      expect(repositoryContentEvidenceId(changed)).not.toBe(first);
  });

  it('does not bind evidence identity to reason, symbol, kind, relevant test or foundation digest', () => {
    const firstInput = foundationInput();
    const changedInput = foundationInput();
    changedInput.evidence[0]!.reason = 'Edited explanation only';
    changedInput.evidence[0]!.symbol = 'otherSymbol';
    changedInput.evidence[0]!.evidenceKind = 'implementation_seam';
    const first = selection(foundation(firstInput))[0]!.evidenceId;
    const changed = selection(foundation(changedInput))[0]!.evidenceId;
    expect(changed).toBe(first);
  });

  it('selects only evidence paths, includes trusted relevant tests and excludes manifest-only files', () => {
    const input = foundationInput();
    input.manifest.push({ filePath: 'lib/rules/unused.ts', commitSha, blobSha: 'e'.repeat(40), classification: 'RULE' });
    const selected = selection(foundation(input));
    expect(selected.map((entry) => entry.filePath)).toEqual(['lib/rules/example.ts', 'lib/rules/example.test.ts']);
    expect(selected.map((entry) => entry.roles)).toEqual([['source'], ['relevant_test']]);
  });

  it('deduplicates evidence IDs, merges roles, and preserves first canonical evidence occurrence', () => {
    const input = foundationInput();
    input.evidence.push({ filePath: 'lib/rules/example.test.ts', commitSha, classification: 'RULE', evidenceKind: 'test',
      reason: 'A test is also direct evidence', relevantTestPath: 'lib/rules/example.test.ts' });
    input.evidence.push({ ...input.evidence[0]! });
    const selected = selection(foundation(input));
    expect(selected).toHaveLength(2);
    expect(selected.find((entry) => entry.filePath.endsWith('.test.ts'))?.roles).toEqual(['source', 'relevant_test']);
    expect(selection(foundation(input))).toEqual(selected);
  });

  it('returns deterministic empty ADVISORY content and fails closed for an absent non-ADVISORY classification', () => {
    expect(selectRepositoryPlanContent(foundation(), 'ADVISORY')).toEqual({ ok: true, selection: [] });
    expect(selectRepositoryPlanContent(foundation(), 'VERIFY')).toEqual({ ok: false, code: 'classification_not_present' });
    const advisory = buildRepositoryPlanContent({ foundation: foundation(), classification: 'ADVISORY', collected: [] });
    expect(advisory.ok && advisory.artifact.files).toEqual([]);
  });

  it('builds a strict complete envelope with stable and content-sensitive digest', () => {
    const first = artifact();
    expect(artifact().digest.value).toBe(first.digest.value);
    expect(artifact(foundation(), ['export const value = 2;\n', 'it("works", () => {});\n']).digest.value)
      .not.toBe(first.digest.value);
    expect(first).toMatchObject({ domain: 'eightforge.repository-committed-content', schemaVersion: 1,
      stage: 'pre_provider_content', authority: 'non_authoritative', executable: false,
      grantsExecutionAuthority: false, requiresHumanReview: true, contentTrust: 'untrusted_repository_data',
      collection: { ...REPOSITORY_PLAN_CONTENT_LIMITS, collectedFiles: 2 } });
    expect(RepositoryPlanContentSchema.safeParse(first).success).toBe(true);
  });

  it('rejects missing, duplicate and arbitrary caller-selected collected entries', () => {
    const value = foundation(); const valid = collected(value);
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE', collected: valid.slice(1) }))
      .toEqual({ ok: false, code: 'evidence_invalid' });
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE', collected: [valid[0]!, valid[0]!] }))
      .toEqual({ ok: false, code: 'evidence_invalid' });
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE',
      collected: [{ ...valid[0]!, filePath: '../caller-path' }, valid[1]!] as RepositoryPlanCollectedContentInput[] }))
      .toEqual({ ok: false, code: 'evidence_invalid' });
  });

  it('rejects altered content metadata, unsupported text and raw-byte budget overflow', () => {
    const value = foundation(); const valid = collected(value);
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE',
      collected: [{ ...valid[0]!, byteLength: valid[0]!.byteLength + 1 }, valid[1]!] })).toMatchObject({ ok: false, code: 'evidence_invalid' });
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE',
      collected: [{ ...valid[0]!, content: '\uFEFFtext', byteLength: 7, contentSha256: sha256Hex('\uFEFFtext') }, valid[1]!] }))
      .toMatchObject({ ok: false, code: 'unsupported_content' });
    const oversize = 'x'.repeat(REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile + 1);
    expect(buildRepositoryPlanContent({ foundation: value, classification: 'RULE', collected: [
      { ...valid[0]!, content: oversize, byteLength: oversize.length, contentSha256: sha256Hex(oversize) }, valid[1]!] }))
      .toMatchObject({ ok: false, code: 'file_too_large' });
  });

  it('deeply detaches and freezes the artifact against caller mutation', () => {
    const value = foundation(); const input = collected(value); const result = buildRepositoryPlanContent({ foundation: value,
      classification: 'RULE', collected: input });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    const before = canonicalJson(result.artifact);
    input[0]!.content = 'changed';
    expect(canonicalJson(result.artifact)).toBe(before);
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.artifact.repositorySnapshot)).toBe(true);
    expect(Object.isFrozen(result.artifact.files)).toBe(true);
    expect(Object.isFrozen(result.artifact.files[0])).toBe(true);
    expect(Object.isFrozen(result.artifact.files[0]!.roles)).toBe(true);
  });

  it('schema self-verification rejects digest, evidence ID, content hash, byte count and counter tampering', () => {
    const mutations: [boolean, (value: Record<string, any>) => void][] = [
      [false, value => { value.digest.value = '0'.repeat(64); }],
      [true, value => { value.files[0].evidenceId = `ev_${'0'.repeat(64)}`; }],
      [true, value => { value.files[0].contentSha256 = '0'.repeat(64); }],
      [true, value => { value.files[0].byteLength++; }],
      [true, value => { value.collection.collectedFiles--; }],
    ];
    for (const [rehash, mutate] of mutations) {
      const changed = JSON.parse(canonicalJson(artifact())); mutate(changed);
      if (rehash) { const { digest: _digest, ...envelope } = changed; changed.digest.value = hashCanonical(envelope); }
      expect(RepositoryPlanContentSchema.safeParse(changed).success).toBe(false);
    }
  });
});
