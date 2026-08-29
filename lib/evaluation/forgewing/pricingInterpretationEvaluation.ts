/**
 * Forgewing pricing-interpretation evaluation harness — MECHANICS ONLY.
 *
 * No corpus (Golden/TDOT/MDOT) is wired into this module, and none is
 * fabricated to stand in for it. This harness measures evidence fidelity,
 * determinism, and abstention/failure-mode shape against whatever bundle and
 * frozen source artifacts it is given. It computes no precision, recall, or
 * accuracy, and makes no promotion-readiness or authority claim — there is
 * no deterministic "correct role" for an ambiguous/conflicting pricing row to
 * compare against, unlike region classification's `region_role: 'table'`
 * baseline. Corpus status: UNMET.
 *
 * Imported by NO production module. Only tests and future evaluation tooling
 * may use it.
 */

import type {
  ForgewingAbstentionReason,
  ForgewingPricingInterpretationProposalBundle,
  ForgewingPricingSemanticRole,
} from '@/lib/forgewing/proposal/schema';
import { ForgewingPricingInterpretationProposalBundleSchema } from '@/lib/forgewing/proposal/schema';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';

export const FORGEWING_PRICING_INTERPRETATION_EVALUATION_VERSION =
  'forgewing-pricing-interpretation-evaluation-v1' as const;

export type PricingEvaluationBoundingBox = Readonly<{
  coordinateSpace: 'page_normalized';
  origin: 'top_left';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rotation: 0 | 90 | 180 | 270;
}>;

/**
 * Record of one bounded pricing cell/row artifact. It may be derived from the exact
 * bounded provider input or extraction snapshot, but is checked independently
 * relative to model output.
 */
export type FrozenPricingArtifact = Readonly<{
  artifactId: string;
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  pageArtifactId: string | null;
  physicalPageNumber: number | null;
  artifactLocalIndex: number | null;
  sourceLayer: string | null;
  boundingBox: PricingEvaluationBoundingBox | null;
  rawText: string | null;
}>;

export type FrozenPricingObservationSetInput = Pick<
  ForgewingPricingInterpretationInput,
  'organizationId' | 'sourceDocumentId' | 'sourceArtifactId' | 'extractionSnapshotId'
> & Readonly<{ rowObservation: ForgewingPricingInterpretationInput['rowObservation'] }>;

function adaptPricingEvaluationBoundingBox(
  value: ForgewingPricingInterpretationInput['rowObservation']['boundingBox'],
): PricingEvaluationBoundingBox | null {
  if (!value) return null;
  if (![0, 90, 180, 270].includes(value.rotation)) {
    throw new Error('invalid_frozen_pricing_bounding_box');
  }
  return { ...value, rotation: value.rotation as 0 | 90 | 180 | 270 };
}

/** Freeze the exact bounded task observations independently of model output. */
export function adaptFrozenPricingArtifacts(
  input: FrozenPricingObservationSetInput,
): readonly FrozenPricingArtifact[] {
  const row = input.rowObservation;
  const artifacts: FrozenPricingArtifact[] = [{
    artifactId: row.observationId,
    organizationId: input.organizationId,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId,
    extractionSnapshotId: input.extractionSnapshotId,
    pageArtifactId: row.pageArtifactId ?? null,
    physicalPageNumber: row.physicalPageNumber,
    artifactLocalIndex: row.artifactLocalIndex ?? null,
    sourceLayer: row.sourceLayer ?? null,
    boundingBox: adaptPricingEvaluationBoundingBox(row.boundingBox),
    rawText: row.rawText,
  }, ...row.cells
    .map((cell): FrozenPricingArtifact => ({
      artifactId: cell.observationId,
      organizationId: input.organizationId,
      sourceDocumentId: cell.sourceDocumentId ?? input.sourceDocumentId,
      sourceArtifactId: cell.sourceArtifactId ?? input.sourceArtifactId,
      extractionSnapshotId: input.extractionSnapshotId,
      pageArtifactId: cell.pageArtifactId ?? null,
      physicalPageNumber: cell.physicalPageNumber ?? row.physicalPageNumber,
      artifactLocalIndex: cell.artifactLocalIndex ?? null,
      sourceLayer: cell.sourceLayer ?? null,
      boundingBox: adaptPricingEvaluationBoundingBox(cell.boundingBox),
      rawText: cell.rawText,
    }))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId, 'en-US'))];
  if (new Set(artifacts.map((artifact) => artifact.artifactId)).size !== artifacts.length) {
    throw new Error('duplicate_frozen_pricing_artifact_identity');
  }
  return artifacts;
}

export type PricingEvidenceCheckStatus = 'match' | 'mismatch' | 'not_claimed' | 'unverifiable';
export type PricingEvidenceFidelityStatus = 'valid' | 'invalid' | 'unverifiable';

export type PricingEvidenceFidelityFinding = Readonly<{
  proposalId: string;
  interpretationIndex: number;
  artifactId: string;
  status: PricingEvidenceFidelityStatus;
  checks: Readonly<{
    artifact: PricingEvidenceCheckStatus;
    sourceDocument: PricingEvidenceCheckStatus;
    sourceArtifact: PricingEvidenceCheckStatus;
    extractionSnapshot: PricingEvidenceCheckStatus;
    pageArtifact: PricingEvidenceCheckStatus;
    physicalPage: PricingEvidenceCheckStatus;
    artifactLocalIndex: PricingEvidenceCheckStatus;
    sourceLayer: PricingEvidenceCheckStatus;
    geometry: PricingEvidenceCheckStatus;
    rawSpan: PricingEvidenceCheckStatus;
  }>;
  diagnostics: readonly string[];
}>;

export type ForgewingPricingInterpretationEvaluationInput = Readonly<{
  /** Caller-validated or raw bundle; re-validated internally regardless. */
  bundle: ForgewingPricingInterpretationProposalBundle;
  /**
   * Frozen artifacts for the same extraction snapshot. They may come from the
   * exact bounded provider input, but are evaluated independently of model output.
   */
  sourceArtifacts: readonly FrozenPricingArtifact[];
  expectedExtractionSnapshotId: string;
  expectedOrganizationId: string;
  expectedPricingScopeIdentity: string;
  expectedRowObservationId: string;
  /** False when the task exited before its exact provider-bounded observation set was captured. */
  frozenObservationSetAvailable?: boolean;
}>;

export type PricingConfidenceBucket = '0.0-0.2' | '0.2-0.4' | '0.4-0.6' | '0.6-0.8' | '0.8-1.0' | 'null';

const CONFIDENCE_BUCKETS: readonly PricingConfidenceBucket[] = [
  '0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0', 'null',
];

const PRICING_SEMANTIC_ROLES: readonly ForgewingPricingSemanticRole[] = [
  'category_like_text', 'description_like_text', 'unit_like_text', 'rate_like_amount',
  'quantity_like_amount', 'item_number_like_text', 'extended_amount_like_text', 'unknown',
];

const ABSTENTION_REASONS: readonly ForgewingAbstentionReason[] = [
  'unsupported_input', 'input_contract_violation', 'budget_unavailable',
  'runtime_unavailable', 'task_not_supported',
];

export type ForgewingPricingInterpretationEvaluationReport = Readonly<{
  evaluationVersion: typeof FORGEWING_PRICING_INTERPRETATION_EVALUATION_VERSION;
  authority: 'non_authoritative_measurement';
  /** Always 'unmet' in this harness. No corpus run is represented by this report. */
  corpusStatus: 'unmet';
  taskType: 'pricing_interpretation';
  runId: string;
  extractionSnapshotId: string;
  summary: Readonly<{
    comparisonStatus: 'comparable' | 'not_comparable';
    comparable: boolean;
    metricsEvaluated: boolean;
    diagnosticCodes: readonly string[];
  }>;
  evidenceFindings: readonly PricingEvidenceFidelityFinding[];
  metrics: Readonly<{
    proposalCount: number;
    abstentionCount: number;
    runtimeAbstentionsByReason: Readonly<Record<ForgewingAbstentionReason, number>>;
    insufficientEvidenceCount: number;
    valueBearingCount: number;
    ambiguousCount: number;
    conflictingCount: number;
    interpretationCount: number;
    byRole: Readonly<Record<ForgewingPricingSemanticRole, number>>;
    confidenceBuckets: Readonly<Record<PricingConfidenceBucket, number>>;
    evidenceValidCount: number;
    evidenceInvalidCount: number;
    evidenceUnverifiableCount: number;
    silentHallucinationCount: number;
    noValueManufactureViolationCount: number;
    snapshotMismatchCount: number;
    identityMismatchCount: number;
  }>;
}>;

function claimedMatch<T>(claimed: T | null | undefined, actual: T | null): PricingEvidenceCheckStatus {
  if (claimed == null) return 'not_claimed';
  if (actual == null) return 'mismatch';
  return claimed === actual ? 'match' : 'mismatch';
}

function requiredClaimMatch<T>(claimed: T | null | undefined, actual: T | null): PricingEvidenceCheckStatus {
  if (claimed == null) return 'unverifiable';
  if (actual == null) return 'mismatch';
  return claimed === actual ? 'match' : 'mismatch';
}

function sameGeometry(
  claimed: PricingEvaluationBoundingBox,
  actual: PricingEvaluationBoundingBox,
): boolean {
  return claimed.coordinateSpace === actual.coordinateSpace
    && claimed.origin === actual.origin
    && claimed.x0 === actual.x0
    && claimed.y0 === actual.y0
    && claimed.x1 === actual.x1
    && claimed.y1 === actual.y1
    && claimed.rotation === actual.rotation;
}

function findingStatus(checks: readonly PricingEvidenceCheckStatus[]): PricingEvidenceFidelityStatus {
  if (checks.includes('mismatch')) return 'invalid';
  if (checks.includes('unverifiable')) return 'unverifiable';
  return 'valid';
}

function confidenceBucket(confidence: number | null): PricingConfidenceBucket {
  if (confidence == null) return 'null';
  if (confidence < 0.2) return '0.0-0.2';
  if (confidence < 0.4) return '0.2-0.4';
  if (confidence < 0.6) return '0.4-0.6';
  if (confidence < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}

export function evaluateForgewingPricingInterpretation(
  rawInput: ForgewingPricingInterpretationEvaluationInput,
): ForgewingPricingInterpretationEvaluationReport {
  const bundle = ForgewingPricingInterpretationProposalBundleSchema.parse(rawInput.bundle);
  const artifactCounts = new Map<string, number>();
  for (const artifact of rawInput.sourceArtifacts) {
    artifactCounts.set(artifact.artifactId, (artifactCounts.get(artifact.artifactId) ?? 0) + 1);
  }
  const artifactById = new Map(rawInput.sourceArtifacts.map((artifact) => [artifact.artifactId, artifact]));

  const snapshotMismatchCount = Number(
    bundle.run.extractionSnapshotId !== rawInput.expectedExtractionSnapshotId,
  ) + rawInput.sourceArtifacts.filter(
    (artifact) => artifact.extractionSnapshotId !== rawInput.expectedExtractionSnapshotId,
  ).length;
  const snapshotMismatch = snapshotMismatchCount > 0;
  const proposalIdentities = bundle.proposals.map((proposal) => ({
    organizationMatches: bundle.run.organizationId === rawInput.expectedOrganizationId,
    rowMatches: proposal.rowObservationId === rawInput.expectedRowObservationId,
    scopeMatches: proposal.pricingScopeIdentity === rawInput.expectedPricingScopeIdentity,
    sourceMatches: rawInput.sourceArtifacts.some((artifact) =>
      artifact.artifactId === rawInput.expectedRowObservationId
      && artifact.organizationId === rawInput.expectedOrganizationId
      && artifact.sourceDocumentId === proposal.sourceDocumentId
      && artifact.sourceArtifactId === proposal.sourceArtifactId),
  }));
  const abstentionOrganizationMismatch = bundle.abstentions.length > 0
    && bundle.run.organizationId !== rawInput.expectedOrganizationId;
  const artifactOrganizationMismatchCount = rawInput.sourceArtifacts.filter(
    (artifact) => artifact.organizationId !== rawInput.expectedOrganizationId,
  ).length;
  const identityMismatchCount = proposalIdentities.reduce((total, identity) =>
    total + Number(!identity.organizationMatches) + Number(!identity.rowMatches)
      + Number(!identity.scopeMatches) + Number(!identity.sourceMatches), 0)
    + Number(abstentionOrganizationMismatch)
    + artifactOrganizationMismatchCount;
  const frozenObservationSetUnavailable = rawInput.frozenObservationSetAvailable === false
    || rawInput.sourceArtifacts.length === 0;
  const notComparable = snapshotMismatch || identityMismatchCount > 0
    || frozenObservationSetUnavailable;

  const runtimeAbstentionsByReason = Object.fromEntries(
    ABSTENTION_REASONS.map((reason) => [reason, 0]),
  ) as Record<ForgewingAbstentionReason, number>;
  for (const abstention of bundle.abstentions) runtimeAbstentionsByReason[abstention.reason] += 1;

  const byRole = Object.fromEntries(
    PRICING_SEMANTIC_ROLES.map((role) => [role, 0]),
  ) as Record<ForgewingPricingSemanticRole, number>;
  const confidenceBuckets = Object.fromEntries(
    CONFIDENCE_BUCKETS.map((bucket) => [bucket, 0]),
  ) as Record<PricingConfidenceBucket, number>;

  const evidenceFindings: PricingEvidenceFidelityFinding[] = [];
  let ambiguousCount = 0;
  let conflictingCount = 0;
  let insufficientEvidenceCount = 0;
  let interpretationCount = 0;
  let silentHallucinationCount = 0;
  const diagnosticCodes = new Set<string>();

  if (snapshotMismatch) diagnosticCodes.add('extraction_snapshot_mismatch');
  if (identityMismatchCount > 0) diagnosticCodes.add('evaluation_identity_mismatch');
  if (frozenObservationSetUnavailable) {
    diagnosticCodes.add('frozen_observation_set_unavailable');
  }

  let noValueManufactureViolationCount = 0;
  for (const proposal of notComparable ? [] : bundle.proposals) {
    if (proposal.rowInterpretationState === 'insufficient_evidence') {
      insufficientEvidenceCount += 1;
      continue;
    }
    if (proposal.rowInterpretationState === 'ambiguous') ambiguousCount += 1;
    if (proposal.rowInterpretationState === 'conflicting') conflictingCount += 1;
    confidenceBuckets[confidenceBucket(proposal.confidence)] += 1;

    let proposalHasInvalidEvidence = false;
    proposal.interpretations.forEach((interpretation, interpretationIndex) => {
      interpretationCount += 1;
      byRole[interpretation.semanticRole] += 1;
      if (['unit_like_text', 'rate_like_amount', 'quantity_like_amount',
        'item_number_like_text', 'extended_amount_like_text'].includes(interpretation.semanticRole)) {
        const matchingArtifacts = rawInput.sourceArtifacts.filter((artifact) =>
          artifact.artifactId === interpretation.sourceCellId);
        if (matchingArtifacts.length !== 1
          || matchingArtifacts[0]?.rawText == null
          || !matchingArtifacts[0].rawText!.includes(interpretation.sourceText)) {
          noValueManufactureViolationCount += 1;
        }
      }

      interpretation.evidenceArtifactIds.forEach((artifactId) => {
        const ambiguousIdentity = (artifactCounts.get(artifactId) ?? 0) > 1;
        const artifact = ambiguousIdentity ? undefined : artifactById.get(artifactId);

        if (!artifact) {
          const checks = {
            artifact: 'mismatch' as const,
            sourceDocument: 'unverifiable' as const,
            sourceArtifact: 'unverifiable' as const,
            extractionSnapshot: 'unverifiable' as const,
            pageArtifact: 'unverifiable' as const,
            physicalPage: 'unverifiable' as const,
            artifactLocalIndex: 'unverifiable' as const,
            sourceLayer: 'unverifiable' as const,
            geometry: 'unverifiable' as const,
            rawSpan: 'unverifiable' as const,
          };
          evidenceFindings.push({
            proposalId: proposal.proposalId,
            interpretationIndex,
            artifactId,
            status: 'invalid',
            checks,
            diagnostics: [
              ambiguousIdentity ? 'evidence_artifact_identity_ambiguous' : 'evidence_artifact_unresolved',
            ],
          });
          proposalHasInvalidEvidence = true;
          return;
        }

        const evidenceRef = proposal.evidence.find((reference) => reference.artifactId === artifactId);
        const checks = {
          artifact: 'match' as const,
          sourceDocument: requiredClaimMatch(evidenceRef?.sourceDocumentId, artifact.sourceDocumentId),
          sourceArtifact: requiredClaimMatch(evidenceRef?.sourceArtifactId, artifact.sourceArtifactId),
          extractionSnapshot: artifact.extractionSnapshotId === rawInput.expectedExtractionSnapshotId
            ? 'match' as const : 'mismatch' as const,
          pageArtifact: claimedMatch(evidenceRef?.pageArtifactId ?? null, artifact.pageArtifactId),
          physicalPage: claimedMatch(evidenceRef?.physicalPageNumber ?? null, artifact.physicalPageNumber),
          artifactLocalIndex: claimedMatch(evidenceRef?.artifactLocalIndex ?? null, artifact.artifactLocalIndex),
          sourceLayer: claimedMatch(evidenceRef?.sourceLayer ?? null, artifact.sourceLayer),
          geometry: evidenceRef?.boundingBox == null
            ? 'not_claimed' as const
            : artifact.boundingBox == null
              ? 'unverifiable' as const
              : sameGeometry(evidenceRef.boundingBox, artifact.boundingBox)
                ? 'match' as const : 'mismatch' as const,
          rawSpan: evidenceRef?.rawSpan == null
            ? 'not_claimed' as const
            : artifact.rawText == null
              ? 'unverifiable' as const
              : artifact.rawText.includes(evidenceRef.rawSpan)
                ? 'match' as const : 'mismatch' as const,
        };
        const status = findingStatus(Object.values(checks));
        if (status === 'invalid') proposalHasInvalidEvidence = true;
        const diagnostics = Object.entries(checks)
          .filter(([, value]) => value === 'mismatch' || value === 'unverifiable')
          .map(([name, value]) => `evidence_${name}_${value}`)
          .sort();
        evidenceFindings.push({
          proposalId: proposal.proposalId,
          interpretationIndex,
          artifactId,
          status,
          checks,
          diagnostics,
        });
      });
    });

    if (proposalHasInvalidEvidence) {
      silentHallucinationCount += 1;
      diagnosticCodes.add('silent_hallucination');
    }
  }

  evidenceFindings.sort((left, right) => left.proposalId.localeCompare(right.proposalId)
    || left.interpretationIndex - right.interpretationIndex
    || left.artifactId.localeCompare(right.artifactId));
  for (const finding of evidenceFindings) for (const diagnostic of finding.diagnostics) {
    diagnosticCodes.add(diagnostic);
  }

  return {
    evaluationVersion: FORGEWING_PRICING_INTERPRETATION_EVALUATION_VERSION,
    authority: 'non_authoritative_measurement',
    corpusStatus: 'unmet',
    taskType: 'pricing_interpretation',
    runId: bundle.run.runId,
    extractionSnapshotId: bundle.run.extractionSnapshotId,
    summary: {
      comparisonStatus: notComparable ? 'not_comparable' : 'comparable',
      comparable: !notComparable,
      metricsEvaluated: !notComparable,
      diagnosticCodes: [...diagnosticCodes].sort(),
    },
    evidenceFindings,
    metrics: {
      proposalCount: bundle.proposals.length,
      abstentionCount: bundle.abstentions.length,
      runtimeAbstentionsByReason,
      insufficientEvidenceCount,
      valueBearingCount: notComparable ? 0 : bundle.proposals.length - insufficientEvidenceCount,
      ambiguousCount,
      conflictingCount,
      interpretationCount,
      byRole,
      confidenceBuckets,
      evidenceValidCount: evidenceFindings.filter((finding) => finding.status === 'valid').length,
      evidenceInvalidCount: evidenceFindings.filter((finding) => finding.status === 'invalid').length,
      evidenceUnverifiableCount: evidenceFindings.filter((finding) => finding.status === 'unverifiable').length,
      silentHallucinationCount,
      noValueManufactureViolationCount,
      snapshotMismatchCount,
      identityMismatchCount,
    },
  };
}
