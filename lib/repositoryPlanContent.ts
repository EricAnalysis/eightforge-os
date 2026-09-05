import { z } from 'zod';
import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { RepositoryPlanFoundationSchema, type RepositoryPlanFoundationArtifact } from '@/lib/repositoryPlanFoundation';
import { isAllowedInspectionPath, RepositoryClassificationSchema, RepositoryRelativePathSchema,
  type RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import { RepositorySnapshotSchema } from '@/lib/repositoryPlanSnapshot';

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceId = z.string().regex(/^ev_[a-f0-9]{64}$/);

export const REPOSITORY_PLAN_CONTENT_LIMITS = Object.freeze({
  maxFiles: 200 as const,
  maxBytesPerFile: 65_536 as const,
  maxTotalBytes: 1_048_576 as const,
});

export const RepositoryPlanContentFailureCodeSchema = z.enum([
  'foundation_invalid', 'snapshot_mismatch', 'classification_not_present', 'evidence_invalid', 'path_not_authorized',
  'repository_unavailable', 'unsupported_git_configuration', 'git_failed', 'object_missing', 'blob_mismatch',
  'unsupported_mode', 'unsupported_content', 'invalid_utf8', 'file_too_large',
  'collection_file_limit_exceeded', 'collection_byte_limit_exceeded',
]);
export type RepositoryPlanContentFailureCode = z.infer<typeof RepositoryPlanContentFailureCodeSchema>;

export const RepositoryPlanContentRoleSchema = z.enum(['source', 'relevant_test']);
export type RepositoryPlanContentRole = z.infer<typeof RepositoryPlanContentRoleSchema>;
const rolesSchema = z.array(RepositoryPlanContentRoleSchema).min(1).max(2).superRefine((roles, ctx) => {
  const expected = orderedRoles(roles);
  if (roles.length !== new Set(roles).size || canonicalJson(roles) !== canonicalJson(expected))
    ctx.addIssue({ code: 'custom', message: 'Content roles must be unique and canonically ordered' });
});

const selectionEntrySchema = z.object({
  evidenceId, filePath: RepositoryRelativePathSchema, blobSha: sha1, commitSha: sha1, roles: rolesSchema,
}).strict();
export type RepositoryPlanContentSelectionEntry = z.infer<typeof selectionEntrySchema>;

const collectedInputSchema = z.object({
  evidenceId,
  mode: z.literal('100644'),
  contentEncoding: z.literal('utf8'),
  byteLength: z.number().int().nonnegative(),
  contentSha256: sha256,
  content: z.string(),
}).strict();
export type RepositoryPlanCollectedContentInput = z.infer<typeof collectedInputSchema>;

export const RepositoryPlanCommittedFileSchema = selectionEntrySchema.extend({
  mode: z.literal('100644'),
  contentEncoding: z.literal('utf8'),
  byteLength: z.number().int().nonnegative(),
  contentSha256: sha256,
  contentTrust: z.literal('untrusted_repository_data'),
  content: z.string(),
}).strict();

const collectionSchema = z.object({
  maxFiles: z.literal(REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles),
  maxBytesPerFile: z.literal(REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile),
  maxTotalBytes: z.literal(REPOSITORY_PLAN_CONTENT_LIMITS.maxTotalBytes),
  collectedFiles: z.number().int().min(0).max(REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles),
  collectedBytes: z.number().int().min(0).max(REPOSITORY_PLAN_CONTENT_LIMITS.maxTotalBytes),
}).strict();

const envelopeSchema = z.object({
  domain: z.literal('eightforge.repository-committed-content'),
  schemaVersion: z.literal(1),
  stage: z.literal('pre_provider_content'),
  authority: z.literal('non_authoritative'),
  executable: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  requiresHumanReview: z.literal(true),
  contentTrust: z.literal('untrusted_repository_data'),
  sourceFoundationDigestSha256: sha256,
  repositorySnapshot: RepositorySnapshotSchema,
  classification: RepositoryClassificationSchema,
  files: z.array(RepositoryPlanCommittedFileSchema).max(REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles),
  collection: collectionSchema,
}).strict();

export const RepositoryPlanContentSchema = envelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: sha256 }).strict(),
}).superRefine((artifact, ctx) => {
  const { digest, ...envelope } = artifact;
  if (hashCanonical(envelope) !== digest.value)
    ctx.addIssue({ code: 'custom', message: 'Content artifact digest mismatch' });
  const collectedBytes = artifact.files.reduce((total, file) => total + file.byteLength, 0);
  if (artifact.collection.collectedFiles !== artifact.files.length || artifact.collection.collectedBytes !== collectedBytes)
    ctx.addIssue({ code: 'custom', message: 'Content collection counters mismatch' });
  for (const file of artifact.files) {
    if (file.evidenceId !== repositoryContentEvidenceId({ ...file, classification: artifact.classification })
      || !isAllowedInspectionPath(artifact.classification, file.filePath)
      || file.commitSha !== artifact.repositorySnapshot.commitSha
      || file.contentSha256 !== sha256Hex(file.content)
      || file.byteLength !== utf8ByteLength(file.content)
      || file.byteLength > REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile)
      ctx.addIssue({ code: 'custom', message: 'Committed content identity mismatch' });
  }
});
export type RepositoryPlanContentArtifact = z.infer<typeof RepositoryPlanContentSchema>;

export type RepositoryPlanContentSelectionResult =
  | { ok: true; selection: readonly RepositoryPlanContentSelectionEntry[] }
  | { ok: false; code: 'foundation_invalid' | 'classification_not_present' | 'evidence_invalid' | 'path_not_authorized' };

export type BuildRepositoryPlanContentInput = Readonly<{
  foundation: RepositoryPlanFoundationArtifact;
  classification: RepositoryClassification;
  collected: readonly RepositoryPlanCollectedContentInput[];
}>;
export type BuildRepositoryPlanContentResult =
  | { ok: true; artifact: RepositoryPlanContentArtifact }
  | { ok: false; code: 'foundation_invalid' | 'classification_not_present' | 'evidence_invalid' | 'path_not_authorized'
    | 'unsupported_mode' | 'unsupported_content' | 'invalid_utf8' | 'file_too_large'
    | 'collection_file_limit_exceeded' | 'collection_byte_limit_exceeded'; evidenceId?: string };

type EvidenceIdentity = Readonly<{
  commitSha: string;
  classification: RepositoryClassification;
  filePath: string;
  blobSha: string;
}>;

/** Stable content identity only; evidence prose and provider data are deliberately excluded. */
export function repositoryContentEvidenceId(identity: EvidenceIdentity): string {
  return `ev_${hashCanonical({
    domain: 'eightforge.repository-content-evidence', schemaVersion: 1,
    commitSha: identity.commitSha, classification: identity.classification,
    filePath: identity.filePath, blobSha: identity.blobSha,
  })}`;
}

/** Selects committed paths only from the foundation's canonically ordered evidence. */
export function selectRepositoryPlanContent(
  foundation: RepositoryPlanFoundationArtifact,
  classification: RepositoryClassification,
): RepositoryPlanContentSelectionResult {
  const parsedFoundation = RepositoryPlanFoundationSchema.safeParse(foundation);
  if (!parsedFoundation.success) return { ok: false, code: 'foundation_invalid' };
  const parsedClassification = RepositoryClassificationSchema.safeParse(classification);
  if (!parsedClassification.success) return { ok: false, code: 'evidence_invalid' };
  const trusted = parsedFoundation.data;
  if (classification === 'ADVISORY') return { ok: true, selection: freeze([]) };
  const scopedManifest = trusted.repositoryEvidence.manifest.filter((entry) => entry.classification === classification);
  if (scopedManifest.length === 0) return { ok: false, code: 'classification_not_present' };
  const manifest = new Map(scopedManifest.map((entry) => [entry.filePath, entry]));
  const selected = new Map<string, RepositoryPlanContentSelectionEntry>();
  for (const record of trusted.repositoryEvidence.evidence) {
    if (record.classification !== classification) continue;
    for (const [filePath, role] of [[record.filePath, 'source'], [record.relevantTestPath, 'relevant_test']] as const) {
      if (filePath === undefined) continue;
      if (!isAllowedInspectionPath(classification, filePath)) return { ok: false, code: 'path_not_authorized' };
      const inspected = manifest.get(filePath);
      if (!inspected || inspected.commitSha !== trusted.repositoryEvidence.repositorySnapshot.commitSha)
        return { ok: false, code: 'evidence_invalid' };
      const id = repositoryContentEvidenceId(inspected);
      const prior = selected.get(id);
      if (prior) prior.roles = orderedRoles([...prior.roles, role]);
      else selected.set(id, { evidenceId: id, filePath, blobSha: inspected.blobSha,
        commitSha: inspected.commitSha, roles: [role] });
    }
  }
  return { ok: true, selection: freeze(JSON.parse(canonicalJson([...selected.values()])) as RepositoryPlanContentSelectionEntry[]) };
}

/** Finalizes already verified UTF-8 blob content without accepting caller-selected paths. */
export function buildRepositoryPlanContent(input: BuildRepositoryPlanContentInput): BuildRepositoryPlanContentResult {
  const selection = selectRepositoryPlanContent(input.foundation, input.classification);
  if (!selection.ok) return selection;
  if (selection.selection.length > REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles)
    return { ok: false, code: 'collection_file_limit_exceeded' };
  const parsed = z.array(collectedInputSchema).max(REPOSITORY_PLAN_CONTENT_LIMITS.maxFiles).safeParse(input.collected);
  if (!parsed.success) return { ok: false, code: 'evidence_invalid' };
  const byEvidenceId = new Map(parsed.data.map((file) => [file.evidenceId, file]));
  if (byEvidenceId.size !== parsed.data.length || parsed.data.length !== selection.selection.length
    || selection.selection.some((entry) => !byEvidenceId.has(entry.evidenceId)))
    return { ok: false, code: 'evidence_invalid' };
  let collectedBytes = 0;
  const files = [] as z.infer<typeof RepositoryPlanCommittedFileSchema>[];
  for (const selected of selection.selection) {
    const content = byEvidenceId.get(selected.evidenceId)!;
    if (!isWellFormedUtf16(content.content)) return { ok: false, code: 'invalid_utf8', evidenceId: selected.evidenceId };
    if (content.content.includes('\0') || content.content.startsWith('\uFEFF'))
      return { ok: false, code: 'unsupported_content', evidenceId: selected.evidenceId };
    const byteLength = utf8ByteLength(content.content);
    if (byteLength !== content.byteLength || sha256Hex(content.content) !== content.contentSha256)
      return { ok: false, code: 'evidence_invalid', evidenceId: selected.evidenceId };
    if (byteLength > REPOSITORY_PLAN_CONTENT_LIMITS.maxBytesPerFile)
      return { ok: false, code: 'file_too_large', evidenceId: selected.evidenceId };
    collectedBytes += byteLength;
    if (collectedBytes > REPOSITORY_PLAN_CONTENT_LIMITS.maxTotalBytes)
      return { ok: false, code: 'collection_byte_limit_exceeded', evidenceId: selected.evidenceId };
    files.push({ ...selected, ...content, contentTrust: 'untrusted_repository_data' });
  }
  const trustedFoundation = RepositoryPlanFoundationSchema.parse(input.foundation);
  const envelope = {
    domain: 'eightforge.repository-committed-content' as const, schemaVersion: 1 as const,
    stage: 'pre_provider_content' as const,
    authority: 'non_authoritative' as const, executable: false as const,
    grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    contentTrust: 'untrusted_repository_data' as const,
    sourceFoundationDigestSha256: trustedFoundation.digest.value,
    repositorySnapshot: trustedFoundation.source.repositorySnapshot,
    classification: input.classification,
    files,
    collection: { ...REPOSITORY_PLAN_CONTENT_LIMITS, collectedFiles: files.length, collectedBytes },
  };
  const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
  const validated = RepositoryPlanContentSchema.safeParse(artifact);
  if (!validated.success) return { ok: false, code: 'evidence_invalid' };
  return { ok: true, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanContentArtifact) };
}

function orderedRoles(roles: readonly RepositoryPlanContentRole[]): RepositoryPlanContentRole[] {
  return (['source', 'relevant_test'] as const).filter((role) => roles.includes(role));
}
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
  }
  return true;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
