import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentDecision } from '@/lib/types/decisions';

function detection(decisionType: string, source: DocumentDecision['source']): DocumentDecision {
  return {
    id: `${decisionType}-${source}`,
    document_id: 'doc-1',
    organization_id: 'org-1',
    decision_type: decisionType,
    decision_value: 'value',
    confidence: 0.8,
    source,
    created_at: '2026-10-13T00:00:00.000Z',
  } as DocumentDecision;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@/lib/server/heuristicDecisionEngine');
  vi.doUnmock('@/lib/server/decisionPersistence');
});

describe('heuristic decision pipeline: model-origin detections stay evidence', () => {
  it('persists and returns only deterministic detections', async () => {
    const persistDecisions = vi.fn(async () => ({ persisted: 1, errors: 0 }));
    const documentDecisionsToPersisted = vi.fn((decisions: DocumentDecision[]) =>
      decisions.map((decision) => ({ decision_type: decision.decision_type })));
    vi.doMock('@/lib/server/heuristicDecisionEngine', () => ({
      runDecisionEngine: vi.fn(async () => [
        detection('missing_invoice_number', 'deterministic'),
        detection('ai_classification', 'ai_enriched'),
        detection('eligibility_risk', 'ai_enriched'),
      ]),
    }));
    vi.doMock('@/lib/server/decisionPersistence', () => ({ persistDecisions, documentDecisionsToPersisted }));

    const { generateAndPersistDecisions } = await import('@/lib/pipeline/decisionEngine');
    const result = await generateAndPersistDecisions({
      admin: {} as never,
      documentId: 'doc-1',
      organizationId: 'org-1',
      documentType: 'invoice',
      extraction: { fields: {} },
    });

    expect(result.map((decision) => decision.decision_type)).toEqual(['missing_invoice_number']);
    expect(documentDecisionsToPersisted).toHaveBeenCalledWith(
      [expect.objectContaining({ decision_type: 'missing_invoice_number', source: 'deterministic' })],
      { document_type: 'invoice' },
    );
    expect(persistDecisions).toHaveBeenCalledTimes(1);
  });

  it('persists nothing when every detection is model-origin', async () => {
    const persistDecisions = vi.fn();
    vi.doMock('@/lib/server/heuristicDecisionEngine', () => ({
      runDecisionEngine: vi.fn(async () => [detection('termination_flag', 'ai_enriched')]),
    }));
    vi.doMock('@/lib/server/decisionPersistence', () => ({
      persistDecisions, documentDecisionsToPersisted: vi.fn(),
    }));

    const { generateAndPersistDecisions } = await import('@/lib/pipeline/decisionEngine');
    const result = await generateAndPersistDecisions({
      admin: {} as never, documentId: 'doc-1', organizationId: 'org-1', documentType: null,
      extraction: { fields: {} },
    });

    expect(result).toEqual([]);
    expect(persistDecisions).not.toHaveBeenCalled();
  });
});
