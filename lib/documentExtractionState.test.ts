import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  resolveDocumentExtractionState,
  resolveDocumentExtractionStaleness,
} from '@/lib/documentExtractionState';

function stepStates(processingStatus: string | null, operationalStatus?: string | null) {
  return resolveDocumentExtractionState({ processingStatus, operationalStatus }).steps.map((step) => [
    step.key,
    step.state,
  ]);
}

describe('resolveDocumentExtractionState', () => {
  it('keeps uploaded and processing documents at the uploaded step', () => {
    assert.deepEqual(stepStates('uploaded'), [
      ['uploaded', 'current'],
      ['extracted', 'pending'],
      ['facts_confirmed', 'pending'],
      ['validated', 'pending'],
    ]);

    assert.equal(resolveDocumentExtractionState({ processingStatus: 'processing' }).statusLabel, 'Processing');
  });

  it('maps extracted documents to the extracted step', () => {
    const state = resolveDocumentExtractionState({ processingStatus: 'extracted' });

    assert.equal(state.currentStep, 'extracted');
    assert.deepEqual(state.steps.map((step) => step.state), ['done', 'current', 'pending', 'pending']);
  });

  it('uses operational status to represent confirmed facts', () => {
    const state = resolveDocumentExtractionState({
      processingStatus: 'extracted',
      operationalStatus: 'Reviewed',
    });

    assert.equal(state.currentStep, 'facts_confirmed');
    assert.equal(state.statusLabel, 'Facts Confirmed');
    assert.deepEqual(state.steps.map((step) => step.state), ['done', 'done', 'current', 'pending']);
  });

  it('maps decisioned or operationally clear documents to validated', () => {
    assert.equal(
      resolveDocumentExtractionState({ processingStatus: 'decisioned' }).currentStep,
      'validated',
    );
    assert.equal(
      resolveDocumentExtractionState({
        processingStatus: 'extracted',
        operationalStatus: 'Operationally clear',
      }).currentStep,
      'validated',
    );
  });

  it('marks failed documents without advancing derived truth steps', () => {
    const state = resolveDocumentExtractionState({ processingStatus: 'failed' });

    assert.equal(state.failed, true);
    assert.deepEqual(state.steps.map((step) => step.state), ['failed', 'pending', 'pending', 'pending']);
  });
});

describe('resolveDocumentExtractionStaleness', () => {
  it('does not flag fresh extraction timestamps', () => {
    const result = resolveDocumentExtractionStaleness({
      sourceCreatedAt: '2026-06-20T10:00:00.000Z',
      sourceUpdatedAt: '2026-06-21T10:00:00.000Z',
      extractionTimestamp: '2026-06-21T10:00:01.000Z',
    });

    assert.equal(result.stale, false);
    assert.equal(result.label, null);
  });

  it('flags an extraction older than the source timestamp', () => {
    const result = resolveDocumentExtractionStaleness({
      sourceCreatedAt: '2026-06-20T10:00:00.000Z',
      sourceUpdatedAt: '2026-06-24T10:00:00.000Z',
      extractionTimestamp: '2026-06-10T10:00:00.000Z',
      now: new Date('2026-06-24T10:00:00.000Z'),
    });

    assert.equal(result.stale, true);
    assert.equal(result.label, 'Extracted 14 days ago; source document changed since');
  });
});
