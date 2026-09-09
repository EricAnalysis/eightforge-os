import { z } from 'zod';

import {
  InspectedRepositoryFileSchema,
  RepositoryClassificationSchema,
  RepositoryEvidenceRecordSchema,
  RepositoryRelativePathSchema,
  isAllowedInspectionPath,
} from '@/lib/repositoryPlanEvidence';
import { RepositorySnapshotSchema } from '@/lib/repositoryPlanSnapshot';

export const REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH =
  'lib/repositoryPlanEvidenceCatalog.v1.json' as const;

export const REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS = Object.freeze({
  maxCatalogBytes: 65_536 as const,
  maxFilesPerClassification: 20 as const,
  maxBytesPerFile: 16_384 as const,
  maxTotalBytesPerClassification: 196_608 as const,
});

const evidenceKind = z.enum([
  'implementation_seam',
  'authored_rule',
  'document_type',
  'recovery_pattern',
  'authority_contract',
  'test',
]);

export const RepositoryPlanEvidenceCatalogEntrySchema = z.object({
  classification: RepositoryClassificationSchema,
  filePath: RepositoryRelativePathSchema,
  symbol: z.string().min(1).max(200).optional(),
  evidenceKind,
  reason: z.string().min(1).max(2000),
  relevantTestPath: RepositoryRelativePathSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.classification === 'ADVISORY'
    || !isAllowedInspectionPath(entry.classification, entry.filePath)
    || (entry.relevantTestPath !== undefined
      && (!isAllowedInspectionPath(entry.classification, entry.relevantTestPath)
        || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.relevantTestPath)))) {
    ctx.addIssue({ code: 'custom', message: 'Catalog entry is outside its closed classification scope' });
  }
});

export const RepositoryPlanEvidenceCatalogSchema = z.object({
  domain: z.literal('eightforge.repository-plan-evidence-catalog'),
  schemaVersion: z.literal(1),
  entries: z.array(RepositoryPlanEvidenceCatalogEntrySchema).max(100),
}).strict().superRefine((catalog, ctx) => {
  const identities = new Set<string>();
  for (const entry of catalog.entries) {
    const identity = `${entry.classification}:${entry.filePath}`;
    if (identities.has(identity)) {
      ctx.addIssue({ code: 'custom', message: 'Duplicate catalog entry identity' });
    }
    identities.add(identity);
  }
});

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const RepositoryPlanEvidenceCatalogInspectionSchema = z.object({
  domain: z.literal('eightforge.repository-plan-evidence-catalog-inspection'),
  schemaVersion: z.literal(1),
  authority: z.literal('non_authoritative'),
  executable: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  requiresHumanReview: z.literal(true),
  repositorySnapshot: RepositorySnapshotSchema,
  classification: RepositoryClassificationSchema,
  catalog: z.object({
    filePath: z.literal(REPOSITORY_PLAN_EVIDENCE_CATALOG_PATH),
    commitSha: sha1,
    blobSha: sha1,
    canonicalDigestSha256: sha256,
    contentSha256: sha256,
    byteLength: z.number().int().nonnegative().max(REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxCatalogBytes),
  }).strict(),
  manifest: z.array(InspectedRepositoryFileSchema)
    .max(REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxFilesPerClassification),
  evidence: z.array(RepositoryEvidenceRecordSchema)
    .max(REPOSITORY_PLAN_EVIDENCE_CATALOG_LIMITS.maxFilesPerClassification),
}).strict().superRefine((inspection, ctx) => {
  if (inspection.catalog.commitSha !== inspection.repositorySnapshot.commitSha
    || inspection.manifest.some((entry) => entry.commitSha !== inspection.repositorySnapshot.commitSha
      || entry.classification !== inspection.classification)
    || inspection.evidence.some((entry) => entry.commitSha !== inspection.repositorySnapshot.commitSha
      || entry.classification !== inspection.classification)) {
    ctx.addIssue({ code: 'custom', message: 'Catalog inspection identity mismatch' });
  }
});

export type RepositoryPlanEvidenceCatalog = z.infer<typeof RepositoryPlanEvidenceCatalogSchema>;
export type RepositoryPlanEvidenceCatalogInspection =
  z.infer<typeof RepositoryPlanEvidenceCatalogInspectionSchema>;
