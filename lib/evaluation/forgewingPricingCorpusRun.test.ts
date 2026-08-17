/**
 * REAL UNLABELLED SMOKE ONLY. These tests make no pricing correctness,
 * precision/recall, authority, or promotion claim.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveForgewingPricingCorpusAvailability,
  runForgewingPricingCorpus,
  runForgewingPricingCandidateAttempts,
  summarizeForgewingPricingCorpusAttempts,
  type ForgewingPricingCorpusEntry,
} from '@/scripts/evaluation/runForgewingPricingCorpus';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';

const GOODLETTSVILLE_ENTRY: ForgewingPricingCorpusEntry = {
  sourcePdfPath: 'lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf',
  corpusKind: 'real_unlabelled_smoke',
  documentType: 'price_sheet',
  authoritativeRatePageRanges: [{ start: 2, end: 2 }],
  metadata: { fixturePurpose: 'real-document evidence-fidelity smoke' },
};

const deterministicEvidenceProvider = async (request: { inputJson: string }) => {
  const input = JSON.parse(request.inputJson) as {
    rowObservation: { cells: Array<{ observationId: string; rawText: string }> };
  };
  const cell = input.rowObservation.cells[0]!;
  return JSON.stringify({
    rowInterpretationState: 'observed', confidence: 0.5,
    interpretations: [{
      sourceCellId: cell.observationId,
      semanticRole: 'unknown',
      sourceText: cell.rawText,
      interpretationState: 'observed',
      confidence: 0.5,
      evidenceIds: [cell.observationId],
      rationaleCodes: ['source_text_only'],
    }],
  });
};

function syntheticCandidate(rowObservationId: string): ForgewingPricingInterpretationInput {
  const cellId = `cell-${rowObservationId}`;
  return {
    organizationId: 'local-evaluation-organization', sourceDocumentId: 'document-1',
    sourceArtifactId: 'artifact-1', extractionSnapshotId: 'snapshot-1',
    pricingScope: {
      scopeKind: 'authoritative', eligibility: 'canonical_eligible',
      eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'a'.repeat(64),
    },
    rowObservation: {
      observationId: rowObservationId, rawText: 'Unresolved source text',
      deterministicState: 'unresolved', physicalPageNumber: 2,
      cells: [{
        observationId: cellId, rawText: 'Unresolved source text', columnIndex: 0,
        readingOrder: 0, sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
        physicalPageNumber: 2, sourceLayer: 'pdf_native_text',
      }],
    },
  };
}

describe('Forgewing pricing corpus availability', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps missing configuration, files, labels, and hash mismatches non-passing', () => {
    expect(resolveForgewingPricingCorpusAvailability({
      ...GOODLETTSVILLE_ENTRY, sourcePdfPath: '',
    }).status).toBe('missing_config');
    expect(resolveForgewingPricingCorpusAvailability({
      ...GOODLETTSVILLE_ENTRY, sourcePdfPath: 'missing-pricing-corpus.pdf',
    }).status).toBe('unavailable');
    expect(resolveForgewingPricingCorpusAvailability({
      ...GOODLETTSVILLE_ENTRY, corpusKind: 'labelled_external',
    }).status).toBe('missing_labels');
    expect(resolveForgewingPricingCorpusAvailability({
      ...GOODLETTSVILLE_ENTRY, expectedSourceSha256: '0'.repeat(64),
    }).status).toBe('hash_mismatch');
  });

  it.each(['OPENAI_API_KEY', 'UNSTRUCTURED_API_KEY'])
  ('refuses ambient %s credentials before reading the corpus', async (credential) => {
    vi.stubEnv(credential, 'must-not-be-used');
    await expect(runForgewingPricingCorpus(GOODLETTSVILLE_ENTRY, {
      task: { provider: deterministicEvidenceProvider },
    })).rejects.toThrow('forgewing_pricing_corpus_legacy_extraction_ai_must_be_disabled');
  });
});

describe('Forgewing Goodlettsville real-document pricing smoke', () => {
  it('iterates every supplied eligible candidate under offline control', async () => {
    const attempts = await runForgewingPricingCandidateAttempts(
      [syntheticCandidate('row-2'), syntheticCandidate('row-1')],
      {
        config: {
          enabled: true, model: 'injected-deterministic-evidence-smoke', timeoutMs: 30_000,
          maxCalls: 4, maxOutputTokens: 800,
        },
        taskEnabled: true,
        provider: deterministicEvidenceProvider,
      },
    );
    expect(attempts.map((attempt) => attempt.rowObservationId)).toEqual(['row-1', 'row-2']);
    expect(attempts.every((attempt) => attempt.resultStatus === 'applied')).toBe(true);
  });

  it('freezes the exact provider-bounded cells and rejects citations to truncated-away evidence', async () => {
    const base = syntheticCandidate('row-many');
    const candidate: ForgewingPricingInterpretationInput = {
      ...base,
      rowObservation: {
        ...base.rowObservation,
        cells: Array.from({ length: 17 }, (_, index) => ({
          ...base.rowObservation.cells[0]!,
          observationId: `cell-${String(index).padStart(2, '0')}`,
          readingOrder: index,
          rawText: `source cell ${index}`,
        })),
      },
    };
    const attempts = await runForgewingPricingCandidateAttempts([candidate], {
      config: {
        enabled: true, model: 'injected-truncation-test', timeoutMs: 30_000,
        maxCalls: 1, maxOutputTokens: 800,
      },
      taskEnabled: true,
      provider: async () => JSON.stringify({
        rowInterpretationState: 'observed', confidence: 0.5,
        interpretations: [{
          sourceCellId: 'cell-16', semanticRole: 'unknown', sourceText: 'source cell 16',
          interpretationState: 'observed', confidence: 0.5, evidenceIds: ['cell-16'],
          rationaleCodes: ['source_text_only'],
        }],
      }),
    });
    expect(attempts[0]).toMatchObject({
      resultStatus: 'abstained', warnings: ['input_truncated', 'unknown_evidence_reference'],
    });
    expect(attempts[0]?.evaluation?.evidenceFindings).toEqual([]);
    expect(summarizeForgewingPricingCorpusAttempts(1, attempts)).toMatchObject({
      providerRuntimeFailureCount: 0,
      modelOutputRejectionCount: 1,
    });
  });

  it('never evaluates unbounded source artifacts when the call budget is already exhausted', async () => {
    const base = syntheticCandidate('row-budget');
    const candidate = {
      ...base,
      rowObservation: {
        ...base.rowObservation,
        cells: Array.from({ length: 17 }, (_, index) => ({
          ...base.rowObservation.cells[0]!,
          observationId: `budget-cell-${index}`,
          readingOrder: index,
          rawText: `budget source ${index}`,
        })),
      },
    } satisfies ForgewingPricingInterpretationInput;
    const budget = new ForgewingCallBudget(1);
    expect(budget.tryConsume()).toBe(true);
    const provider = vi.fn(deterministicEvidenceProvider);
    const attempts = await runForgewingPricingCandidateAttempts([candidate], {
      config: {
        enabled: true, model: 'must-not-run', timeoutMs: 30_000,
        maxCalls: 4, maxOutputTokens: 800,
      },
      taskEnabled: true,
      budget,
      provider,
    });
    expect(provider).not.toHaveBeenCalled();
    expect(attempts[0]).toMatchObject({
      resultStatus: 'abstained', warnings: ['input_truncated', 'budget_exhausted'],
      evaluation: {
        summary: {
          comparisonStatus: 'not_comparable', metricsEvaluated: false,
          diagnosticCodes: ['frozen_observation_set_unavailable'],
        },
        evidenceFindings: [],
      },
    });
    expect(summarizeForgewingPricingCorpusAttempts(1, attempts)).toMatchObject({
      evaluatedCandidateCount: 0,
      nonComparableCandidateCount: 1,
    });
  });

  it('separates provider failures and excludes non-comparable semantic metrics', async () => {
    const providerFailure = await runForgewingPricingCandidateAttempts(
      [syntheticCandidate('row-provider-failure')],
      {
        config: {
          enabled: true, model: 'injected-provider-failure', timeoutMs: 30_000,
          maxCalls: 1, maxOutputTokens: 800,
        },
        taskEnabled: true,
        provider: async () => { throw new Error('provider unavailable'); },
      },
    );
    expect(summarizeForgewingPricingCorpusAttempts(1, providerFailure)).toMatchObject({
      providerRuntimeFailureCount: 1,
      modelOutputRejectionCount: 0,
    });

    const comparable = await runForgewingPricingCandidateAttempts(
      [syntheticCandidate('row-non-comparable')],
      {
        config: {
          enabled: true, model: 'injected-comparable', timeoutMs: 30_000,
          maxCalls: 1, maxOutputTokens: 800,
        },
        taskEnabled: true,
        provider: deterministicEvidenceProvider,
      },
    );
    const evaluation = comparable[0]?.evaluation;
    expect(evaluation).not.toBeNull();
    const nonComparable = [{
      ...comparable[0]!,
      evaluation: {
        ...evaluation!,
        summary: {
          ...evaluation!.summary,
          comparisonStatus: 'not_comparable' as const,
          comparable: false,
          metricsEvaluated: false,
        },
        metrics: {
          ...evaluation!.metrics,
          snapshotMismatchCount: 2,
          identityMismatchCount: 3,
        },
      },
    }];
    expect(summarizeForgewingPricingCorpusAttempts(1, nonComparable)).toMatchObject({
      evaluatedCandidateCount: 0,
      nonComparableCandidateCount: 1,
      evidenceValidCount: 0,
      noValueManufactureViolationCount: 0,
      snapshotMismatchCount: 2,
      identityMismatchCount: 3,
    });
  });

  it('extracts the real PDF, evaluates every eligible candidate, and retains unmet status', async () => {
    const report = await runForgewingPricingCorpus(GOODLETTSVILLE_ENTRY, {
      task: {
        config: {
          enabled: true, model: 'injected-deterministic-evidence-smoke', timeoutMs: 30_000,
          maxCalls: 4, maxOutputTokens: 800,
        },
        taskEnabled: true,
        provider: deterministicEvidenceProvider,
      },
    });

    expect(report).toMatchObject({
      authority: 'non_authoritative_measurement',
      corpusKind: 'real_unlabelled_smoke',
      corpusStatus: 'unmet',
      availability: 'available',
      pricingCorrectnessEvaluated: false,
      promotionEvidence: false,
      orderingDeterministic: true,
      runtime: {
        model: 'injected-deterministic-evidence-smoke',
        promptTemplateId: 'forgewing-pricing-interpretation',
        promptTemplateVersion: 'v1',
        proposalSchemaVersion: 'forgewing-pricing-interpretation-proposal-v1',
      },
    });
    expect(report.corpusIdentity).toMatch(/^generic\/local-fixture:[a-f0-9]{64}$/);
    expect(report.metrics.totalAttemptedProposals).toBe(report.metrics.totalEligibleCandidates);
    expect(report.metrics.evaluatedCandidateCount).toBe(report.metrics.totalEligibleCandidates);
    expect(report.metrics.appliedCount).toBe(report.metrics.totalEligibleCandidates);
    expect(report.metrics.abstentionCount).toBe(0);
    expect(report.smokeStatus).toBe(report.metrics.totalEligibleCandidates > 0
      ? 'completed' : 'completed_no_eligible_candidates');
    expect(report.metrics.evidenceValidCount).toBe(report.metrics.evaluatedCandidateCount);
    expect(report.metrics.evidenceInvalidCount).toBe(0);
    expect(report.metrics.evidenceUnverifiableCount).toBe(0);
    expect(report.metrics.silentHallucinationCount).toBe(0);
    expect(report.metrics.noValueManufactureViolationCount).toBe(0);
    expect(report.metrics.snapshotMismatchCount).toBe(0);
    expect(report.metrics.identityMismatchCount).toBe(0);
    expect(report.metrics.providerRuntimeFailureCount).toBe(0);
    expect(report.metrics.modelOutputRejectionCount).toBe(0);
    expect(report.metrics.nonComparableCandidateCount).toBe(0);
    expect(report.attempts.every((attempt) =>
      attempt.model === 'injected-deterministic-evidence-smoke'
      && attempt.promptTemplateId === 'forgewing-pricing-interpretation'
      && attempt.promptTemplateVersion === 'v1'
      && attempt.proposalSchemaVersion === 'forgewing-pricing-interpretation-proposal-v1'
      && attempt.inputSnapshotHash != null
      && attempt.taskId != null
      && attempt.runId != null)).toBe(true);
    const serialized = JSON.stringify(report);
    for (const prohibited of ['pricingAccuracy', 'precision', 'recall', 'F1',
      'promotionReadiness', 'rateCorrectness', 'unitCorrectness']) {
      expect(serialized).not.toContain(`"${prohibited}"`);
    }
  }, 180_000);
});
