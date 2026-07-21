import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

vi.mock('@/lib/validator/projectValidator', () => ({
  loadProjectValidatorInput: vi.fn(),
  buildInvoiceLineToRateMap: vi.fn(),
}));

import {
  buildInvoiceLineToRateMap,
  loadProjectValidatorInput,
} from '@/lib/validator/projectValidator';
import {
  loadManualRateLinkOptions,
  ManualRateLinkOptionsError,
} from '@/lib/server/manualRateLinkOptions';
import type { RateScheduleItem } from '@/lib/validator/shared';

const automated: RateScheduleItem = {
  source_document_id: 'pricing-doc-1',
  record_id: 'recommended-row',
  rate_code: '6A',
  unit_type: 'Tree',
  rate_amount: 80,
  material_type: null,
  description: 'Hazardous limb removal',
  canonical_category: 'tree_operations',
  raw_value: {},
};

const active: RateScheduleItem = {
  ...automated,
  record_id: 'active-row',
  match_source_kind: 'manual_link',
};

function validatorInput() {
  return {
    project: { id: 'project-1', organization_id: 'org-1' },
    invoiceLines: [{
      id: 'typed:invoice-doc-1:invoice:line:6',
      source_document_id: 'invoice-doc-1',
      description: 'Hazardous limb removal',
    }],
    factLookups: { rateScheduleItems: [automated, active] },
    invoiceLineToRateMap: new Map([['typed:invoice-doc-1:invoice:line:6', active]]),
  };
}

describe('loadManualRateLinkOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadProjectValidatorInput).mockResolvedValue(validatorInput() as never);
    vi.mocked(buildInvoiceLineToRateMap).mockReturnValue(new Map([
      ['typed:invoice-doc-1:invoice:line:6', automated],
    ]));
  });

  it('uses validator-loaded canonical rows and keeps recommendation separate from active state', async () => {
    const result = await loadManualRateLinkOptions({
      projectId: 'project-1',
      organizationId: 'org-1',
      invoiceLineSubjectId: 'fact:invoice-doc-1:line:6',
    });

    assert.equal(vi.mocked(loadProjectValidatorInput).mock.calls.length, 1);
    assert.equal(vi.mocked(buildInvoiceLineToRateMap).mock.calls.length, 1);
    assert.equal(result.recommendedRecordId, 'recommended-row');
    assert.equal(result.activeManualLinkRecordId, 'active-row');
    assert.deepEqual(result.options.map((option) => option.recordId), ['active-row', 'recommended-row']);
    assert.equal(result.invoiceLine.documentId, 'invoice-doc-1');
  });

  it('rejects a project loaded for a different organization', async () => {
    await assert.rejects(
      () => loadManualRateLinkOptions({
        projectId: 'project-1',
        organizationId: 'org-2',
        invoiceLineSubjectId: 'fact:invoice-doc-1:line:6',
      }),
      (error: unknown) => error instanceof ManualRateLinkOptionsError && error.status === 404,
    );
  });
});
