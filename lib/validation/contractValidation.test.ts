// lib/validation/contractValidation.test.ts
// Unit tests for the contract extraction validation harness.
//
// Run via:  npx vitest run lib/validation/contractValidation.test.ts

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  validateContractExtraction,
  formatTerminalReport,
  formatMarkdownSummary,
  pickContractorName,
  pickExecutedDate,
  pickTermStartDate,
  pickTermEndDate,
  pickNTE,
  pickRateSchedulePresent,
  pickRateRowCount,
} from './contractValidation';

import type { ContractActual, ContractExpected } from './contractValidation';

import { normalizeDate, normalizeCurrency, fuzzyStringMatch, numericClose, dateMatch } from './normalizeValidationValues';

// ── normalizeValidationValues tests ──────────────────────────────────────────

describe('normalizeDate', () => {
  it('passes through ISO 8601 unchanged', () => {
    assert.equal(normalizeDate('2026-03-01'), '2026-03-01');
  });

  it('parses MM/DD/YYYY', () => {
    assert.equal(normalizeDate('03/01/2026'), '2026-03-01');
  });

  it('parses "Month DD, YYYY"', () => {
    assert.equal(normalizeDate('March 1, 2026'), '2026-03-01');
  });

  it('parses "DD-Mon-YYYY"', () => {
    assert.equal(normalizeDate('01-Mar-2026'), '2026-03-01');
  });

  it('returns null for null/empty input', () => {
    assert.equal(normalizeDate(null), null);
    assert.equal(normalizeDate(''), null);
    assert.equal(normalizeDate(undefined), null);
  });

  it('returns null for unparseable string', () => {
    assert.equal(normalizeDate('not-a-date'), null);
  });
});

describe('normalizeCurrency', () => {
  it('strips $ and commas', () => {
    assert.equal(normalizeCurrency('$2,500,000'), 2500000);
  });

  it('handles plain number', () => {
    assert.equal(normalizeCurrency(2500000), 2500000);
  });

  it('returns null for null', () => {
    assert.equal(normalizeCurrency(null), null);
  });

  it('returns null for unparseable string', () => {
    assert.equal(normalizeCurrency('N/A'), null);
  });
});

describe('fuzzyStringMatch', () => {
  it('matches identical strings', () => {
    const r = fuzzyStringMatch('Aftermath Disaster Recovery LLC', 'Aftermath Disaster Recovery LLC');
    assert.equal(r.match, true);
    assert.equal(r.exact, true);
  });

  it('matches after normalization (case + whitespace)', () => {
    const r = fuzzyStringMatch('  AFTERMATH DISASTER RECOVERY LLC  ', 'aftermath disaster recovery llc');
    assert.equal(r.match, true);
  });

  it('passes substring match by default', () => {
    const r = fuzzyStringMatch('Aftermath Disaster Recovery LLC', 'Aftermath');
    assert.equal(r.match, true);
    assert.equal(r.exact, false);
  });

  it('fails substring match when exact=true', () => {
    const r = fuzzyStringMatch('Aftermath Disaster Recovery LLC', 'Aftermath', { exact: true });
    assert.equal(r.match, false);
  });

  it('handles null actual', () => {
    const r = fuzzyStringMatch(null, 'Aftermath');
    assert.equal(r.match, false);
  });

  it('handles both null', () => {
    const r = fuzzyStringMatch(null, null);
    assert.equal(r.match, true);
  });
});

describe('numericClose', () => {
  it('matches exact values', () => {
    const r = numericClose(2500000, 2500000);
    assert.equal(r.match, true);
    assert.equal(r.delta, 0);
  });

  it('fails on mismatch with no tolerance', () => {
    const r = numericClose(2500000, 2600000);
    assert.equal(r.match, false);
    assert.ok(r.reason.includes('Δ'));
  });

  it('passes within tolerance', () => {
    const r = numericClose(2490000, 2500000, 1); // 1% tolerance
    assert.equal(r.match, true);
  });

  it('fails outside tolerance', () => {
    const r = numericClose(2200000, 2500000, 1);
    assert.equal(r.match, false);
  });

  it('handles null both', () => {
    const r = numericClose(null, null);
    assert.equal(r.match, true);
  });

  it('fails when actual is null', () => {
    const r = numericClose(null, 2500000);
    assert.equal(r.match, false);
  });
});

describe('dateMatch', () => {
  it('matches identical ISO dates', () => {
    assert.equal(dateMatch('2026-03-01', '2026-03-01').match, true);
  });

  it('matches across formats after normalization', () => {
    assert.equal(dateMatch('03/01/2026', 'March 1, 2026').match, true);
  });

  it('fails different dates', () => {
    assert.equal(dateMatch('2026-03-01', '2026-04-01').match, false);
  });

  it('handles null both', () => {
    assert.equal(dateMatch(null, null).match, true);
  });
});

// ── Field pickers ─────────────────────────────────────────────────────────────

describe('field pickers', () => {
  const fullActual: ContractActual = {
    fields: {
      typed_fields: {
        vendor_name: 'Typed Vendor Name',
        contract_date: '2026-01-01',
        effective_date: '2026-02-01',
        expiration_date: '2027-01-31',
        rate_table: [
          { material_type: 'Vegetative', unit: 'per cubic yard', rate_amount: 8.5, rate_raw: '$8.50 per cubic yard' },
          { material_type: 'C&D', unit: 'per ton', rate_amount: 12.0, rate_raw: '$12.00 per ton' },
        ],
      },
    },
    extraction: {
      evidence_v1: {
        structured_fields: {
          contractor_name: 'Evidence Contractor LLC',
          executed_date: '2026-01-15',
          term_start_date: '2026-02-01',
          term_end_date: '2027-01-31',
          nte_amount: 2500000,
          contractor_name_source: 'explicit_definition',
        },
        section_signals: {
          rate_section_present: true,
          rate_items_detected: 4,
        },
      },
    },
  };

  it('pickContractorName prefers evidence_v1 over typed_fields', () => {
    assert.equal(pickContractorName(fullActual), 'Evidence Contractor LLC');
  });

  it('pickContractorName falls back to typed_fields.vendor_name', () => {
    const noEvidence: ContractActual = { fields: { typed_fields: { vendor_name: 'Fallback Vendor' } } };
    assert.equal(pickContractorName(noEvidence), 'Fallback Vendor');
  });

  it('pickExecutedDate prefers evidence_v1', () => {
    assert.equal(pickExecutedDate(fullActual), '2026-01-15');
  });

  it('pickTermStartDate prefers evidence_v1', () => {
    assert.equal(pickTermStartDate(fullActual), '2026-02-01');
  });

  it('pickTermEndDate prefers evidence_v1', () => {
    assert.equal(pickTermEndDate(fullActual), '2027-01-31');
  });

  it('pickNTE returns numeric from evidence_v1', () => {
    assert.equal(pickNTE(fullActual), 2500000);
  });

  it('pickRateSchedulePresent returns true when rate_section_present=true', () => {
    assert.equal(pickRateSchedulePresent(fullActual), true);
  });

  it('pickRateSchedulePresent returns false when no signals and no rows', () => {
    const empty: ContractActual = {};
    assert.equal(pickRateSchedulePresent(empty), false);
  });

  it('pickRateSchedulePresent falls back to typed_fields rate_table length', () => {
    const onlyTyped: ContractActual = {
      fields: { typed_fields: { rate_table: [{ rate_raw: '$8/cy' }] } },
      extraction: { evidence_v1: { section_signals: { rate_section_present: false } } },
    };
    assert.equal(pickRateSchedulePresent(onlyTyped), true);
  });

  it('pickRateRowCount prefers section_signals.rate_items_detected', () => {
    assert.equal(pickRateRowCount(fullActual), 4);
  });

  it('pickRateRowCount falls back to typed_fields rate_table length', () => {
    const noSignals: ContractActual = {
      fields: { typed_fields: { rate_table: [{ rate_raw: 'a' }, { rate_raw: 'b' }] } },
    };
    assert.equal(pickRateRowCount(noSignals), 2);
  });
});

// ── validateContractExtraction ────────────────────────────────────────────────

describe('validateContractExtraction — full pass', () => {
  const actual: ContractActual = {
    fields: {
      typed_fields: {
        rate_table: [
          { material_type: 'Vegetative', unit: 'per cubic yard', rate_amount: 8.5, rate_raw: '$8.50/cy' },
          { material_type: 'C&D', unit: 'per ton', rate_amount: 12.0, rate_raw: '$12.00/ton' },
          { material_type: 'Mixed', unit: 'per ton', rate_amount: 10.0, rate_raw: '$10.00/ton' },
        ],
      },
    },
    extraction: {
      evidence_v1: {
        structured_fields: {
          contractor_name: 'Aftermath Disaster Recovery LLC',
          executed_date: '2025-09-15',
          term_start_date: '2025-09-15',
          term_end_date: '2025-12-14',
          nte_amount: 2500000,
        },
        section_signals: {
          rate_section_present: true,
          rate_items_detected: 3,
        },
      },
    },
  };

  const expected: ContractExpected = {
    contract_name: 'Williamson Co TN — Aftermath',
    contractor_name: 'Aftermath Disaster Recovery LLC',
    executed_date: '2025-09-15',
    term_start_date: '2025-09-15',
    term_end_date: '2025-12-14',
    not_to_exceed_amount: 2500000,
    rate_schedule_present: true,
    rate_row_count: 3,
  };

  it('returns PASS overall when all fields match', () => {
    const result = validateContractExtraction(actual, expected);
    assert.equal(result.overall_status, 'PASS');
    assert.equal(result.failed_checks, 0);
    assert.equal(result.missing_checks, 0);
  });

  it('includes all expected fields in field_results', () => {
    const result = validateContractExtraction(actual, expected);
    const checkedFields = result.field_results.map(r => r.field);
    assert.ok(checkedFields.includes('contractor_name'));
    assert.ok(checkedFields.includes('executed_date'));
    assert.ok(checkedFields.includes('not_to_exceed_amount'));
    assert.ok(checkedFields.includes('rate_schedule_present'));
    assert.ok(checkedFields.includes('rate_row_count'));
  });
});

describe('validateContractExtraction — failures and missing', () => {
  it('FAIL on wrong contractor name (exact mode)', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: { contractor_name: 'Wrong Vendor Inc' } } },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      contractor_name: 'Aftermath Disaster Recovery LLC',
      tolerance: { string_exact: true },
    };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'contractor_name')!;
    assert.equal(field.status, 'FAIL');
    assert.equal(result.overall_status, 'FAIL');
  });

  it('PASS on substring contractor match (tolerant default)', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: { contractor_name: 'Aftermath Disaster Recovery LLC' } } },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      contractor_name: 'Aftermath',
    };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'contractor_name')!;
    assert.equal(field.status, 'PASS');
  });

  it('MISSING when contractor_name not in extraction', () => {
    const actual: ContractActual = { fields: { typed_fields: {} } };
    const expected: ContractExpected = { contract_name: 'Test', contractor_name: 'Someone' };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'contractor_name')!;
    assert.equal(field.status, 'MISSING');
    assert.ok(result.missing_checks > 0);
  });

  it('FAIL on wrong NTE amount', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: { nte_amount: 1000000 } } },
    };
    const expected: ContractExpected = { contract_name: 'Test', not_to_exceed_amount: 2500000 };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'not_to_exceed_amount')!;
    assert.equal(field.status, 'FAIL');
    assert.ok(field.reason.includes('Δ'));
  });

  it('PASS on NTE within currency tolerance', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: { nte_amount: 2490000 } } },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      not_to_exceed_amount: 2500000,
      tolerance: { currency_pct: 1 },
    };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'not_to_exceed_amount')!;
    assert.equal(field.status, 'PASS');
  });

  it('FAIL on wrong term date', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: { executed_date: '2025-01-01' } } },
    };
    const expected: ContractExpected = { contract_name: 'Test', executed_date: '2025-09-15' };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'executed_date')!;
    assert.equal(field.status, 'FAIL');
  });

  it('FAIL when rate_schedule_present expected true but got false', () => {
    const actual: ContractActual = {};
    const expected: ContractExpected = { contract_name: 'Test', rate_schedule_present: true };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'rate_schedule_present')!;
    assert.equal(field.status, 'FAIL');
  });

  it('FAIL on wrong rate row count', () => {
    const actual: ContractActual = {
      fields: { typed_fields: { rate_table: [{ rate_raw: 'x' }] } },
    };
    const expected: ContractExpected = { contract_name: 'Test', rate_row_count: 5 };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'rate_row_count')!;
    assert.equal(field.status, 'FAIL');
  });

  it('PASS rate row count with rate_row_count_exact=false (minimum check)', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { section_signals: { rate_items_detected: 7 } } },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      rate_row_count: 5,
      tolerance: { rate_row_count_exact: false },
    };
    const result = validateContractExtraction(actual, expected);
    const field = result.field_results.find(r => r.field === 'rate_row_count')!;
    assert.equal(field.status, 'PASS');
  });
});

describe('validateContractExtraction — row-level rate comparison', () => {
  const actual: ContractActual = {
    fields: {
      typed_fields: {
        rate_table: [
          { material_type: 'Vegetative', unit: 'per cubic yard', rate_amount: 8.5, rate_raw: '$8.50/cy' },
          { material_type: 'C&D', unit: 'per ton', rate_amount: 12.0, rate_raw: '$12.00/ton' },
        ],
      },
    },
  };

  it('PASS when rate rows match', () => {
    const expected: ContractExpected = {
      contract_name: 'Test',
      rate_rows: [
        { material_type: 'Vegetative', unit: 'per cubic yard', rate_amount: 8.5 },
        { material_type: 'C&D', unit: 'per ton', rate_amount: 12.0 },
      ],
    };
    const result = validateContractExtraction(actual, expected);
    const rowResults = result.field_results.filter(r => r.field.startsWith('rate_rows'));
    assert.ok(rowResults.length === 2);
    assert.ok(rowResults.every(r => r.status === 'PASS'));
  });

  it('FAIL when rate_amount mismatches', () => {
    const expected: ContractExpected = {
      contract_name: 'Test',
      rate_rows: [
        { rate_amount: 99.0 }, // wrong
      ],
    };
    const result = validateContractExtraction(actual, expected);
    const row0 = result.field_results.find(r => r.field === 'rate_rows[0]')!;
    assert.equal(row0.status, 'FAIL');
  });

  it('MISSING when expected row index exceeds actual rows', () => {
    const expected: ContractExpected = {
      contract_name: 'Test',
      rate_rows: [
        { rate_amount: 8.5 },
        { rate_amount: 12.0 },
        { rate_amount: 5.0 }, // index 2 doesn't exist
      ],
    };
    const result = validateContractExtraction(actual, expected);
    const row2 = result.field_results.find(r => r.field === 'rate_rows[2]')!;
    assert.equal(row2.status, 'MISSING');
  });
});

describe('validateContractExtraction — evidence anchors', () => {
  it('PASS when anchor key is present in structured_fields', () => {
    const actual: ContractActual = {
      extraction: {
        evidence_v1: {
          structured_fields: { nte_amount: 500000, contractor_name: 'ABC LLC' },
        },
      },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      expected_anchors: ['nte_amount', 'contractor_name'],
    };
    const result = validateContractExtraction(actual, expected);
    const anchors = result.field_results.filter(r => r.field.startsWith('evidence_anchor'));
    assert.ok(anchors.every(r => r.status === 'PASS'));
  });

  it('MISSING when anchor key is absent', () => {
    const actual: ContractActual = {
      extraction: { evidence_v1: { structured_fields: {} } },
    };
    const expected: ContractExpected = {
      contract_name: 'Test',
      expected_anchors: ['nte_amount'],
    };
    const result = validateContractExtraction(actual, expected);
    const anchor = result.field_results.find(r => r.field === 'evidence_anchor:nte_amount')!;
    assert.equal(anchor.status, 'MISSING');
  });
});

describe('validateContractExtraction — warnings', () => {
  it('includes AI confidence_note in warnings', () => {
    const actual: ContractActual = {
      ai_enrichment: { confidence_note: 'Low confidence on date extraction' },
    };
    const expected: ContractExpected = { contract_name: 'Test' };
    const result = validateContractExtraction(actual, expected);
    assert.ok(result.warnings.some(w => w.includes('Low confidence on date extraction')));
  });

  it('warns when rate schedule detected via text heuristics only', () => {
    const actual: ContractActual = {
      fields: { typed_fields: { rate_table: [{ rate_raw: '$8/cy' }] } },
      extraction: {
        evidence_v1: {
          section_signals: { rate_section_present: false, unit_price_structure_present: false },
        },
      },
    };
    const expected: ContractExpected = { contract_name: 'Test' };
    const result = validateContractExtraction(actual, expected);
    assert.ok(result.warnings.some(w => w.includes('text heuristics only')));
  });

  it('warns when contractor_name sourced from heuristic', () => {
    const actual: ContractActual = {
      extraction: {
        evidence_v1: {
          structured_fields: {
            contractor_name: 'Heuristic Inc',
            contractor_name_source: 'heuristic',
          },
        },
      },
    };
    const expected: ContractExpected = { contract_name: 'Test' };
    const result = validateContractExtraction(actual, expected);
    assert.ok(result.warnings.some(w => w.includes('heuristic pattern match')));
  });
});

describe('validateContractExtraction — only specified fields are checked', () => {
  it('does not check fields absent from expected', () => {
    const actual: ContractActual = {};
    const expected: ContractExpected = { contract_name: 'Minimal', contractor_name: 'Acme LLC' };
    const result = validateContractExtraction(actual, expected);
    // Only contractor_name should be in results (as MISSING)
    assert.ok(result.field_results.length === 1);
    assert.equal(result.field_results[0].field, 'contractor_name');
  });
});

describe('report formatters', () => {
  const minimal: ContractActual = {
    extraction: {
      evidence_v1: {
        structured_fields: { contractor_name: 'Stampede Ventures Inc', nte_amount: 2500000 },
        section_signals: { rate_section_present: true, rate_items_detected: 2 },
      },
    },
  };
  const expected: ContractExpected = {
    contract_name: 'EMERG03',
    contractor_name: 'Stampede Ventures',
    not_to_exceed_amount: 2500000,
    rate_schedule_present: true,
  };

  it('formatTerminalReport returns a non-empty string', () => {
    const result = validateContractExtraction(minimal, expected);
    const report = formatTerminalReport(result);
    assert.ok(typeof report === 'string' && report.length > 50);
    assert.ok(report.includes('EMERG03'));
  });

  it('formatMarkdownSummary returns markdown table', () => {
    const result = validateContractExtraction(minimal, expected);
    const md = formatMarkdownSummary(result);
    assert.ok(md.includes('## '));
    assert.ok(md.includes('| Field |'));
    assert.ok(md.includes('EMERG03'));
  });
});
