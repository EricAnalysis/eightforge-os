import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseContractEvidenceV1 } from './documentEvidencePipelineV1';

describe('document evidence pipeline v1', () => {
  it('term range: pages are processed in page_number order (intro not scrambled)', () => {
    const result = parseContractEvidenceV1({
      pages: [
        { page_number: 2, text: 'Later page.', source_method: 'pdf_text' },
        {
          page_number: 1,
          text: 'The term of this Agreement shall be from the date of September 2, 2025 to November 1, 2025.',
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.structured_fields.term_start_date, '2025-09-02');
    assert.equal(result.structured_fields.term_end_date, '2025-11-01');
    assert.equal(result.structured_fields.expiration_date, '2025-11-01');
  });

  it('term range: layout combined text is searched when native page text omits the clause', () => {
    const result = parseContractEvidenceV1({
      pages: [
        { page_number: 1, text: 'Preamble only. Terms of Contract section follows.', source_method: 'pdf_text' },
      ],
      layoutCombinedText:
        'The term of this Agreement shall be from the date of September 2, 2025 to November 1, 2025.',
    });

    assert.equal(result.structured_fields.term_start_date, '2025-09-02');
    assert.equal(result.structured_fields.term_end_date, '2025-11-01');
    assert.equal(result.structured_fields.expiration_date, '2025-11-01');
  });

  it('term range: layout-only clause with "the September" still wins over unrelated raw dates', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 1,
          text: 'NOTICE OF ST. LOUIS LIVING WAGE RATES EFFECTIVE APRIL 1, 2025. Preamble only.',
          source_method: 'pdf_text',
        },
      ],
      layoutCombinedText:
        'The term of this Agreement shall be from the date of the September 2, 2025 to November 1, 2025.',
    });

    assert.equal(result.structured_fields.term_start_date, '2025-09-02');
    assert.equal(result.structured_fields.term_end_date, '2025-11-01');
    assert.equal(result.structured_fields.expiration_date, '2025-11-01');
  });

  it('rate-bearing section detection works without literal “Exhibit A”', () => {
    const result = parseContractEvidenceV1({
      pages: [
        { page_number: 1, text: 'AGREEMENT\nThis Contract is by and between OWNER: City of Example and CONTRACTOR: Acme Debris LLC', source_method: 'pdf_text' },
        {
          page_number: 7,
          text: [
            'SCHEDULE OF RATES',
            'Compensation shall be based on the following unit prices:',
            '$125.00 per ton',
            '$18.50 per cubic yard',
            '$95.00 per hour',
            'unit price',
            'ton 125.00',
            'cy 18.50',
            'hr 95.00',
          ].join('\n'),
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, true);
    assert.deepEqual(result.section_signals.rate_section_pages, [7]);
    assert.ok((result.section_signals.rate_section_label ?? '').toLowerCase().includes('schedule'));
    assert.ok(result.section_signals.rate_items_detected >= 3);
    assert.ok(result.section_signals.rate_units_detected.includes('ton'));
    assert.ok(result.section_signals.rate_units_detected.some((u: string) => u.includes('cubic') || u === 'cy'));
  });

  it('contractor and owner extraction from first-page party language', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 1,
          text: 'This Agreement is by and between OWNER: Williamson County, Tennessee and CONTRACTOR: Aftermath Disaster Recovery Inc.\nExecuted on 2/19/2026',
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.structured_fields.contractor_name?.toLowerCase().includes('aftermath'), true);
    assert.equal(result.structured_fields.owner_name?.toLowerCase().includes('williamson'), true);
    assert.equal(result.structured_fields.executed_date, '2/19/2026');
  });

  it('time-and-materials detection', () => {
    const result = parseContractEvidenceV1({
      pages: [
        { page_number: 1, text: 'PRICING\nTime and Materials (T&M) rates apply for emergency work.', source_method: 'pdf_text' },
      ],
    });

    assert.equal(result.section_signals.time_and_materials_present, true);
  });

  it('deterministic output for same input', () => {
    const input = {
      pages: [
        { page_number: 1, text: 'OWNER: City of Example\nCONTRACTOR: Acme LLC\nNot to exceed $5,000,000', source_method: 'pdf_text' },
        { page_number: 3, text: 'Fee Schedule\n$100 per hour\n$10 per ton', source_method: 'pdf_text' },
      ],
    } as const;

    const a = parseContractEvidenceV1(input);
    const b = parseContractEvidenceV1(input);
    assert.deepEqual(a, b);
  });
});
