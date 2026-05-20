import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { inferInvoiceContractorFromPlainText, normalizeInvoiceContractorDisplay } from './invoiceCanonicalNames';

describe('invoiceCanonicalNames', () => {
  it('canonicalizes Aftermath Disaster Recovery from common invoice header forms', () => {
    assert.equal(normalizeInvoiceContractorDisplay('AFTERMATH DISASTER RECOVERY'), 'Aftermath Disaster Recovery');
    assert.equal(
      normalizeInvoiceContractorDisplay('Aftermath Disaster Recovery, Inc.'),
      'Aftermath Disaster Recovery',
    );
  });

  it('infers Aftermath contractor from plain invoice text (Williamson-style header)', () => {
    const block = `
      AFTERMATH DISASTER RECOVERY
      123 Recovery Way
      Invoice INV-001

      Bill To
      Williamson County Highway Dept
      302 Beasley Dr
    `;
    assert.equal(inferInvoiceContractorFromPlainText(block), 'Aftermath Disaster Recovery');
  });
});
