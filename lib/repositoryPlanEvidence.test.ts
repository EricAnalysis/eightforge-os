import { describe, expect, it } from 'vitest';
import { allowedInspectionRoots, FutureRepositoryStepGuidanceSchema, InspectedRepositoryFileSchema,
  isAllowedInspectionPath, RepositoryEvidenceBundleSchema, RepositoryEvidenceRecordSchema,
  RepositoryRelativePathSchema, type RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import { RepositorySnapshotSchema } from '@/lib/repositoryPlanSnapshot';

const sha = 'a'.repeat(40);
function bundle() {
  return { repositorySnapshot: { repositoryUrl: 'https://github.com/example/repository', objectFormat: 'sha1', commitSha: sha,
    branchName: 'main', worktreeDirty: false, untrackedPolicy: 'excluded_from_trusted_manifest', submoduleStatus: { state: 'none' } },
  manifest: [{ filePath: 'lib/rules/check.ts', commitSha: sha, blobSha: 'b'.repeat(40), classification: 'RULE' }],
  evidence: [{ filePath: 'lib/rules/check.ts', commitSha: sha, classification: 'RULE', evidenceKind: 'authored_rule', reason: 'Authored check' }] };
}
describe('repository evidence and manifest contracts', () => {
  it('accepts repository-relative paths and a complete pinned evidence closure', () => {
    expect(RepositoryRelativePathSchema.safeParse('lib/rules/check.test.ts').success).toBe(true);
    expect(RepositoryEvidenceBundleSchema.safeParse(bundle()).success).toBe(true);
  });
  it.each(['../secret', 'lib/../secret', 'C:\\private\\secret.ts', 'C:/private/secret.ts', '/etc/passwd',
    '\\\\server\\share', 'https://example.com/file.ts', 'file:///secret', 'lib//file', './lib/file', 'lib/file:stream',
    'lib/%2e%2e/secret', 'lib/*.ts', 'lib/nul.ts', 'lib/file.'])('rejects unsafe literal path %s (probes C/E)', path => {
    expect(RepositoryRelativePathSchema.safeParse(path).success).toBe(false);
  });
  it('rejects branch-as-SHA (probe B) and wrong evidence commit (probe D)', () => {
    const input = bundle(); input.repositorySnapshot.commitSha = 'main';
    expect(RepositorySnapshotSchema.safeParse(input.repositorySnapshot).success).toBe(false);
    const wrong = bundle(); wrong.evidence[0]!.commitSha = 'c'.repeat(40);
    expect(RepositoryEvidenceBundleSchema.safeParse(wrong).success).toBe(false);
  });
  it('rejects unauthorized roots and cross-classification evidence (probe F)', () => {
    const input = bundle(); input.manifest[0]!.filePath = 'lib/auth.ts'; input.evidence[0]!.filePath = 'lib/auth.ts';
    expect(RepositoryEvidenceBundleSchema.safeParse(input).success).toBe(false);
    const cross = bundle(); cross.evidence[0]!.classification = 'VERIFY';
    expect(RepositoryEvidenceBundleSchema.safeParse(cross).success).toBe(false);
    expect(isAllowedInspectionPath('RULE', 'lib/rules-evil/file.ts')).toBe(false);
    expect(isAllowedInspectionPath('RECOVER', 'lib/extraction/unrelated.ts')).toBe(false);
    expect(isAllowedInspectionPath('HUMAN', 'supabase/migrations/arbitrary.sql')).toBe(false);
    expect(isAllowedInspectionPath('ADVISORY', 'lib/rules/check.ts')).toBe(false);
  });
  it('accepts each authorized classification seam without exposing mutable roots', () => {
    const seams: [RepositoryClassification, string][] = [['RULE', 'lib/rules/check.ts'], ['VERIFY', 'lib/validator/rulePacks/check.ts'],
      ['EXTRACT', 'lib/documentTypes.ts'], ['RECOVER', 'lib/extraction/persistence/complianceShadow.ts'], ['HUMAN', 'lib/server/workflowTasks.ts']];
    for (const [classification, path] of seams) expect(isAllowedInspectionPath(classification, path)).toBe(true);
    const roots = allowedInspectionRoots('RULE') as string[]; roots.push('lib/');
    expect(isAllowedInspectionPath('RULE', 'lib/auth.ts')).toBe(false);
  });
  it('rejects missing manifest members, wrong manifest commits and conflicting blobs', () => {
    const missing = bundle(); missing.manifest = [];
    expect(RepositoryEvidenceBundleSchema.safeParse(missing).success).toBe(false);
    const wrong = bundle(); wrong.manifest[0]!.commitSha = 'd'.repeat(40);
    expect(RepositoryEvidenceBundleSchema.safeParse(wrong).success).toBe(false);
    const conflict = bundle(); conflict.manifest.push({ ...conflict.manifest[0]!, blobSha: 'e'.repeat(40) });
    expect(RepositoryEvidenceBundleSchema.safeParse(conflict).success).toBe(false);
    conflict.manifest[1]!.classification = 'VERIFY';
    expect(RepositoryEvidenceBundleSchema.safeParse(conflict).success).toBe(false);
    expect(InspectedRepositoryFileSchema.safeParse({ ...bundle().manifest[0], blobSha: 'main' }).success).toBe(false);
  });
  it('requires relevant tests to be inspected under the same classification and pinned commit', () => {
    const input = bundle(); const record = { ...input.evidence[0]!, relevantTestPath: 'lib/rules/check.test.ts' };
    expect(RepositoryEvidenceBundleSchema.safeParse({ ...input, evidence: [record] }).success).toBe(false);
    input.manifest.push({ ...input.manifest[0]!, filePath: record.relevantTestPath });
    expect(RepositoryEvidenceBundleSchema.safeParse({ ...input, evidence: [record] }).success).toBe(true);
    record.relevantTestPath = 'lib/rules/check.ts';
    expect(RepositoryEvidenceBundleSchema.safeParse({ ...input, evidence: [record] }).success).toBe(false);
  });
  it('bounds prose, collection size and closed evidence vocabulary; rejects unknown fields', () => {
    const input = bundle(); const record = input.evidence[0]!;
    for (const patch of [{ evidenceKind: 'anything' }, { reason: '' }, { reason: 'x'.repeat(2001) }, { symbol: '' }, { url: 'https://example.com' }])
      expect(RepositoryEvidenceRecordSchema.safeParse({ ...record, ...patch }).success).toBe(false);
    expect(RepositoryEvidenceBundleSchema.safeParse({ ...input, manifest: Array(201).fill(input.manifest[0]) }).success).toBe(false);
    expect(RepositoryEvidenceBundleSchema.safeParse({ ...input, evidence: Array(401).fill(record) }).success).toBe(false);
  });
});
describe('future structured guidance vocabulary', () => {
  it.each([['RULE', 'reuse_existing_rule'], ['VERIFY', 'add_new_authored_rule'], ['EXTRACT', 'operator_taxonomy_decision_still_required'],
    ['RECOVER', 'operator_recovery_decision_still_required'], ['HUMAN', 'organization_identity_unresolved']])('accepts evidence-bound %s vocabulary', (classification, recommendationKind) => {
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ stepId: 'step', classification, recommendationKind,
      evidence: [{ ...bundle().evidence[0], classification }] }).success).toBe(true);
  });
  it('forbids free recommendation strings, unsupported cross-class kinds, and unbound guidance', () => {
    const value = { stepId: 'step', classification: 'RULE', recommendationKind: 'reuse_existing_rule', evidence: bundle().evidence };
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, recommendationKind: 'execute anything' }).success).toBe(false);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, recommendationKind: 'organization_identity_unresolved' }).success).toBe(false);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, evidence: [] }).success).toBe(false);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, evidence: [{ ...bundle().evidence[0], classification: 'EXTRACT' }] }).success).toBe(false);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, recommendation: 'arbitrary' }).success).toBe(false);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ stepId: 'step', classification: 'ADVISORY', recommendationKind: 'no_implementation_required', evidence: [] }).success).toBe(true);
    expect(FutureRepositoryStepGuidanceSchema.safeParse({ ...value, classification: 'ADVISORY', recommendationKind: 'no_implementation_required' }).success).toBe(false);
  });
});
