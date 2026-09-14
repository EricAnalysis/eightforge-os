import { buildRecoveryCandidateV2, type RecoveryCandidateV2 }
  from '@/lib/extraction/recovery/recoveryCandidateV2';
import { buildPhase17CohortFromCandidates, type Phase17Cohort }
  from '@/lib/evaluation/forgewing/phase17/dnContinuationCohort';
import { buildPhase17LabelTemplate }
  from '@/lib/evaluation/forgewing/phase17/dnContinuationLabels';
import {
  PHASE17_DN_CORPUS,
  PHASE17_HARNESS_IDENTITY,
  PHASE17_HUMAN_INDETERMINATE,
  type Phase17LabelSet,
} from '@/lib/evaluation/forgewing/phase17/phase17Contract';

/**
 * Synthetic stand-in for the DN cohort: 13 fragments, two candidate target rows
 * each, built through the production candidate builder. Contains no DN text.
 * The real corpus is exercised only by the explicit Phase 17 command.
 */

function evidence(id: string, text: string, y: number) {
  return { observationId: id, sourceLayer: 'pdf_native_text' as const, rawText: text,
    boundingBox: { xMin: 100, xMax: 300, yMin: y, yMax: y + 8 } };
}

export function syntheticPhase17Candidates(): RecoveryCandidateV2[] {
  return Array.from({ length: PHASE17_DN_CORPUS.ambiguousFragments }, (_, index) => {
    const fragment = evidence(`synthetic:fragment:${index}`, `continuation ${index}`, 500 - index * 20);
    return ['above', 'below'].map((side, sideIndex) => {
      const row = `page_priced_schedule:p106:r${index * 2 + sideIndex}`;
      const context = evidence(`synthetic:row:${index}:${side}`,
        `Synthetic Item ${index} ${side}`, 505 - index * 20 - sideIndex * 10);
      const built = buildRecoveryCandidateV2({
        recoveryType: 'priced_schedule_continuation_attribution',
        sourceDocumentId: PHASE17_HARNESS_IDENTITY.sourceDocumentId,
        sourceArtifactId: PHASE17_HARNESS_IDENTITY.sourceArtifactId,
        physicalPageNumber: PHASE17_DN_CORPUS.physicalPageNumber,
        pageRepresentationDigest: PHASE17_HARNESS_IDENTITY.pageRepresentationDigest,
        targetRowIdentity: row,
        orderedObservationIds: [fragment.observationId],
        rawTexts: [fragment.rawText],
        composedRawText: fragment.rawText,
        evidence: [fragment],
        targetContextEvidence: {
          targetRowIdentity: row,
          orderedObservationIds: [context.observationId],
          rawTexts: [context.rawText],
          composedRawText: context.rawText,
          evidence: [context],
        },
      });
      if (!built) throw new Error('synthetic candidate failed');
      return built;
    });
  }).flat();
}

export function syntheticPhase17Cohort(): Phase17Cohort {
  return {
    corpusSha256: PHASE17_DN_CORPUS.sha256,
    corpusByteLength: PHASE17_DN_CORPUS.byteLength,
    units: buildPhase17CohortFromCandidates(syntheticPhase17Candidates()),
  };
}

/** Human-style labels: the "above" row, except optional indeterminate units. */
export function syntheticPhase17Labels(cohort: Phase17Cohort, options: Readonly<{
  indeterminateUnitKeys?: readonly string[];
  unlabeledUnitKeys?: readonly string[];
}> = {}): Phase17LabelSet {
  const template = buildPhase17LabelTemplate(cohort);
  return {
    ...template,
    units: template.units.map((unit) => {
      if (options.unlabeledUnitKeys?.includes(unit.unitKey)) return unit;
      const cohortUnit = cohort.units.find((entry) => entry.unitKey === unit.unitKey)!;
      const above = cohortUnit.canonicalCandidates.find((candidate) =>
        candidate.targetContextEvidence?.rawTexts[0]?.includes('above'))!;
      return {
        ...unit,
        expected: options.indeterminateUnitKeys?.includes(unit.unitKey)
          ? PHASE17_HUMAN_INDETERMINATE : above.candidateId,
        labeledBy: 'synthetic-test-human',
        labeledAt: '2026-09-13T12:00:00.000Z',
        note: null,
      };
    }),
  };
}

export function expectedAboveCandidateId(candidates: readonly RecoveryCandidateV2[]): string {
  return candidates.find((candidate) =>
    candidate.targetContextEvidence?.rawTexts[0]?.includes('above'))!.candidateId;
}
