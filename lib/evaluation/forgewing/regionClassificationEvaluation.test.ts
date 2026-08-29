import { describe, expect, it } from 'vitest';

import {
  adaptDeterministicRegionSnapshot,
  adaptFrozenRegionArtifacts,
  evaluateForgewingRegionClassification,
} from '@/lib/evaluation/forgewing/regionClassificationEvaluation';
import type { Step3InterpretationBridgeInput } from '@/lib/extraction/domain/step3InterpretationBridge';
import type {
  DeterministicRegionClassificationObservation,
  ForgewingRegionEvaluationInput,
  FrozenRegionArtifact,
} from '@/lib/evaluation/forgewing/types';
import { FORGEWING_REGION_EVALUATION_VERSION } from '@/lib/evaluation/forgewing/types';
import { FORGEWING_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import {
  ForgewingProposalBundleSchema,
  type ForgewingAbstentionReason,
  type ForgewingProposalState,
  type ForgewingRegionLabel,
} from '@/lib/forgewing/proposal/schema';

const box = {
  coordinateSpace: 'page_normalized' as const,
  origin: 'top_left' as const,
  x0: 0.1,
  y0: 0.2,
  x1: 0.8,
  y1: 0.9,
  rotation: 0 as const,
};

const identity = {
  organizationId: 'org-1',
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'source-1',
  extractionSnapshotId: 'snapshot-1',
  pageArtifactId: 'page-1',
  regionArtifactId: 'region-1',
  physicalPageNumber: 3,
  artifactLocalIndex: 2,
  sourceLayer: 'table_artifact',
} as const;

function baseline(state: 'resolved' | 'ambiguous' = 'resolved'):
DeterministicRegionClassificationObservation {
  return {
    identity,
    state,
    classification: state === 'resolved' ? 'table' : null,
    evidenceIds: ['region-1'],
    diagnostics: state === 'ambiguous' ? ['baseline_chain_ambiguous'] : [],
  };
}

function source(overrides: Partial<FrozenRegionArtifact> = {}): FrozenRegionArtifact {
  return {
    artifactId: 'region-1',
    kind: 'region',
    organizationId: 'org-1',
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    page: 1,
    boundingBox: box,
    rawText: 'Labor rate table',
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    sourceLayer: 'table_artifact',
    ...overrides,
  };
}

function proposalShape(params: Readonly<{
  state?: ForgewingProposalState;
  label?: ForgewingRegionLabel;
  confidence?: number | null;
  rawSpan?: string;
  evidenceArtifactId?: string;
}>) {
  const state = params.state ?? 'observed';
  const evidenceArtifactId = params.evidenceArtifactId ?? 'region-1';
  const reference = {
    artifactId: evidenceArtifactId,
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    pageArtifactId: 'page-1',
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    sourceLayer: 'table_artifact' as const,
    boundingBox: box,
    rawSpan: params.rawSpan ?? 'Labor rate',
  };
  const base = {
    proposalId: 'proposal-1',
    taskId: 'task-1',
    taskType: 'region_classification' as const,
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    extractionSnapshotId: 'snapshot-1',
    pageArtifactId: 'page-1',
    physicalPageNumber: 3,
    artifactLocalIndex: 2,
    confidence: params.confidence === undefined ? 0.8 : params.confidence,
  };
  if (state === 'insufficient_evidence') return {
    proposalId: base.proposalId,
    taskId: base.taskId,
    taskType: base.taskType,
    sourceDocumentId: base.sourceDocumentId,
    sourceArtifactId: base.sourceArtifactId,
    extractionSnapshotId: base.extractionSnapshotId,
    pageArtifactId: base.pageArtifactId,
    confidence: base.confidence,
    state,
    inputObservationIds: [],
    evidence: [],
    missingEvidence: [{ code: 'insufficient_table_context' as const }],
  };
  const refs = state === 'ambiguous' || state === 'conflicting'
    ? [reference, { ...reference, rawSpan: 'rate table' }]
    : [reference];
  return {
    ...base,
    state,
    inputObservationIds: [evidenceArtifactId],
    evidence: refs,
    ...(state === 'observed' || state === 'inferred'
      ? { value: { label: params.label ?? 'table' } } : {}),
  };
}

function input(params: Readonly<{
  baselineState?: 'resolved' | 'ambiguous' | 'absent';
  proposalState?: ForgewingProposalState;
  label?: ForgewingRegionLabel;
  confidence?: number | null;
  abstentionReason?: ForgewingAbstentionReason;
  baselineSnapshot?: string;
  sourceArtifacts?: readonly FrozenRegionArtifact[];
  rawSpan?: string;
  evidenceArtifactId?: string;
}> = {}): ForgewingRegionEvaluationInput {
  const abstention = params.abstentionReason ? [{
    taskId: 'task-1',
    taskType: 'region_classification' as const,
    sourceDocumentId: 'document-1',
    sourceArtifactId: 'source-1',
    extractionSnapshotId: 'snapshot-1',
    inputObservationIds: ['region-1'],
    reason: params.abstentionReason,
  }] : [];
  const proposals = abstention.length > 0 ? [] : [proposalShape({
    state: params.proposalState,
    label: params.label,
    confidence: params.confidence,
    rawSpan: params.rawSpan,
    evidenceArtifactId: params.evidenceArtifactId,
  })];
  return {
    deterministicSnapshot: {
      extractionSnapshotId: params.baselineSnapshot ?? 'snapshot-1',
      observations: params.baselineState === 'absent' ? [] : [baseline(params.baselineState)],
    },
    forgewingBundle: ForgewingProposalBundleSchema.parse({
      schemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
      authority: 'non_authoritative',
      run: {
        runId: 'run-1',
        organizationId: 'org-1',
        extractionSnapshotId: 'snapshot-1',
        inputSnapshotHash: 'a'.repeat(64),
      },
      taskId: 'task-1',
      taskType: 'region_classification',
      proposals,
      abstentions: abstention,
    }),
    sourceArtifacts: params.sourceArtifacts ?? [source()],
    runtimeMetadata: {
      model: 'shadow-model',
      promptTemplateId: 'region-prompt',
      promptTemplateVersion: '1',
    },
  };
}

describe('Forgewing region classification evaluation', () => {
  it('adapts only the table semantics actually proven by frozen Step 3 input', () => {
    const segment = {
      id: 'region-1',
      kind: 'region',
      region_role: 'table',
      organization_id: 'org-1',
      source_document_id: 'document-1',
      source_artifact_id: 'source-1',
      page_artifact_id: 'page-1',
      page: 1,
      bounding_box: {
        coordinate_space: 'page_normalized',
        origin: 'top_left',
        x0: 0.1,
        y0: 0.2,
        x1: 0.8,
        y1: 0.9,
        rotation: 0,
      },
      raw_text: 'Labor rate table',
    };
    const bridgeInput = {
      extraction_snapshot_id: 'snapshot-1',
      segments: [segment],
      cells: [],
      chains: [{ segment_ids: ['region-1'], completeness: 'ambiguous' }],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as unknown as Step3InterpretationBridgeInput;
    expect(adaptDeterministicRegionSnapshot(bridgeInput).observations[0]).toMatchObject({
      state: 'ambiguous',
      classification: null,
      diagnostics: ['baseline_chain_ambiguous'],
    });
    expect(adaptDeterministicRegionSnapshot({
      ...bridgeInput,
      chains: [{ ...bridgeInput.chains[0]!, completeness: 'complete' }],
    }).observations[0]).toMatchObject({ state: 'resolved', classification: 'table' });
    expect(adaptFrozenRegionArtifacts(bridgeInput)[0]).toMatchObject({
      artifactId: 'region-1',
      kind: 'region',
      rawText: 'Labor rate table',
      physicalPageNumber: null,
    });
  });

  it.each([
    ['table/table', input(), 'agreement'],
    ['table/prose', input({ label: 'prose', confidence: 1 }), 'disagreement'],
    ['baseline ambiguous/Forgewing table', input({ baselineState: 'ambiguous' }), 'baseline_ambiguous'],
    ['table/Forgewing ambiguous', input({ proposalState: 'ambiguous' }), 'forgewing_ambiguous'],
    ['both ambiguous', input({ baselineState: 'ambiguous', proposalState: 'ambiguous' }), 'both_ambiguous'],
    ['runtime abstention', input({ abstentionReason: 'runtime_unavailable' }), 'baseline_only'],
    ['semantic insufficient evidence', input({ proposalState: 'insufficient_evidence' }), 'forgewing_ambiguous'],
    ['snapshot mismatch', input({ baselineSnapshot: 'snapshot-2' }), 'not_comparable'],
  ])('classifies %s without choosing a winner', (_name, evaluationInput, expected) => {
    const report = evaluateForgewingRegionClassification(evaluationInput);
    expect(report.comparisons[0]?.comparisonStatus).toBe(expected);
  });

  it('flags baseline ambiguity plus a resolved, fully supported proposal as candidate improvement', () => {
    const report = evaluateForgewingRegionClassification(input({ baselineState: 'ambiguous' }));
    expect(report.comparisons[0]).toMatchObject({
      comparisonStatus: 'baseline_ambiguous',
      candidateImprovement: true,
    });
    expect(report.summary.diagnosticCodes).toContain('candidate_improvement');
  });

  it('keeps confidence descriptive and never turns a disagreement into authority', () => {
    const high = evaluateForgewingRegionClassification(input({ label: 'prose', confidence: 1 }));
    const low = evaluateForgewingRegionClassification(input({ label: 'prose', confidence: 0.1 }));
    expect(high.comparisons[0]?.comparisonStatus).toBe('disagreement');
    expect(low.comparisons[0]?.comparisonStatus).toBe('disagreement');
    expect(high.metrics.confidenceBuckets['0.8-1.0'].disagreementCount).toBe(1);
    expect(low.metrics.confidenceBuckets['0.0-0.2'].disagreementCount).toBe(1);
  });

  it.each([
    ['unknown artifact', input({ evidenceArtifactId: 'unknown-region' })],
    ['raw-span mismatch', input({ rawSpan: 'Invented source span' })],
    ['foreign source artifact', input({ sourceArtifacts: [source({ sourceArtifactId: 'source-foreign' })] })],
    ['geometry mismatch', input({ sourceArtifacts: [source({ boundingBox: { ...box, y1: 0.7 } })] })],
  ])('counts value-bearing %s as one silent hallucination', (_name, evaluationInput) => {
    const report = evaluateForgewingRegionClassification(evaluationInput);
    expect(report.metrics.evidenceInvalidCount).toBe(1);
    expect(report.metrics.silentHallucinationCount).toBe(1);
    expect(report.summary.diagnosticCodes).toContain('silent_hallucination');
  });

  it('keeps unverifiable spans separate from invalid evidence and hallucination', () => {
    const report = evaluateForgewingRegionClassification(input({
      sourceArtifacts: [source({ rawText: null })],
    }));
    expect(report.metrics).toMatchObject({
      evidenceUnverifiableCount: 1,
      evidenceInvalidCount: 0,
      silentHallucinationCount: 0,
    });
  });

  it('does not count semantic insufficiency or runtime abstention as hallucination', () => {
    const insufficient = evaluateForgewingRegionClassification(input({ proposalState: 'insufficient_evidence' }));
    const abstention = evaluateForgewingRegionClassification(input({ abstentionReason: 'budget_unavailable' }));
    expect(insufficient.metrics).toMatchObject({
      semanticInsufficientEvidenceCount: 1,
      abstentionCount: 0,
      silentHallucinationCount: 0,
    });
    expect(abstention.metrics).toMatchObject({
      semanticInsufficientEvidenceCount: 0,
      abstentionCount: 1,
      silentHallucinationCount: 0,
    });
  });

  it('reports missing baseline as Forgewing-only using source region identity', () => {
    expect(evaluateForgewingRegionClassification(input({ baselineState: 'absent' })).comparisons[0])
      .toMatchObject({ comparisonStatus: 'forgewing_only', identity: { regionArtifactId: 'region-1' } });
  });

  it('fails closed when neither baseline nor frozen source can establish region identity', () => {
    expect(evaluateForgewingRegionClassification(input({
      baselineState: 'absent',
      sourceArtifacts: [],
      evidenceArtifactId: 'unknown-region',
    })).comparisons[0]).toMatchObject({
      comparisonStatus: 'not_comparable',
      identity: null,
      diagnostics: expect.arrayContaining(['region_identity_unresolved']),
    });
  });

  it('does not choose a region by frozen artifact array order', () => {
    const secondRegion = source({ artifactId: 'region-2' });
    const evaluationInput = input({ baselineState: 'absent' });
    const proposal = {
      ...evaluationInput.forgewingBundle.proposals[0]!,
      inputObservationIds: ['region-1', 'region-2'],
    };
    const forgewingBundle = ForgewingProposalBundleSchema.parse({
      ...evaluationInput.forgewingBundle,
      proposals: [proposal],
    });
    for (const sourceArtifacts of [[source(), secondRegion], [secondRegion, source()]]) {
      expect(evaluateForgewingRegionClassification({
        ...evaluationInput,
        forgewingBundle,
        sourceArtifacts,
      }).comparisons[0]).toMatchObject({
        comparisonStatus: 'not_comparable',
        identity: null,
        diagnostics: expect.arrayContaining(['region_identity_ambiguous']),
      });
    }
  });

  it('is deterministic and returns stable report ordering and metadata', () => {
    const evaluationInput = input();
    const first = evaluateForgewingRegionClassification(evaluationInput);
    const second = evaluateForgewingRegionClassification(evaluationInput);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      evaluationVersion: FORGEWING_REGION_EVALUATION_VERSION,
      authority: 'non_authoritative_measurement',
      metadata: {
        model: 'shadow-model',
        promptTemplateId: 'region-prompt',
        promptTemplateVersion: '1',
        proposalSchemaVersion: FORGEWING_PROPOSAL_SCHEMA_VERSION,
      },
    });
  });

  it('does not use proposal IDs as the region comparison join', () => {
    const evaluationInput = input();
    const duplicatedIdBundle = ForgewingProposalBundleSchema.parse({
      ...evaluationInput.forgewingBundle,
      proposals: [
        evaluationInput.forgewingBundle.proposals[0],
        evaluationInput.forgewingBundle.proposals[0],
      ],
    });
    const report = evaluateForgewingRegionClassification({
      ...evaluationInput,
      forgewingBundle: duplicatedIdBundle,
    });
    expect(report.metrics).toMatchObject({ agreementCount: 2, evidenceValidCount: 2 });
  });
});
