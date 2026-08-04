import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';

describe('canonical pricing selection shadow parity', () => {
  it('guards the current candidate-presence versus selected-match distinction', () => {
    const reconciliation = readFileSync(
      'lib/validator/rulePacks/contractInvoiceReconciliation.ts',
      'utf8',
    );
    const verification = readFileSync(
      'lib/validator/rulePacks/crossDocumentRateVerification.ts',
      'utf8',
    );

    assert.match(reconciliation, /scheduleCandidates\.length\s*>\s*0/);
    assert.match(verification, /matchRateScheduleItemForInvoiceLine\([\s\S]{0,1000}\)\.match/);
    assert.doesNotMatch(reconciliation, /canonical\/reconciliation\/pricingMatch/);
    assert.doesNotMatch(verification, /canonical\/reconciliation\/pricingMatch/);
  });
});
