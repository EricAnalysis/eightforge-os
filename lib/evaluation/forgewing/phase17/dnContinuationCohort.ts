import { createHash } from 'node:crypto';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildPagePricedScheduleReconstruction }
  from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { RecoveryCandidateV2Schema, type RecoveryCandidateV2 }
  from '@/lib/extraction/recovery/recoveryCandidateV2';
import {
  PHASE17_DN_CORPUS,
  PHASE17_HARNESS_IDENTITY,
  PHASE17_RECOVERY_TYPE,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

/**
 * Regenerates the Phase 17 continuation cohort from the pinned DN bytes.
 *
 * Deterministic and offline: it runs the production PDF layout loader and the
 * production priced-schedule reconstruction with a candidate build context,
 * exactly as the Phase 14 qualification harness does. No provider is reachable
 * from this module. A cohort that differs from the pinned shape is a failure,
 * never a partial cohort.
 */

export class Phase17CohortError extends Error {
  constructor(readonly code:
    | 'corpus_sha256_mismatch'
    | 'corpus_byte_length_mismatch'
    | 'corpus_page_count_mismatch'
    | 'priced_page_mismatch'
    | 'fragment_count_mismatch'
    | 'candidate_count_mismatch'
    | 'candidate_contract_failed', detail: string) {
    super(`PHASE17_COHORT_${code.toUpperCase()}: ${detail}`);
    this.name = 'Phase17CohortError';
  }
}

export type Phase17CohortUnit = Readonly<{
  unitKey: string;
  physicalPageNumber: number;
  fragmentObservationIds: readonly string[];
  /** Production emission order: candidates sorted by candidate id. */
  canonicalCandidates: readonly RecoveryCandidateV2[];
  /** Target descriptions differ by a short tail: the hardest real cases. */
  nearIdentical: boolean;
}>;

export type Phase17Cohort = Readonly<{
  corpusSha256: string;
  corpusByteLength: number;
  units: readonly Phase17CohortUnit[];
}>;

/** Same grouping key the production V2 scheduler uses for continuation units. */
export function phase17UnitKey(candidate: Pick<RecoveryCandidateV2,
  'recoveryType' | 'physicalPageNumber' | 'orderedObservationIds'>): string {
  return `dn-continuation-unit-${hashCanonical({
    recoveryType: candidate.recoveryType,
    physicalPageNumber: candidate.physicalPageNumber,
    orderedObservationIds: candidate.orderedObservationIds,
  }).slice(0, 24)}`;
}

/** Monetary tokens differ between every pair of rows; compare descriptions only. */
function normalized(text: string): string {
  return text.replace(/\$[\d,]+(?:\.\d+)?/g, ' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Two target rows are near-identical when their authored text, with monetary
 * tokens removed, shares at least 60% of the longer text as a common prefix
 * ("Hazardous Tree Stump Excavation" vs "Hazardous Tree Stump Removal"). Only
 * the boolean leaves this process.
 */
export function phase17NearIdentical(candidates: readonly RecoveryCandidateV2[]): boolean {
  const [left, right] = candidates.map((candidate) =>
    normalized(candidate.targetContextEvidence?.composedRawText ?? ''));
  if (!left || !right) return false;
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  return prefix / Math.max(left.length, right.length) >= 0.6;
}

export function buildPhase17CohortFromCandidates(
  candidates: readonly RecoveryCandidateV2[],
): readonly Phase17CohortUnit[] {
  for (const candidate of candidates) {
    const parsed = RecoveryCandidateV2Schema.safeParse(candidate);
    if (!parsed.success || candidate.recoveryType !== PHASE17_RECOVERY_TYPE
      || !candidate.targetContextEvidence) {
      throw new Phase17CohortError('candidate_contract_failed', candidate.candidateId);
    }
  }
  const groups = new Map<string, RecoveryCandidateV2[]>();
  const ordered = [...candidates].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId, 'en-US'));
  for (const candidate of ordered) {
    const key = phase17UnitKey(candidate);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }
  if (groups.size !== PHASE17_DN_CORPUS.ambiguousFragments) {
    throw new Phase17CohortError('fragment_count_mismatch',
      `expected ${PHASE17_DN_CORPUS.ambiguousFragments} units, got ${groups.size}`);
  }
  const units = [...groups.entries()].map(([unitKey, unitCandidates]): Phase17CohortUnit => {
    if (unitCandidates.length !== PHASE17_DN_CORPUS.candidatesPerFragment) {
      throw new Phase17CohortError('candidate_count_mismatch',
        `${unitKey} carries ${unitCandidates.length} candidates`);
    }
    return {
      unitKey,
      physicalPageNumber: unitCandidates[0]!.physicalPageNumber,
      fragmentObservationIds: [...unitCandidates[0]!.orderedObservationIds],
      canonicalCandidates: unitCandidates,
      nearIdentical: phase17NearIdentical(unitCandidates),
    };
  });
  return units.sort((left, right) => left.unitKey.localeCompare(right.unitKey, 'en-US'));
}

export function verifyPhase17CorpusBytes(bytes: Uint8Array): string {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== PHASE17_DN_CORPUS.sha256) {
    throw new Phase17CohortError('corpus_sha256_mismatch', sha256);
  }
  if (bytes.byteLength !== PHASE17_DN_CORPUS.byteLength) {
    throw new Phase17CohortError('corpus_byte_length_mismatch', String(bytes.byteLength));
  }
  return sha256;
}

export async function buildPhase17DnCohort(bytes: Uint8Array): Promise<Phase17Cohort> {
  const corpusSha256 = verifyPhase17CorpusBytes(bytes);
  const context = {
    sourceDocumentId: PHASE17_HARNESS_IDENTITY.sourceDocumentId,
    sourceArtifactId: PHASE17_HARNESS_IDENTITY.sourceArtifactId,
  };
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const layout = await loadPdfLayout(buffer as ArrayBuffer, { observationIdentity: context });
  if (layout.pages.length !== PHASE17_DN_CORPUS.physicalPageCount) {
    throw new Phase17CohortError('corpus_page_count_mismatch', String(layout.pages.length));
  }
  const reconstruction = buildPagePricedScheduleReconstruction({
    layout,
    recoveryCandidateBuildContext: {
      ...context,
      pageRepresentationDigestByPage: Object.fromEntries(layout.pages.map((page) =>
        [page.page_number, PHASE17_HARNESS_IDENTITY.pageRepresentationDigest])),
    },
  });
  if (reconstruction.pages.length !== 1
    || reconstruction.pages[0]!.physical_page_number !== PHASE17_DN_CORPUS.physicalPageNumber) {
    throw new Phase17CohortError('priced_page_mismatch',
      reconstruction.pages.map((page) => page.physical_page_number).join(','));
  }
  const ambiguous = reconstruction.pages[0]!.unassigned_lines
    .filter((line) => line.reason === 'ambiguous_row_assignment');
  if (ambiguous.length !== PHASE17_DN_CORPUS.ambiguousFragments) {
    throw new Phase17CohortError('fragment_count_mismatch', String(ambiguous.length));
  }
  const candidates = reconstruction.recovery_candidates ?? [];
  if (candidates.length !== PHASE17_DN_CORPUS.candidates) {
    throw new Phase17CohortError('candidate_count_mismatch', String(candidates.length));
  }
  return {
    corpusSha256,
    corpusByteLength: bytes.byteLength,
    units: buildPhase17CohortFromCandidates(candidates),
  };
}
