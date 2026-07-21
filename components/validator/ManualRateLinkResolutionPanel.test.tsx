import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';
import {
  beginManualRateLinkSubmission,
  endManualRateLinkSubmission,
  manualRateLinkOptionsUrl,
  submitManualRateLink,
  type ManualRateLinkOptionsResponse,
} from '@/components/validator/ManualRateLinkResolutionPanel';

const state: ManualRateLinkOptionsResponse = {
  options: [{
    documentId: 'contract-doc-1',
    recordId: 'rate-row-1',
    rateCode: '6A',
    description: 'Hazardous limb removal',
    unitType: 'Tree',
    rateAmount: 80,
    canonicalCategory: 'tree_operations',
  }],
  recommendedRecordId: 'rate-row-1',
  activeManualLinkRecordId: null,
  invoiceLine: {
    documentId: 'invoice-doc-1',
    subjectId: 'fact:invoice-doc-1:line:6',
    lineNumber: '6',
    description: 'Hazardous limb removal',
    billingCode: null,
  },
};

describe('ManualRateLinkResolutionPanel request behavior', () => {
  it('loads picker state from the project-scoped read endpoint', () => {
    assert.equal(
      manualRateLinkOptionsUrl('project-1', 'fact:invoice-doc-1:line:6'),
      '/api/projects/project-1/invoice-line-rate-link?invoice_line_subject_id=fact%3Ainvoice-doc-1%3Aline%3A6',
    );
  });

  it('prevents a second submission while the first is in flight', () => {
    const lock = { current: false };
    assert.equal(beginManualRateLinkSubmission(lock), true);
    assert.equal(beginManualRateLinkSubmission(lock), false);
    endManualRateLinkSubmission(lock);
    assert.equal(beginManualRateLinkSubmission(lock), true);
  });

  it('surfaces endpoint failure without changing active-link state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'Selected row is outside the governing pricing family' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));

    await assert.rejects(
      () => submitManualRateLink({
        projectId: 'project-1',
        state,
        option: state.options[0]!,
        accessToken: 'test-token',
        fetchImpl,
      }),
      /outside the governing pricing family/,
    );

    assert.equal(fetchImpl.mock.calls.length, 1);
    assert.equal(state.activeManualLinkRecordId, null);
  });
});
