import { describe, expect, it } from 'vitest';
import { buildAskResponse } from '@/lib/ask/answerBuilder';
import type { RetrievalResult } from '@/lib/ask/types';

const retrieval: RetrievalResult = {
  facts: [{ id: 'total', label: 'Project invoice total rollup', fieldKey: 'total_billed', value: 1000,
    extractedFrom: 'project:p', confidence: 96, timestamp: '2026-01-01', sourceKind: 'canonical_project_fact' }],
  validatorFindings: [], decisions: [], documents: [], relationships: [],
  rawData: { matchedLayer: 'facts', executionSummary: { recommended_next_action: null, open_execution_items: [], payment_release_blockers: [] } },
};
function answer(question: string) {
  return buildAskResponse({ question: { originalQuestion: question, intent: 'fact_question', confidence: 'high', keywords: [] },
    retrieval, project: { id: 'p', name: 'P', validationStatus: 'VALIDATED', validationSummary: {
      status: 'VALIDATED', readiness: 'READY', blocker_count: 0, warning_count: 0, total_billed: 1000,
      reviewed_documents_with_warnings: [], first_document_to_inspect: null,
    } }, projectId: 'p', orgId: 'o' });
}
describe('typed answers precede unrelated direct facts', () => {
  it('does not verify readiness or blocker absence from an unrelated billed fact', () => {
    const response = buildAskResponse({ question: { originalQuestion: 'Is this project ready for invoice approval?',
      intent: 'fact_question', confidence: 'high', keywords: [] }, retrieval,
      project: { id: 'p', name: 'P', validationSummary: null }, projectId: 'p', orgId: 'o' });
    expect(response.actionableGap?.missing).toContain('persisted validation status');
    expect(response.sections?.confidenceState).toBe('Not Found');
    expect(response.sources).toEqual([]);
  });
  it.each(['What is the governing contract?', 'What is the required payment documentation?'])(
    'cannot bypass an unavailable typed field with scalar wording: %s', (question) => {
      const response = answer(question);
      expect(['upstream', 'ambiguous']).toContain(response.actionableGap?.gapClass);
      expect(response.answer).not.toContain('$1,000');
      expect(response.sources).toEqual([]);
    },
  );
  it('returns readiness rather than a billed-total claim', () => {
    expect(answer('Is this project ready for invoice approval?').answer).toContain('readiness');
    expect(answer('Is this project ready for invoice approval?').answer).not.toContain('Project invoice total rollup is');
  });
  it('returns the computed empty execution action state', () => {
    expect(answer('What is the next best action for this project?').answer).toContain('no action pending');
  });
  it('returns invoice support semantics rather than an unrelated rollup', () => {
    expect(answer('Which invoice amounts are unsupported?').actionableGap?.missing).toContain('invoice_summaries');
    expect(answer('Does this invoice use the correct contract rates from the source?').answer).not.toContain('canonical project invoice total rollup');
  });
  it('preserves direct billed scalar and lineage reads', () => {
    expect(answer('How much has been billed so far?').answer).toContain('$1,000');
    expect(answer('Where did the $1,000 total come from?').answer).toContain('canonical project invoice total rollup');
  });
  it('publishes the sourced canonical empty review set rather than declaring it absent', () => {
    expect(answer('Are any documents marked reviewed but still producing warnings?').answer).toContain('no document');
  });
  it('does not attach a generic missing-fact gap to verified canonical snapshot or execution answers', () => {
    for (const question of ['Which document should the operator inspect first?', 'What is the next best action for this project?']) {
      const response = buildAskResponse({
        question: { originalQuestion: question, intent: 'fact_question', confidence: 'high', keywords: [] },
        retrieval: { ...retrieval, facts: [] },
        project: { id: 'p', name: 'P', validationStatus: 'VALIDATED', validationSummary: { first_document_to_inspect: null } },
        projectId: 'p', orgId: 'o',
      });
      expect(response.sections?.upstreamGap).toBeNull();
      expect(response.actionableGap).toBeUndefined();
      expect(response.sections?.confidenceState).not.toBe('Not Found');
    }
  });
  it('keeps an unsupported review history request as a missing-evidence condition', () => {
    const response = answer('What changed since the last review?');
    expect(response.actionableGap?.missing).toContain('review baseline and before/after audit events');
    expect(response.sections?.confidenceState).toBe('Not Found');
  });
});
