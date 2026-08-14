import type { Step3InterpretationBridgeInput } from '@/lib/extraction/domain/step3InterpretationBridge';
import type { GridCellArtifact, TableSegmentArtifact } from '@/lib/extraction/domain/types';
import { isResolvedPhysicalPage } from '@/lib/extraction/provenance/physicalPageCoordinate';
import { evaluateProposalEvidence } from '@/lib/evaluation/forgewing/evidenceFidelity';
import {
  FORGEWING_REGION_EVALUATION_VERSION,
  type ConfidenceBucket,
  type ConfidenceBucketMetrics,
  type DeterministicRegionClassificationObservation,
  type DeterministicRegionSnapshot,
  type EvidenceFidelityFinding,
  type FrozenRegionArtifact,
  type ForgewingRegionEvaluationInput,
  type ForgewingRegionEvaluationReport,
  type RegionComparisonStatus,
  type RegionEvaluationComparison,
  type RegionEvaluationIdentity,
} from '@/lib/evaluation/forgewing/types';
import {
  ForgewingProposalBundleSchema,
  type ForgewingAbstention,
  type ForgewingAbstentionReason,
  type ForgewingProposal,
  type ForgewingRegionLabel,
} from '@/lib/forgewing/proposal/schema';

const CONFIDENCE_BUCKETS: readonly ConfidenceBucket[] = [
  '0.0-0.2',
  '0.2-0.4',
  '0.4-0.6',
  '0.6-0.8',
  '0.8-1.0',
  'null',
];

const REGION_LABELS: readonly ForgewingRegionLabel[] = [
  'table',
  'prose',
  'header',
  'footnote',
  'rate_schedule',
  'continuation',
  'signature_block',
  'unknown',
];

const ABSTENTION_REASONS: readonly ForgewingAbstentionReason[] = [
  'unsupported_input',
  'input_contract_violation',
  'budget_unavailable',
  'runtime_unavailable',
  'task_not_supported',
];

function mapBox(artifact: TableSegmentArtifact | GridCellArtifact): FrozenRegionArtifact['boundingBox'] {
  return {
    coordinateSpace: artifact.bounding_box.coordinate_space,
    origin: artifact.bounding_box.origin,
    x0: artifact.bounding_box.x0,
    y0: artifact.bounding_box.y0,
    x1: artifact.bounding_box.x1,
    y1: artifact.bounding_box.y1,
    rotation: artifact.bounding_box.rotation,
  };
}

function physicalFields(artifact: TableSegmentArtifact | GridCellArtifact): Readonly<{
  physicalPageNumber: number | null;
  artifactLocalIndex: number | null;
  sourceLayer: string | null;
}> {
  const coordinate = artifact.physical_page_coordinate;
  return coordinate && isResolvedPhysicalPage(coordinate)
    ? {
        physicalPageNumber: coordinate.physicalPageNumber,
        artifactLocalIndex: coordinate.artifactLocalIndex,
        sourceLayer: coordinate.sourceLayer,
      }
    : { physicalPageNumber: null, artifactLocalIndex: null, sourceLayer: null };
}

function frozenArtifact(
  artifact: TableSegmentArtifact | GridCellArtifact,
  extractionSnapshotId: string,
): FrozenRegionArtifact {
  return {
    artifactId: artifact.id,
    kind: artifact.kind === 'region' ? 'region' : 'cell',
    organizationId: artifact.organization_id,
    sourceDocumentId: artifact.source_document_id,
    sourceArtifactId: artifact.source_artifact_id,
    extractionSnapshotId,
    pageArtifactId: artifact.page_artifact_id,
    page: artifact.page,
    boundingBox: mapBox(artifact),
    rawText: artifact.raw_text,
    ...physicalFields(artifact),
  };
}

/**
 * Builds the neutral source set from the exact Step 3 input. It does not read a
 * newer extraction, query storage, or expose Step 3 output to Forgewing.
 */
export function adaptFrozenRegionArtifacts(
  input: Step3InterpretationBridgeInput,
): readonly FrozenRegionArtifact[] {
  return [...input.segments, ...input.cells]
    .map((artifact) => frozenArtifact(artifact, input.extraction_snapshot_id))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

/**
 * Step 3's frozen bridge input proves table segments only. No aliases are made
 * for prose/header/footnote/rate-schedule/continuation/signature/unknown.
 */
export function adaptDeterministicRegionSnapshot(
  input: Step3InterpretationBridgeInput,
): DeterministicRegionSnapshot {
  const ambiguousSegments = new Set(
    input.chains
      .filter((chain) => chain.completeness === 'ambiguous')
      .flatMap((chain) => chain.segment_ids),
  );
  const observations = input.segments.map((segment): DeterministicRegionClassificationObservation => {
    const physical = physicalFields(segment);
    const ambiguous = ambiguousSegments.has(segment.id);
    return {
      identity: {
        organizationId: segment.organization_id,
        sourceDocumentId: segment.source_document_id,
        sourceArtifactId: segment.source_artifact_id,
        extractionSnapshotId: input.extraction_snapshot_id,
        pageArtifactId: segment.page_artifact_id,
        regionArtifactId: segment.id,
        ...physical,
      },
      state: ambiguous ? 'ambiguous' : 'resolved',
      classification: ambiguous ? null : 'table',
      evidenceIds: [segment.id],
      diagnostics: ambiguous ? ['baseline_chain_ambiguous'] : [],
    };
  });
  return {
    extractionSnapshotId: input.extraction_snapshot_id,
    observations: observations.sort((left, right) => identityKey(left.identity)
      .localeCompare(identityKey(right.identity))),
  };
}

function identityKey(identity: RegionEvaluationIdentity): string {
  return [
    identity.organizationId,
    identity.sourceDocumentId,
    identity.sourceArtifactId,
    identity.extractionSnapshotId,
    identity.pageArtifactId,
    identity.regionArtifactId,
    identity.physicalPageNumber ?? '',
    identity.artifactLocalIndex ?? '',
    identity.sourceLayer ?? '',
  ].join('\u001f');
}

function forgewingIsAmbiguous(proposal: ForgewingProposal): boolean {
  return proposal.state === 'ambiguous'
    || proposal.state === 'unresolved'
    || proposal.state === 'conflicting'
    || proposal.state === 'insufficient_evidence';
}

function forgewingLabel(proposal: ForgewingProposal): ForgewingRegionLabel | null {
  return proposal.state === 'observed' || proposal.state === 'inferred'
    ? proposal.value.label
    : null;
}

function resolveBaseline(params: Readonly<{
  observations: readonly DeterministicRegionClassificationObservation[];
  sourceArtifacts: readonly FrozenRegionArtifact[];
  sourceDocumentId: string;
  sourceArtifactId: string;
  pageArtifactId?: string;
  inputObservationIds: readonly string[];
}>): Readonly<{
  observation: DeterministicRegionClassificationObservation | null;
  identity: RegionEvaluationIdentity | null;
  diagnostics: readonly string[];
}> {
  const inputIds = new Set(params.inputObservationIds);
  const exact = params.observations.filter((item) => inputIds.has(item.identity.regionArtifactId));
  const contextual = params.observations.filter((item) =>
    item.identity.sourceDocumentId === params.sourceDocumentId
    && item.identity.sourceArtifactId === params.sourceArtifactId
    && (params.pageArtifactId == null || item.identity.pageArtifactId === params.pageArtifactId));
  const candidates = exact.length > 0 ? exact : contextual;
  if (candidates.length === 1) {
    return { observation: candidates[0]!, identity: candidates[0]!.identity, diagnostics: [] };
  }
  if (candidates.length > 1) {
    return { observation: null, identity: null, diagnostics: ['region_identity_ambiguous'] };
  }
  const artifacts = params.sourceArtifacts.filter((item) =>
    item.kind === 'region'
    && inputIds.has(item.artifactId)
    && item.sourceDocumentId === params.sourceDocumentId
    && item.sourceArtifactId === params.sourceArtifactId
    && (params.pageArtifactId == null || item.pageArtifactId === params.pageArtifactId));
  const artifact = artifacts.length === 1 ? artifacts[0]! : null;
  if (artifacts.length > 1) {
    return { observation: null, identity: null, diagnostics: ['region_identity_ambiguous'] };
  }
  return artifact
    ? {
        observation: null,
        identity: {
          organizationId: artifact.organizationId,
          sourceDocumentId: artifact.sourceDocumentId,
          sourceArtifactId: artifact.sourceArtifactId,
          extractionSnapshotId: artifact.extractionSnapshotId,
          pageArtifactId: artifact.pageArtifactId,
          regionArtifactId: artifact.artifactId,
          physicalPageNumber: artifact.physicalPageNumber,
          artifactLocalIndex: artifact.artifactLocalIndex,
          sourceLayer: artifact.sourceLayer,
        },
        diagnostics: ['baseline_observation_absent'],
      }
    : { observation: null, identity: null, diagnostics: ['region_identity_unresolved'] };
}

function statusFor(
  baseline: DeterministicRegionClassificationObservation | null,
  proposal: ForgewingProposal | null,
  abstention: ForgewingAbstention | null,
  notComparable: boolean,
): RegionComparisonStatus {
  if (notComparable) return 'not_comparable';
  if (abstention) return baseline ? 'baseline_only' : 'not_comparable';
  if (!proposal) return baseline ? 'baseline_only' : 'not_comparable';
  if (!baseline) return forgewingLabel(proposal) != null ? 'forgewing_only' : 'not_comparable';
  const baselineAmbiguous = baseline.state === 'ambiguous';
  const proposalAmbiguous = forgewingIsAmbiguous(proposal);
  if (baselineAmbiguous && proposalAmbiguous) return 'both_ambiguous';
  if (baselineAmbiguous) return 'baseline_ambiguous';
  if (proposalAmbiguous) return 'forgewing_ambiguous';
  return baseline.classification === forgewingLabel(proposal) ? 'agreement' : 'disagreement';
}

function comparisonForProposal(params: Readonly<{
  input: ForgewingRegionEvaluationInput;
  proposal: ForgewingProposal;
  findings: readonly EvidenceFidelityFinding[];
  snapshotMismatch: boolean;
}>): RegionEvaluationComparison {
  const resolved = resolveBaseline({
    observations: params.input.deterministicSnapshot.observations,
    sourceArtifacts: params.input.sourceArtifacts,
    sourceDocumentId: params.proposal.sourceDocumentId,
    sourceArtifactId: params.proposal.sourceArtifactId,
    pageArtifactId: params.proposal.pageArtifactId,
    inputObservationIds: params.proposal.inputObservationIds,
  });
  const diagnostics = [
    ...resolved.diagnostics,
    ...(params.snapshotMismatch ? ['extraction_snapshot_mismatch'] : []),
    ...(params.findings.some((finding) => finding.status === 'invalid')
      ? ['evidence_fidelity_failure'] : []),
  ];
  const notComparable = params.snapshotMismatch
    || resolved.diagnostics.includes('region_identity_ambiguous')
    || resolved.diagnostics.includes('region_identity_unresolved');
  const comparisonStatus = statusFor(resolved.observation, params.proposal, null, notComparable);
  if (comparisonStatus === 'disagreement') diagnostics.push('forgewing_baseline_disagreement');
  if (comparisonStatus === 'baseline_ambiguous') diagnostics.push('baseline_ambiguous_forgewing_resolved');
  if (comparisonStatus === 'forgewing_ambiguous') diagnostics.push('forgewing_ambiguous_baseline_resolved');
  const candidateImprovement = comparisonStatus === 'baseline_ambiguous'
    && params.findings.length > 0
    && params.findings.every((finding) => finding.status === 'valid');
  if (candidateImprovement) diagnostics.push('candidate_improvement');
  const label = forgewingLabel(params.proposal);
  const deltas = [
    ...(resolved.observation?.classification !== label
      ? [`classification:${resolved.observation?.classification ?? 'absent'}->${label ?? 'absent'}`] : []),
    ...(resolved.observation?.state === 'ambiguous' ? ['baseline:ambiguous'] : []),
    ...(forgewingIsAmbiguous(params.proposal) ? [`forgewing:${params.proposal.state}`] : []),
  ].sort();
  return {
    identity: resolved.identity,
    comparisonStatus,
    candidateImprovement,
    deterministic: {
      state: resolved.observation?.state ?? 'absent',
      classification: resolved.observation?.classification ?? null,
      evidenceIds: [...(resolved.observation?.evidenceIds ?? [])].sort(),
    },
    forgewing: {
      proposalId: params.proposal.proposalId,
      state: params.proposal.state,
      classification: label,
      confidence: params.proposal.confidence,
      evidence: [...params.proposal.evidence].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
      ...(params.proposal.rationale ? { rationale: params.proposal.rationale } : {}),
    },
    deltas,
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

function comparisonForAbstention(params: Readonly<{
  input: ForgewingRegionEvaluationInput;
  abstention: ForgewingAbstention;
  snapshotMismatch: boolean;
}>): RegionEvaluationComparison {
  const resolved = resolveBaseline({
    observations: params.input.deterministicSnapshot.observations,
    sourceArtifacts: params.input.sourceArtifacts,
    sourceDocumentId: params.abstention.sourceDocumentId,
    sourceArtifactId: params.abstention.sourceArtifactId,
    inputObservationIds: params.abstention.inputObservationIds,
  });
  const diagnostics = [
    ...resolved.diagnostics,
    'forgewing_runtime_abstention',
    ...(params.snapshotMismatch ? ['extraction_snapshot_mismatch'] : []),
  ].sort();
  return {
    identity: resolved.identity,
    comparisonStatus: statusFor(
      resolved.observation,
      null,
      params.abstention,
      params.snapshotMismatch
        || resolved.diagnostics.includes('region_identity_ambiguous')
        || resolved.diagnostics.includes('region_identity_unresolved'),
    ),
    candidateImprovement: false,
    deterministic: {
      state: resolved.observation?.state ?? 'absent',
      classification: resolved.observation?.classification ?? null,
      evidenceIds: [...(resolved.observation?.evidenceIds ?? [])].sort(),
    },
    forgewing: {
      proposalId: null,
      state: 'runtime_abstention',
      classification: null,
      confidence: null,
      evidence: [],
      abstentionReason: params.abstention.reason,
    },
    deltas: [`forgewing:runtime_abstention:${params.abstention.reason}`],
    diagnostics: [...new Set(diagnostics)].sort(),
  };
}

function confidenceBucket(confidence: number | null): ConfidenceBucket {
  if (confidence == null) return 'null';
  if (confidence < 0.2) return '0.0-0.2';
  if (confidence < 0.4) return '0.2-0.4';
  if (confidence < 0.6) return '0.4-0.6';
  if (confidence < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}

function emptyBucket(): ConfidenceBucketMetrics {
  return { total: 0, agreementCount: 0, disagreementCount: 0, notComparableCount: 0 };
}

export function evaluateForgewingRegionClassification(
  rawInput: ForgewingRegionEvaluationInput,
): ForgewingRegionEvaluationReport {
  const bundle = ForgewingProposalBundleSchema.parse(rawInput.forgewingBundle);
  const input: ForgewingRegionEvaluationInput = { ...rawInput, forgewingBundle: bundle };
  const snapshotMismatch = input.deterministicSnapshot.extractionSnapshotId
    !== bundle.run.extractionSnapshotId
    || input.sourceArtifacts.some((artifact) =>
      artifact.extractionSnapshotId !== bundle.run.extractionSnapshotId);
  const proposalEvaluations = bundle.proposals.map((proposal) => ({
    proposal,
    findings: evaluateProposalEvidence({
      proposal,
      expectedExtractionSnapshotId: bundle.run.extractionSnapshotId,
      sourceArtifacts: input.sourceArtifacts,
    }),
  }));
  const proposalComparisons = proposalEvaluations.map(({ proposal, findings }) =>
    comparisonForProposal({ input, proposal, findings, snapshotMismatch }));
  const comparisons = [
    ...proposalComparisons,
    ...bundle.abstentions.map((abstention) => comparisonForAbstention({
      input,
      abstention,
      snapshotMismatch,
    })),
  ].sort((left, right) => (left.identity ? identityKey(left.identity) : '\uffff')
    .localeCompare(right.identity ? identityKey(right.identity) : '\uffff')
    || (left.forgewing.proposalId ?? '').localeCompare(right.forgewing.proposalId ?? '')
    || (left.forgewing.abstentionReason ?? '').localeCompare(right.forgewing.abstentionReason ?? ''));
  const evidenceFindings = proposalEvaluations.flatMap(({ findings }) => findings)
    .sort((left, right) => left.proposalId.localeCompare(right.proposalId)
      || left.evidenceIndex - right.evidenceIndex
      || left.artifactId.localeCompare(right.artifactId));
  const confidenceBuckets = Object.fromEntries(
    CONFIDENCE_BUCKETS.map((bucket) => [bucket, emptyBucket()]),
  ) as Record<ConfidenceBucket, ConfidenceBucketMetrics>;
  const byClassification = Object.fromEntries(
    REGION_LABELS.map((label) => [label, 0]),
  ) as Record<ForgewingRegionLabel, number>;
  const runtimeAbstentionsByReason = Object.fromEntries(
    ABSTENTION_REASONS.map((reason) => [reason, 0]),
  ) as Record<ForgewingAbstentionReason, number>;
  bundle.abstentions.forEach((item) => { runtimeAbstentionsByReason[item.reason] += 1; });
  bundle.proposals.forEach((proposal, index) => {
    const label = forgewingLabel(proposal);
    if (label) byClassification[label] += 1;
    const bucket = confidenceBucket(proposal.confidence);
    const comparison = proposalComparisons[index];
    const current = confidenceBuckets[bucket];
    confidenceBuckets[bucket] = {
      total: current.total + 1,
      agreementCount: current.agreementCount + (comparison?.comparisonStatus === 'agreement' ? 1 : 0),
      disagreementCount: current.disagreementCount + (comparison?.comparisonStatus === 'disagreement' ? 1 : 0),
      notComparableCount: current.notComparableCount + (
        comparison?.comparisonStatus !== 'agreement'
        && comparison?.comparisonStatus !== 'disagreement' ? 1 : 0
      ),
    };
  });
  const agreementCount = comparisons.filter((item) => item.comparisonStatus === 'agreement').length;
  const disagreementCount = comparisons.filter((item) => item.comparisonStatus === 'disagreement').length;
  const totalComparable = agreementCount + disagreementCount;
  const valueBearingProposalIds = new Set(bundle.proposals
    .filter((proposal) => proposal.state === 'observed' || proposal.state === 'inferred')
    .map((proposal) => proposal.proposalId));
  const silentHallucinationCount = new Set(evidenceFindings
    .filter((finding) => finding.status === 'invalid' && valueBearingProposalIds.has(finding.proposalId))
    .map((finding) => finding.proposalId)).size;
  const diagnosticCodes = [...new Set([
    ...comparisons.flatMap((item) => item.diagnostics),
    ...evidenceFindings.flatMap((item) => item.diagnostics),
    ...(silentHallucinationCount > 0 ? ['silent_hallucination'] : []),
  ])].sort();
  return {
    evaluationVersion: FORGEWING_REGION_EVALUATION_VERSION,
    authority: 'non_authoritative_measurement',
    taskType: 'region_classification',
    runId: bundle.run.runId,
    extractionSnapshotId: bundle.run.extractionSnapshotId,
    metadata: {
      model: input.runtimeMetadata?.model ?? null,
      promptTemplateId: input.runtimeMetadata?.promptTemplateId ?? null,
      promptTemplateVersion: input.runtimeMetadata?.promptTemplateVersion ?? null,
      proposalSchemaVersion: bundle.schemaVersion,
    },
    summary: { comparisonCount: comparisons.length, diagnosticCodes },
    comparisons,
    evidenceFindings,
    metrics: {
      totalComparable,
      agreementCount,
      disagreementCount,
      agreementRate: totalComparable === 0 ? null : agreementCount / totalComparable,
      baselineAmbiguousCount: comparisons.filter((item) => item.comparisonStatus === 'baseline_ambiguous').length,
      forgewingAmbiguousCount: comparisons.filter((item) => item.comparisonStatus === 'forgewing_ambiguous').length,
      bothAmbiguousCount: comparisons.filter((item) => item.comparisonStatus === 'both_ambiguous').length,
      abstentionCount: bundle.abstentions.length,
      runtimeAbstentionsByReason,
      semanticInsufficientEvidenceCount: bundle.proposals
        .filter((proposal) => proposal.state === 'insufficient_evidence').length,
      successfulClassificationCount: bundle.proposals
        .filter((proposal) => proposal.state === 'observed' || proposal.state === 'inferred').length,
      evidenceValidCount: evidenceFindings.filter((finding) => finding.status === 'valid').length,
      evidenceInvalidCount: evidenceFindings.filter((finding) => finding.status === 'invalid').length,
      evidenceUnverifiableCount: evidenceFindings.filter((finding) => finding.status === 'unverifiable').length,
      silentHallucinationCount,
      byClassification,
      confidenceBuckets,
    },
  };
}
