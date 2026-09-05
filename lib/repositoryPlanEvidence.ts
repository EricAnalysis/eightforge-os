import { z } from 'zod';
import { RepositorySnapshotSchema } from '@/lib/repositoryPlanSnapshot';

export const RepositoryClassificationSchema = z.enum(['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']);
export type RepositoryClassification = z.infer<typeof RepositoryClassificationSchema>;
// Portable, literal Git paths only. No URI, device, glob, escaped or alternate-stream syntax.
export const RepositoryRelativePathSchema = z.string().min(1).max(500).refine((value) =>
  /^[A-Za-z0-9_.\-/]+$/.test(value)
  && !value.startsWith('/')
  && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'
    && !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)),
  'Expected a portable repository-relative literal file path');
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const roots = {
  RULE: ['lib/rules/', 'lib/validator/rulePacks/'],
  VERIFY: ['lib/rules/', 'lib/validator/rulePacks/'],
  EXTRACT: ['lib/documentTypes.ts', 'lib/extraction/'],
  RECOVER: ['lib/forgewing/', 'lib/extraction/persistence/complianceShadow.ts',
    'lib/extraction/persistence/complianceShadow.test.ts', 'lib/extraction/persistence/complianceShadowRpcContract.test.ts'],
  HUMAN: ['lib/server/workflowTasks.ts', 'lib/types/workflow.ts',
    'supabase/migrations/20250310000000_missing_live_schema_baseline.sql',
    'supabase/migrations/20250312000000_add_assignment_fields.sql',
    'supabase/migrations/20250314000000_deterministic_decision_backbone.sql',
    'supabase/migrations/20260329000000_add_project_id_to_decisions_and_tasks.sql'],
  ADVISORY: [],
} as const;
export function allowedInspectionRoots(classification: RepositoryClassification): readonly string[] {
  return [...roots[classification]];
}
export function isAllowedInspectionPath(classification: RepositoryClassification, filePath: string): boolean {
  return RepositoryRelativePathSchema.safeParse(filePath).success
    && roots[classification].some((root: string) => root.endsWith('/') ? filePath.startsWith(root) : filePath === root);
}
export const InspectedRepositoryFileSchema = z.object({
  filePath: RepositoryRelativePathSchema, commitSha: sha, blobSha: sha,
  classification: RepositoryClassificationSchema,
}).strict().superRefine((entry, ctx) => {
  if (!isAllowedInspectionPath(entry.classification, entry.filePath))
    ctx.addIssue({ code: 'custom', message: 'Unauthorized inspection root' });
});
export type InspectedRepositoryFile = z.infer<typeof InspectedRepositoryFileSchema>;
export const RepositoryEvidenceRecordSchema = z.object({
  filePath: RepositoryRelativePathSchema, symbol: z.string().min(1).max(200).optional(),
  commitSha: sha, classification: RepositoryClassificationSchema,
  evidenceKind: z.enum(['implementation_seam', 'authored_rule', 'document_type', 'recovery_pattern', 'authority_contract', 'test']),
  reason: z.string().min(1).max(2000), relevantTestPath: RepositoryRelativePathSchema.optional(),
}).strict();
export type RepositoryEvidenceRecord = z.infer<typeof RepositoryEvidenceRecordSchema>;
export const RepositoryEvidenceBundleSchema = z.object({
  repositorySnapshot: RepositorySnapshotSchema,
  manifest: z.array(InspectedRepositoryFileSchema).max(200),
  evidence: z.array(RepositoryEvidenceRecordSchema).max(400),
}).strict().superRefine((bundle, ctx) => {
  const files = new Map<string, string>();
  for (const entry of bundle.manifest) {
    const key = `${entry.classification}:${entry.filePath}`;
    if (entry.commitSha !== bundle.repositorySnapshot.commitSha
      || (files.has(key) && files.get(key) !== entry.blobSha))
      ctx.addIssue({ code: 'custom', message: 'Manifest identity inconsistency' });
    files.set(key, entry.blobSha);
  }
  // One path at one commit cannot identify two blobs, even across scopes.
  const blobs = new Map<string, string>();
  for (const entry of bundle.manifest) {
    if (blobs.has(entry.filePath) && blobs.get(entry.filePath) !== entry.blobSha)
      ctx.addIssue({ code: 'custom', message: 'Conflicting blob identity' });
    blobs.set(entry.filePath, entry.blobSha);
  }
  for (const entry of bundle.evidence) {
    if (entry.commitSha !== bundle.repositorySnapshot.commitSha
      || !files.has(`${entry.classification}:${entry.filePath}`)
      || (entry.relevantTestPath !== undefined
        && (!files.has(`${entry.classification}:${entry.relevantTestPath}`)
          || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.relevantTestPath))))
      ctx.addIssue({ code: 'custom', message: 'Evidence is outside the pinned manifest' });
  }
});

// Future collector port only: implementations must read regular committed blobs
// at snapshot.commitSha, never the working tree or caller-written summaries.
// No collector or provider is registered in B1. Limits apply to decoded UTF-8 bytes.
export type ScopedRepositoryCollectionRequest = Readonly<{
  repositorySnapshot: z.infer<typeof RepositorySnapshotSchema>;
  files: readonly Readonly<{ classification: RepositoryClassification; filePath: string }>[];
  maxFiles: 200; maxBytesPerFile: 65536; maxTotalBytes: 1048576;
}>;
export type ScopedRepositoryCollector = (request: ScopedRepositoryCollectionRequest) => Promise<
  { ok: true; files: readonly Readonly<{ identity: InspectedRepositoryFile; content: string }>[] }
  | { ok: false; code: 'repository_unavailable' | 'unsupported_path' | 'snapshot_mismatch' | 'budget_exceeded' }
>;

// Structured future vocabulary only. No guidance instances are built in B1.
const guidanceBase = { stepId: z.string().min(1).max(120), evidence: z.array(RepositoryEvidenceRecordSchema).min(1).max(20) };
const ruleKinds = z.enum(['reuse_existing_rule', 'extend_existing_rule', 'add_new_authored_rule', 'rule_engine_architecture_gap']);
export const FutureRepositoryStepGuidanceSchema = z.discriminatedUnion('classification', [
  z.object({ ...guidanceBase, classification: z.literal('RULE'), recommendationKind: ruleKinds }).strict(),
  z.object({ ...guidanceBase, classification: z.literal('VERIFY'), recommendationKind: ruleKinds }).strict(),
  z.object({ ...guidanceBase, classification: z.literal('EXTRACT'), recommendationKind: z.enum(['existing_document_type_context', 'extraction_seam_candidate', 'operator_taxonomy_decision_still_required']) }).strict(),
  z.object({ ...guidanceBase, classification: z.literal('RECOVER'), recommendationKind: z.enum(['reuse_recovery_pattern', 'recovery_architecture_gap', 'operator_recovery_decision_still_required']) }).strict(),
  z.object({ ...guidanceBase, classification: z.literal('HUMAN'), recommendationKind: z.enum(['task_authority_gap', 'organization_identity_unresolved']) }).strict(),
  z.object({ stepId: guidanceBase.stepId, classification: z.literal('ADVISORY'), recommendationKind: z.literal('no_implementation_required'), evidence: z.tuple([]) }).strict(),
]).superRefine((guidance, ctx) => {
  if (guidance.evidence.some((entry) => entry.classification !== guidance.classification))
    ctx.addIssue({ code: 'custom', message: 'Guidance evidence classification mismatch' });
});
export type FutureRepositoryStepGuidance = z.infer<typeof FutureRepositoryStepGuidanceSchema>;
