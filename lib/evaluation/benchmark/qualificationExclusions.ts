import type { QualificationTargetBinding } from '@/lib/evaluation/benchmark/qualificationBinding';

/** Exclusions are human decisions tied to exact source and observation identities. */
export const QUALIFICATION_EXCLUSIONS_VERSION = 'b461-exclusions-v1' as const;

export type QualificationExclusionAnchor = Readonly<{
  identity: string;
  documentId: string;
  sourceSha256: string;
  pageDigest: string;
  physicalPageNumber: number;
  observationAnchorKey: string;
  pageKey: string | null;
  labelRowKey: string | null;
}>;

export type QualificationExclusion = Readonly<{
  id: string;
  reason: string;
  /** Null means the human decision exists but its immutable anchor is unresolved. */
  anchor: QualificationExclusionAnchor | null;
}>;

/** Human source review, anchored to the final v5 Golden capture, never OCR text matching. */
export const QUALIFICATION_EXCLUSIONS: readonly QualificationExclusion[] = Object.freeze([
  {
    id: 'golden-p8-r0006-source-review',
    reason: 'Golden p8 labelled r-0006 OCR misread; excluded by human source review',
    anchor: {
      identity: 'b42de2b5-8c99-48c8-838c-fe425d4d32bd:p8:priced_line:fae8ff033a5a752cbd3ac9146bfb3d47',
      documentId: 'b42de2b5-8c99-48c8-838c-fe425d4d32bd',
      sourceSha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
      pageDigest: '996f76cad493b1d5cbb1cbdc590055efd0934fc146700188b3801853e6e4fca0',
      physicalPageNumber: 8,
      observationAnchorKey: 'p8:priced_line:fae8ff033a5a752cbd3ac9146bfb3d47',
      pageKey: 'golden-p8', labelRowKey: 'r-0006',
    },
  },
  {
    id: 'golden-p10-main-row21-source-review',
    reason: 'Golden p10 main row21 withheld Trackhoe line; excluded by human source review',
    anchor: {
      identity: 'b42de2b5-8c99-48c8-838c-fe425d4d32bd:p10:priced_line:ffbd3878ead5b4115d903e8cac783e25',
      documentId: 'b42de2b5-8c99-48c8-838c-fe425d4d32bd',
      sourceSha256: '922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f',
      pageDigest: 'cfd4541c6e9ea4b808d47230cdd4ba12d8ec2ef23edb6c3ba37bc977fd80a84a',
      physicalPageNumber: 10,
      observationAnchorKey: 'p10:priced_line:ffbd3878ead5b4115d903e8cac783e25',
      pageKey: null, labelRowKey: null,
    },
  },
]);

export type QualificationExcludedCase = Readonly<{
  exclusion: QualificationExclusion;
  binding: QualificationTargetBinding;
}>;

export type QualificationExclusionPartition = Readonly<{
  version: typeof QUALIFICATION_EXCLUSIONS_VERSION;
  eligibleBindings: readonly QualificationTargetBinding[];
  excludedCases: readonly QualificationExcludedCase[];
  /** Every unresolved, absent or changed anchor blocks freeze and activation. */
  pending: readonly string[];
}>;

function sameAnchor(a: QualificationExclusionAnchor, b: QualificationExclusionAnchor): boolean {
  return a.identity === b.identity && a.documentId === b.documentId && a.sourceSha256 === b.sourceSha256
    && a.pageDigest === b.pageDigest
    && a.physicalPageNumber === b.physicalPageNumber && a.observationAnchorKey === b.observationAnchorKey
    && a.pageKey === b.pageKey && a.labelRowKey === b.labelRowKey;
}

export function partitionQualificationExclusions(params: Readonly<{
  bindings: readonly QualificationTargetBinding[];
  registry: readonly QualificationExclusion[];
  /** Current source/observation identities, derived from verified pins and inventory. */
  anchorsByIdentity: ReadonlyMap<string, QualificationExclusionAnchor>;
}>): QualificationExclusionPartition {
  const excludedCases: QualificationExcludedCase[] = [];
  const pending: string[] = [];
  const excluded = new Set<string>();
  const ids = new Set<string>();
  for (const exclusion of params.registry) {
    if (ids.has(exclusion.id)) throw new Error(`duplicate exclusion id: ${exclusion.id}`);
    ids.add(exclusion.id);
    const anchor = exclusion.anchor;
    if (!anchor) { pending.push(`${exclusion.id}: immutable anchor unresolved`); continue; }
    if (!/^[a-f0-9]{64}$/.test(anchor.sourceSha256) || !/^[a-f0-9]{64}$/.test(anchor.pageDigest) || !anchor.documentId || !anchor.identity
      || !anchor.observationAnchorKey || !Number.isInteger(anchor.physicalPageNumber) || anchor.physicalPageNumber < 1) {
      throw new Error(`invalid exclusion anchor: ${exclusion.id}`);
    }
    const matches = params.bindings.filter((binding) => binding.identity === anchor.identity);
    const current = params.anchorsByIdentity.get(anchor.identity);
    const binding = matches[0];
    if (matches.length !== 1 || !current || !sameAnchor(anchor, current) || !binding
      || binding.physicalPageNumber !== anchor.physicalPageNumber || binding.pageKey !== anchor.pageKey
      || binding.labelRowKey !== anchor.labelRowKey) {
      pending.push(`${exclusion.id}: exact source/observation binding absent or changed`);
      continue;
    }
    if (excluded.has(binding.identity)) throw new Error(`duplicate exclusion anchor: ${binding.identity}`);
    excluded.add(binding.identity);
    excludedCases.push({ exclusion, binding });
  }
  return { version: QUALIFICATION_EXCLUSIONS_VERSION,
    eligibleBindings: params.bindings.filter((binding) => !excluded.has(binding.identity)), excludedCases, pending };
}

export function assertQualificationExclusionsFinalized(partition: QualificationExclusionPartition): void {
  if (partition.pending.length) throw new Error(`qualification exclusions not finalized: ${partition.pending.join('; ')}`);
}
