import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { parseContractEvidenceV1 } from './documentEvidencePipelineV1';

const williamsonNarrativePricingPage = [
  'b. Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A, attached hereto and incorporated herein, unless otherwise approved in writing by County.',
  'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
  'Payment shall be made only for quantities verified by County or County\'s designated representative and documented in a manner sufficient to support FEMA Public Assistance reimbursement eligibility.',
  'Reimbursement for travel is not considered a payable item by County. Fuel surcharges are not allowed.',
  'Nothing in this Contract or Exhibit A shall be construed to guarantee any minimum amount of work or compensation.',
].join('\n');

const williamsonInsurancePage = [
  '1. Premise/Operations',
  '2. Explosion, Collapse and Underground Property Damage Hazard',
  '3. Products/Completed Operations',
  '8. Business Automobile Liability: $1,000,000 per accident for property damage and personal injury.',
  'Workers Compensation statutory limits as required by Tennessee.',
  'Employers Liability coverage for $1,000,000 per incident.',
].join('\n');

const williamsonRatePage8 = [
  'EXHIBIT A',
  'EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
  'Category | Description | Unit | Rate',
  'Vegetative Collect, Remove & Haul | 0-16 Miles from ROW to DMS | Cubic Yard | $6.90',
  'Vegetative Collect, Remove & Haul | 16-30 Miles from ROW to DMS | Cubic Yard | $7.90',
  'Vegetative Collect, Remove & Haul | 31-60 Miles from ROW to DMS | Cubic Yard | $8.90',
  'Final Disposal | Single Cost - Any Distance | Cubic Yard | $5.40',
].join('\n');

const williamsonRatePage9 = [
  'Category | Description | Unit | Rate',
  'Final Disposal | Tipping Fee - Vegetative | Cubic Yard | Passthrough',
  'Final Disposal | Tipping Fee - C&D | Cubic Yard | Passthrough',
  'Tree Operations | Hazardous Trees 25"-36" trunk diameter | Tree | $316.00',
  'Tree Operations | Trees with Hazardous Limbs Hanging | Tree | $80.00',
  'Specialty Removal | Vehicle Removal | Unit | $200.00',
  'Specialty Removal | Carcass Removal | Pound | $8.00',
].join('\n');

const williamsonRatePage10 = [
  'SECTION 2 - TIME & MATERIALS',
  'Category | Description | Unit | Rate',
  'Personnel | Operations Supervisor | Hour | $95.00',
  'Personnel | Truck Driver | Hour | $80.00',
  'Personnel | Laborer with Chain Saw | Hour | $85.00',
  'Equipment | Tub Grinder (800-1,000 HP) | Hour | $500.00',
  'Equipment | Wheel Loader with debris grapple | Hour | $126.00',
].join('\n');

const williamsonRatePage11 = [
  'Category | Description | Unit | Rate',
  'Equipment | Service Truck | Hour | $50.00',
  'Equipment | Water Truck | Hour | $96.00',
  'Equipment | Dump Truck, 5-12 Cu. Yd. Capacity | Hour | $170.00',
  'Equipment | Trailer Dump Truck, 61-90 Cu. Yd. | Hour | $190.00',
  'Equipment | Self-loading Barge 30-45 ft | Hour | $500.00',
].join('\n');

const williamsonAdditionalTermsPage = [
  'EXHIBIT B',
  'ADDITIONAL TERMS',
  'Compliance with the Contract Work Hours and Safety Standards Act.',
  'No contractor or subcontractor shall require any laborer or mechanic to work in excess of forty (40) hours in a workweek unless that worker receives compensation at a rate not less than one and one-half times the basic rate of pay.',
  'Liquidated damages shall be computed in the sum of $32 for each calendar day on which such individual was required or permitted to work in excess of the standard workweek of forty hours without payment of overtime wages.',
].join('\n');

const williamsonFederalTermsPage = [
  'Subcontracts. Contractor or subcontractor must insert in any subcontracts the clauses set forth in this Exhibit B.',
  'The Clean Air Act and the Federal Water Pollution Control Act apply to any subcontract exceeding $150,000 financed in whole or in part with federal assistance provided by FEMA.',
  'Each tier certifies to the tier above that it will not and has not used federal appropriated funds to pay any person for influencing or attempting to influence an officer or employee of any agency.',
].join('\n');

const williamsonClosingCompliancePage = [
  'Compliance with Federal Law, Regulations, and Executive Orders. Contractor acknowledges that FEMA financial assistance will be used to fund all or a portion of the contract.',
  'Compliance with FEMA Requirements. Contractor acknowledges that work performed under this Contract is intended to be eligible for reimbursement under FEMA\'s Public Assistance Program.',
  'Subcontracts. Contractor shall not subcontract any portion of the services without prior written approval of County.',
].join('\n');

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

  it('rate-bearing section detection recognizes schedule of values headings from the shared registry', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 6,
          text: [
            'SCHEDULE OF VALUES',
            'Item Description Scheduled Value',
            '1 Mobilization $12,500.00',
            '2 Debris Loading $48,750.00',
            '3 Hauling $35,125.00',
            '4 Final Cleanup $9,900.00',
          ].join('\n'),
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, true);
    assert.deepEqual(result.section_signals.rate_section_pages, [6]);
    assert.equal(result.section_signals.rate_section_label, 'SCHEDULE OF VALUES');
    assert.equal(result.section_signals.unit_price_structure_present, true);
  });

  it('rate-bearing section detection recognizes CLIN-style contract price schedules without the word rate', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 9,
          text: [
            'CONTRACT PRICE SCHEDULE',
            'CLIN Description Qty Unit Price Total',
            '0001 Tree removal 12 $483.31 $5,799.72',
            '0002 Debris hauling 8 $313.27 $2,506.16',
            '0003 Stump grinding 4 $150.00 $600.00',
          ].join('\n'),
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, true);
    assert.deepEqual(result.section_signals.rate_section_pages, [9]);
    assert.equal(result.section_signals.rate_section_label, 'CONTRACT PRICE SCHEDULE');
    assert.equal(result.section_signals.unit_price_structure_present, true);
  });

  it('rate-bearing section detection counts OCR table rows when unit and rate are in separate columns', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 8,
          text: [
            'EXHIBIT A',
            'EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES',
            'Category | Description | Unit | Rate',
            'Vegetative Collect, Remove & Haul | 0-16 Miles from ROW to DMS | Cubic Yard | $6.90',
            'Vegetative Collect, Remove & Haul | 16-30 Miles from ROW to DMS | Cubic Yard | $7.90',
            'Mixed C&D Collect, Remove & Haul | 31-60 Miles from ROW to DMS | Cubic Yard | $8.90',
            'Equipment | Service Truck | Hour | $50.00',
          ].join('\n'),
          source_method: 'ocr',
        },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, true);
    assert.deepEqual(result.section_signals.rate_section_pages, [8]);
    assert.ok(result.section_signals.rate_items_detected >= 4);
    assert.ok(result.section_signals.rate_units_detected.includes('cubic yard'));
    assert.ok(result.section_signals.rate_units_detected.includes('hour'));
  });

  it('keeps narrative pricing references available without promoting the page to a rate schedule page', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 3,
          text: williamsonNarrativePricingPage,
          source_method: 'pdf_text',
        },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, false);
    assert.deepEqual(result.section_signals.rate_section_pages, []);
    assert.equal(result.section_signals.rate_items_detected, 0);
    assert.equal(result.section_signals.unit_price_structure_present, true);
    assert.equal(result.section_signals.time_and_materials_present, true);
    assert.match(result.section_signals.rate_section_label ?? '', /exhibit a|unit prices/i);
  });

  it('restricts Williamson-style rate schedule pages to the actual exhibit table pages', () => {
    const result = parseContractEvidenceV1({
      pages: [
        { page_number: 3, text: williamsonNarrativePricingPage, source_method: 'pdf_text' },
        { page_number: 5, text: williamsonInsurancePage, source_method: 'pdf_text' },
        { page_number: 8, text: williamsonRatePage8, source_method: 'ocr' },
        { page_number: 9, text: williamsonRatePage9, source_method: 'ocr' },
        { page_number: 10, text: williamsonRatePage10, source_method: 'ocr' },
        { page_number: 11, text: williamsonRatePage11, source_method: 'ocr' },
        { page_number: 12, text: williamsonAdditionalTermsPage, source_method: 'pdf_text' },
        { page_number: 13, text: williamsonFederalTermsPage, source_method: 'pdf_text' },
        { page_number: 15, text: williamsonClosingCompliancePage, source_method: 'pdf_text' },
      ],
    });

    assert.equal(result.section_signals.rate_section_present, true);
    assert.deepEqual(result.section_signals.rate_section_pages, [8, 9, 10, 11]);
    assert.ok(result.section_signals.rate_items_detected >= 10);
    assert.ok(result.section_signals.rate_units_detected.includes('cubic yard'));
    assert.ok(result.section_signals.rate_units_detected.includes('hour'));
    assert.ok(result.section_signals.rate_units_detected.includes('pound'));
    assert.equal(result.section_signals.unit_price_structure_present, true);
    assert.equal(result.section_signals.time_and_materials_present, true);
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

  it('extracts EMERG03 front-matter facts from pages 1 and 2 without header or notary noise', () => {
    const result = parseContractEvidenceV1({
      pages: [
        {
          page_number: 1,
          text: [
            'CONTRACT NO. EMERG03',
            'VENDOR NO. NM-00123',
            'THIS AGREEMENT is made and entered into by and between the New Mexico Department of Transportation and Stampede Ventures, Inc.',
            'Agreement Date: 8/12/2024',
            'ACKNOWLEDGMENT',
            'STATE OF NEW MEXICO',
            'COUNTY OF SANTA FE',
            'Subscribed and sworn before me this 15th day of August, 2024.',
          ].join('\n'),
          source_method: 'pdf_text',
        },
        {
          page_number: 2,
          text: [
            'TERM 1.B',
            'The effective date of this Agreement is 8/12/2024.',
            'This Agreement shall remain in effect for a period not to exceed 6 months from the effective date.',
            'The total amount payable to the Contractor under this Agreement, inclusive of gross receipts tax and all authorized work, shall not exceed $30,000,000.00.',
          ].join('\n'),
          source_method: 'pdf_text',
        },
      ],
    });

    assert.match(result.structured_fields.contractor_name ?? '', /^Stampede Ventures, Inc\.?$/);
    assert.equal(result.structured_fields.owner_name, 'New Mexico Department of Transportation');
    assert.equal(result.structured_fields.executed_date, '8/12/2024');
    assert.equal(result.structured_fields.term_start_date, '2024-08-12');
    assert.equal(result.structured_fields.term_end_date, '2025-02-12');
    assert.equal(result.structured_fields.expiration_date, '2025-02-12');
    assert.equal(result.structured_fields.nte_amount, 30000000);
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
