import { describe, expect, it } from 'vitest';
import type { ProjectSelectorParams } from '@/lib/ask/selectors';
import { selectProjectReviewAuditState } from '@/lib/ask/selectors/projectReviewAuditState';

function params(question: string, summary: unknown): ProjectSelectorParams {
  return {
    question: { originalQuestion: question, intent: 'document_lookup', confidence: 'high', keywords: [] },
    projectId: 'p', project: { id: 'p', name: 'P', validationSummary: summary },
    retrieval: { facts: [], validatorFindings: [], decisions: [], relationships: [], documents: [], rawData: {} },
  };
}

describe('review selectors require canonical review evidence', () => {
  it('distinguishes a sourced empty warning set from an absent or malformed field', () => {
    const question = 'Are any documents marked reviewed but still producing warnings?';
    const empty = selectProjectReviewAuditState(params(question, { reviewed_documents_with_warnings: [] }));
    expect(empty.confidence).toBe('verified');
    expect(empty.value).toContain('no document');
    expect(empty.sources[0]?.factId).toContain('validator-summary:reviewed_documents_with_warnings');
    for (const summary of [{}, { reviewed_documents_with_warnings: [{}] }, { reviewed_documents_with_warnings: null }]) {
      expect(selectProjectReviewAuditState(params(question, summary)).confidence).toBe('not_found');
    }
  });

  it('distinguishes a sourced null inspection priority from missing or malformed fields', () => {
    const question = 'Which document should the operator inspect first?';
    expect(selectProjectReviewAuditState(params(question, { first_document_to_inspect: null })).value).toContain('no document');
    for (const summary of [{}, { first_document_to_inspect: {} }]) {
      expect(selectProjectReviewAuditState(params(question, summary)).confidence).toBe('not_found');
    }
  });

  it('preserves positive review warning evidence', () => {
    const answer = selectProjectReviewAuditState(params('Are any documents marked reviewed but still producing warnings?', {
      status: 'FINDINGS_OPEN', reviewed_documents_with_warnings: [{ document_id: 'd', warning_count: 2, review_event_source: 'review:event' }],
    }));
    expect(answer.confidence).toBe('verified');
    expect(answer.value).toContain('warning count 2');
    expect(answer.sources[0]?.factId).toBe('review:event');
  });

  it.each(['Which documents still need review?', 'What changed since the last review?', 'Which findings were overridden?'])(
    'does not manufacture audit assertions for %s from a document or finding', (question) => {
      const input = params(question, {});
      input.retrieval.documents = [{ id: 'd', title: 'Processed document', documentType: 'contract', processingStatus: 'decisioned', createdAt: '2026-01-01' }];
      const answer = selectProjectReviewAuditState(input);
      expect(answer.confidence).toBe('not_found');
      expect(answer.documents).toEqual([]);
      expect(answer.value).not.toContain('review status open');
      expect(answer.value).not.toContain('changed item d');
    },
  );
  it('preserves actual human-reviewed values without inventing audit metadata', () => {
    const input = params('Which facts were manually confirmed?', {});
    input.retrieval.facts = [{ id: 'f', factId: 'review:f', label: 'Contractor', value: 'Human value',
      sourceKind: 'human_review', reviewStatus: 'confirmed', extractedFrom: 'd', confidence: 99, timestamp: '2026-01-01' }];
    const answer = selectProjectReviewAuditState(input);
    expect(answer.value).toContain('Human value');
    expect(answer.value).toContain('not available');
    expect(answer.confidence).toBe('partial');
    expect(answer.sources[0]?.factId).toBe('review:f');
  });
});
