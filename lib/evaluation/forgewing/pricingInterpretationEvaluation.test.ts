/**
 * SYNTHETIC FIXTURES ONLY — these tests exercise harness mechanics
 * (determinism, evidence fidelity, snapshot matching, abstention handling,
 * failure modes). They are not corpus evidence and prove nothing about
 * pricing-interpretation quality, accuracy, or promotion readiness. The
 * Golden/TDOT/MDOT corpus remains UNMET.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateForgewingPricingInterpretation,
  type FrozenPricingArtifact,
} from '@/lib/evaluation/forgewing/pricingInterpretationEvaluation';
import type { ForgewingPricingInterpretationProposalBundle } from '@/lib/forgewing/proposal/schema';

const box = {
  coordinateSpace: 'page_normalized' as const,
  origin: 'top_left' as const,
  x0: 0, y0: 0, x1: 0.5, y1: 0.1,
  rotation: 0 as const,
};

const rowArtifact: FrozenPricingArtifact = {
  artifactId: 'row-1',
  organizationId: 'org-1',
  sourceDocumentId: 'doc-1',
  sourceArtifactId: 'art-1',
  extractionSnapshotId: 'snap-1',
  pageArtifactId: 'page-1',
  physicalPageNumber: 3,
  artifactLocalIndex: 0,
  sourceLayer: 'pdf_native_text',
  boundingBox: box,
  rawText: 'row text',
};

const cellArtifact: FrozenPricingArtifact = {
  artifactId: 'cell-1',
  organizationId: 'org-1',
  sourceDocumentId: 'doc-1',
  sourceArtifactId: 'art-1',
  extractionSnapshotId: 'snap-1',
  pageArtifactId: 'page-1',
  physicalPageNumber: 3,
  artifactLocalIndex: 1,
  sourceLayer: 'pdf_native_text',
  boundingBox: box,
  rawText: '$12.50 per ton',
};

function baseBundle(overrides: Partial<{
  evidenceArtifactId: string;
  rawSpan: string;
  boundingBox: typeof box;
  physicalPageNumber: number;
}> = {}): ForgewingPricingInterpretationProposalBundle {
  return {
    schemaVersion: 'forgewing-pricing-interpretation-proposal-v1',
    authority: 'non_authoritative',
    run: {
      runId: 'forgewing-run-pricing-interpretation-abc',
      organizationId: 'org-1',
      extractionSnapshotId: 'snap-1',
      inputSnapshotHash: 'a'.repeat(64),
    },
    taskId: 'forgewing-task-pricing-interpretation-abc',
    taskType: 'pricing_interpretation',
    proposals: [{
      proposalId: 'forgewing-proposal-pricing-interpretation-abc',
      taskId: 'forgewing-task-pricing-interpretation-abc',
      taskType: 'pricing_interpretation',
      sourceDocumentId: 'doc-1',
      sourceArtifactId: 'art-1',
      extractionSnapshotId: 'snap-1',
      rowObservationId: 'row-1',
      pageArtifactId: 'page-1',
      physicalPageNumber: overrides.physicalPageNumber ?? 3,
      artifactLocalIndex: 0,
      sourceLayer: 'pdf_native_text',
      pricingScopeKind: 'authoritative',
      pricingEligibility: 'canonical_eligible',
      pricingEligibilityReason: 'authoritative_scope_match',
      pricingScopeIdentity: 'b'.repeat(64),
      inputObservationIds: ['row-1', overrides.evidenceArtifactId ?? 'cell-1'],
      state: 'observed',
      rowInterpretationState: 'observed',
      confidence: 0.8,
      interpretations: [{
        sourceCellId: overrides.evidenceArtifactId ?? 'cell-1',
        semanticRole: 'rate_like_amount',
        sourceText: '$12.50',
        interpretationState: 'observed',
        confidence: 0.8,
        evidenceArtifactIds: [overrides.evidenceArtifactId ?? 'cell-1'],
        rationaleCodes: ['numeric_structure'],
      }],
      evidence: [{
        artifactId: overrides.evidenceArtifactId ?? 'cell-1',
        sourceDocumentId: 'doc-1',
        sourceArtifactId: 'art-1',
        pageArtifactId: 'page-1',
        physicalPageNumber: overrides.physicalPageNumber ?? 3,
        sourceLayer: 'pdf_native_text',
        boundingBox: overrides.boundingBox ?? box,
        rawSpan: overrides.rawSpan ?? '$12.50 per ton',
      }],
    }],
    abstentions: [],
  } as unknown as ForgewingPricingInterpretationProposalBundle;
}

describe('SYNTHETIC: evaluateForgewingPricingInterpretation evidence fidelity', () => {
  it('marks evidence valid when claims match the frozen artifact exactly', () => {
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle(),
      sourceArtifacts: [rowArtifact, cellArtifact],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.evidenceValidCount).toBe(1);
    expect(report.metrics.evidenceInvalidCount).toBe(0);
    expect(report.metrics.silentHallucinationCount).toBe(0);
    expect(report.corpusStatus).toBe('unmet');
  });

  it('marks evidence invalid and counts a silent hallucination when the cited artifact is unresolved', () => {
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle({ evidenceArtifactId: 'cell-does-not-exist' }),
      sourceArtifacts: [rowArtifact, cellArtifact],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.evidenceInvalidCount).toBe(1);
    expect(report.metrics.silentHallucinationCount).toBe(1);
    expect(report.summary.diagnosticCodes).toContain('silent_hallucination');
  });

  it('marks evidence invalid when claimed geometry contradicts the frozen artifact', () => {
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle({ boundingBox: { ...box, x0: 0.9, x1: 0.99 } }),
      sourceArtifacts: [rowArtifact, cellArtifact],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.evidenceInvalidCount).toBe(1);
    expect(report.metrics.silentHallucinationCount).toBe(1);
  });

  it('marks evidence unverifiable, not invalid, when the frozen artifact has no recorded raw text', () => {
    const cellWithoutText: FrozenPricingArtifact = { ...cellArtifact, rawText: null };
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle(),
      sourceArtifacts: [rowArtifact, cellWithoutText],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.evidenceUnverifiableCount).toBe(1);
    expect(report.metrics.evidenceInvalidCount).toBe(0);
    expect(report.metrics.silentHallucinationCount).toBe(0);
  });

  it('fails closed on duplicate frozen artifact identity', () => {
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle(),
      sourceArtifacts: [rowArtifact, cellArtifact, { ...cellArtifact }],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.evidenceInvalidCount).toBe(1);
    expect(report.evidenceFindings[0]?.diagnostics).toContain('evidence_artifact_identity_ambiguous');
  });
});

describe('SYNTHETIC: evaluateForgewingPricingInterpretation snapshot coherence', () => {
  it('flags a bundle/artifact extraction-snapshot mismatch without crashing', () => {
    const report = evaluateForgewingPricingInterpretation({
      bundle: baseBundle(),
      sourceArtifacts: [rowArtifact, cellArtifact],
      expectedExtractionSnapshotId: 'snap-DIFFERENT',
    });
    expect(report.summary.diagnosticCodes).toContain('extraction_snapshot_mismatch');
  });
});

describe('SYNTHETIC: evaluateForgewingPricingInterpretation abstention handling', () => {
  it('tallies runtime abstention reasons and reports zero interpretations', () => {
    const abstained: ForgewingPricingInterpretationProposalBundle = {
      schemaVersion: 'forgewing-pricing-interpretation-proposal-v1',
      authority: 'non_authoritative',
      run: {
        runId: 'forgewing-run-pricing-interpretation-xyz',
        organizationId: 'org-1',
        extractionSnapshotId: 'snap-1',
        inputSnapshotHash: 'c'.repeat(64),
      },
      taskId: 'forgewing-task-pricing-interpretation-xyz',
      taskType: 'pricing_interpretation',
      proposals: [],
      abstentions: [{
        taskId: 'forgewing-task-pricing-interpretation-xyz',
        taskType: 'pricing_interpretation',
        sourceDocumentId: 'doc-1',
        sourceArtifactId: 'art-1',
        extractionSnapshotId: 'snap-1',
        inputObservationIds: ['row-1', 'cell-1'],
        reason: 'runtime_unavailable',
        detail: 'provider_timeout',
      }],
    } as unknown as ForgewingPricingInterpretationProposalBundle;

    const report = evaluateForgewingPricingInterpretation({
      bundle: abstained,
      sourceArtifacts: [rowArtifact, cellArtifact],
      expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report.metrics.abstentionCount).toBe(1);
    expect(report.metrics.runtimeAbstentionsByReason.runtime_unavailable).toBe(1);
    expect(report.metrics.proposalCount).toBe(0);
    expect(report.metrics.interpretationCount).toBe(0);
    expect(report.metrics.evidenceValidCount).toBe(0);
  });
});

describe('SYNTHETIC: evaluateForgewingPricingInterpretation determinism', () => {
  it('produces byte-identical reports regardless of source-artifact array order', () => {
    const order1 = [rowArtifact, cellArtifact];
    const order2 = [cellArtifact, rowArtifact];
    const bundle = baseBundle();
    const report1 = evaluateForgewingPricingInterpretation({
      bundle, sourceArtifacts: order1, expectedExtractionSnapshotId: 'snap-1',
    });
    const report2 = evaluateForgewingPricingInterpretation({
      bundle, sourceArtifacts: order2, expectedExtractionSnapshotId: 'snap-1',
    });
    expect(report1).toEqual(report2);
  });
});
