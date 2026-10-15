import { describe, expect, it } from 'vitest';

import { classifyCase, corpusCensus, type CorpusManifestEntry, productionExclusion } from './corpusV2';

const GOODLETTSVILLE = 'e7185c5f-f532-4886-9022-2e449ced9445';
const PRICE_SHEET = '40a7f15b-6351-41d3-b953-fda41f993df5';

describe('Case Investigation contract v2 corpus policy', () => {
  it('classifies the three conflict rules as conflict and everything else as validator_failure', () => {
    expect(classifyCase({ ruleId: 'TRANSACTION_TICKET_GRAIN_CONFLICT' })).toBe('conflict');
    expect(classifyCase({ ruleId: 'CANONICAL_INVOICE_IDENTITY_CONFLICT' })).toBe('conflict');
    expect(classifyCase({ ruleId: 'CANONICAL_GOVERNING_RELATIONSHIP_CONFLICTING' })).toBe('conflict');
    expect(classifyCase({ ruleId: 'contract_ceiling_missing' })).toBe('validator_failure');
  });

  it('excludes Goodlettsville cases resting on the duplicate price sheet, and only those', () => {
    expect(productionExclusion({ projectId: GOODLETTSVILLE, ruleId: 'FINANCIAL_RATE_CODE_MISSING', evidenceDocumentIds: [] }))
      .toBe('duplicate_price_sheet_rate_dependent');
    expect(productionExclusion({ projectId: GOODLETTSVILLE, ruleId: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO', evidenceDocumentIds: [] }))
      .toBe('duplicate_price_sheet_rate_dependent');
    expect(productionExclusion({ projectId: GOODLETTSVILLE, ruleId: 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE', evidenceDocumentIds: [PRICE_SHEET] }))
      .toBe('duplicate_price_sheet_cited');
    expect(productionExclusion({ projectId: GOODLETTSVILLE, ruleId: 'TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE', evidenceDocumentIds: [null] }))
      .toBeNull();
    // Another project's rate rules are unaffected.
    expect(productionExclusion({ projectId: 'other', ruleId: 'FINANCIAL_RATE_CODE_MISSING', evidenceDocumentIds: [PRICE_SHEET] }))
      .toBeNull();
  });

  it('counts eligible cases per class against v1 minimums', () => {
    const entry = (qualificationClass: CorpusManifestEntry['qualificationClass'], excluded: CorpusManifestEntry['excluded'] = null) =>
      ({ qualificationClass, excluded }) as CorpusManifestEntry;
    const census = corpusCensus([
      ...Array.from({ length: 40 }, () => entry('validator_failure')),
      ...Array.from({ length: 19 }, () => entry('conflict')),
      entry('validator_failure', 'duplicate_price_sheet_rate_dependent'),
    ]);
    expect(census).toEqual({ eligible: { validator_failure: 40, conflict: 19 }, excluded: 1, minimumsMet: false });
  });
});
