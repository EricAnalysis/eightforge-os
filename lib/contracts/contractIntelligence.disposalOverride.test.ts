import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { analyzeContractIntelligence } from '@/lib/contracts/analyzeContractIntelligence';
import type { NormalizedNodeDocument, PipelineFact } from '@/lib/pipeline/types';

function minimalPipelineFact(factKey: string, factValue: unknown): PipelineFact {
  return {
    id: `fact-${factKey}`,
    key: factKey,
    label: factKey,
    value: factValue,
    display_value: String(factValue ?? ''),
    confidence: 1,
    evidence_refs: [],
    gap_refs: [],
    missing_source_context: [],
    source_document_id: 'test-doc',
    document_family: 'contract',
  };
}

function makeContractDocument(params: {
  textPreview?: string;
  factMap?: Record<string, PipelineFact>;
  sectionSignals?: Record<string, unknown>;
  typedFields?: Record<string, unknown>;
  structuredFields?: Record<string, unknown>;
}): NormalizedNodeDocument {
  const factMap = params.factMap ?? {};
  return {
    document_id: 'test-contract-doc',
    document_type: 'contract',
    document_name: 'test-contract.pdf',
    document_title: 'Test Contract',
    family: 'contract',
    is_primary: true,
    extraction_data: null,
    typed_fields: { vendor_name: 'Test Vendor', ...params.typedFields },
    structured_fields: params.structuredFields ?? {},
    section_signals: { fema_reference_present: true, ...params.sectionSignals },
    text_preview: params.textPreview ?? '',
    evidence: [],
    gaps: [],
    confidence: 1,
    content_layers: null,
    extracted_record: {},
    facts: Object.values(factMap),
    fact_map: factMap,
  };
}

describe('disposal_fee_treatment fact_map override', () => {
  it('uses fact_map override value instead of pattern detection when override is present', () => {
    const doc = makeContractDocument({
      textPreview:
        'Tipping fees for vegetative, mixed, and C&D debris are pass-through costs '
        + 'billed at actual disposal site charges without markup.',
      factMap: {
        disposal_fee_treatment: minimalPipelineFact('disposal_fee_treatment', 'split'),
      },
    });

    const analysis = analyzeContractIntelligence({ primaryDocument: doc, relatedDocuments: [] });
    assert.ok(analysis, 'Expected analysis to be produced.');
    assert.equal(
      analysis.pricing_model.disposal_fee_treatment?.value,
      'split',
      'Override value "split" should take precedence over pass_through pattern detection.',
    );
    assert.equal(analysis.pricing_model.disposal_fee_treatment?.state, 'explicit');
  });

  it('falls back to pattern detection when no fact_map override exists', () => {
    const doc = makeContractDocument({
      textPreview:
        'Tipping fees for vegetative, mixed, and C&D debris are pass-through costs '
        + 'billed at actual disposal site charges without markup.',
      factMap: {},
    });

    const analysis = analyzeContractIntelligence({ primaryDocument: doc, relatedDocuments: [] });
    assert.ok(analysis, 'Expected analysis to be produced.');
    assert.equal(
      analysis.pricing_model.disposal_fee_treatment?.value,
      'pass_through',
      'Without override, pattern detection should identify pass_through treatment.',
    );
    assert.equal(analysis.pricing_model.disposal_fee_treatment?.state, 'explicit');
  });

  it('produces missing_critical state when no override and no pattern match', () => {
    const doc = makeContractDocument({
      textPreview: 'The contractor shall remove all eligible debris from public rights-of-way.',
      factMap: {},
    });

    const analysis = analyzeContractIntelligence({ primaryDocument: doc, relatedDocuments: [] });
    assert.ok(analysis, 'Expected analysis to be produced.');
    assert.equal(analysis.pricing_model.disposal_fee_treatment?.value, null);
    assert.equal(analysis.pricing_model.disposal_fee_treatment?.state, 'missing_critical');
  });
});

describe('confirmedDisposalTreatmentResolved suppression', () => {
  const rateScheduleFact = minimalPipelineFact('rate_schedule_present', true);

  it('suppresses pricing_applicability_requires_context with disposal-treatment-specific message when confirmedDisposalTreatmentResolved is true', () => {
    const doc = makeContractDocument({
      textPreview:
        'The Contractor shall remove all eligible debris. Disposal fees are split between '
        + 'transport costs governed by Exhibit A and pass-through tipping fees.',
      sectionSignals: { rate_section_present: true, fema_reference_present: true },
      factMap: {
        rate_schedule_present: rateScheduleFact,
        disposal_fee_treatment: minimalPipelineFact('disposal_fee_treatment', 'split'),
      },
    });

    const analysis = analyzeContractIntelligence({
      primaryDocument: doc,
      relatedDocuments: [],
      confirmedDisposalTreatmentResolved: true,
    });
    assert.ok(analysis, 'Expected analysis to be produced.');

    const issueIds = analysis.issues.map((i) => i.issue_id);
    assert.ok(
      !issueIds.includes('pricing_applicability_requires_context'),
      'pricing_applicability_requires_context should be suppressed when confirmedDisposalTreatmentResolved is true.',
    );

    const suppressed = analysis.trace_summary.suppressed_issues.find(
      (i) => i.issue_id === 'pricing_applicability_requires_context',
    );
    assert.ok(suppressed, 'Suppressed trace should record the pricing_applicability_requires_context entry.');
    assert.ok(
      suppressed.reason.includes('disposal fee treatment'),
      `Suppression reason should reference disposal fee treatment, got: "${suppressed.reason}"`,
    );
    assert.ok(
      !suppressed.reason.includes('rate schedule kind'),
      'Disposal-path suppression reason should not mention rate schedule kind.',
    );
  });

  it('does not suppress pricing_applicability_requires_context when confirmedDisposalTreatmentResolved is false and ambiguity exists', () => {
    const doc = makeContractDocument({
      textPreview:
        'The Contractor shall remove all eligible debris. Disposal fees are split between '
        + 'transport costs governed by Exhibit A and pass-through tipping fees.',
      sectionSignals: { rate_section_present: true, fema_reference_present: true },
      factMap: {
        rate_schedule_present: rateScheduleFact,
        disposal_fee_treatment: minimalPipelineFact('disposal_fee_treatment', 'split'),
      },
    });

    const analysis = analyzeContractIntelligence({
      primaryDocument: doc,
      relatedDocuments: [],
      confirmedDisposalTreatmentResolved: false,
    });
    assert.ok(analysis, 'Expected analysis to be produced.');

    const issueIds = analysis.issues.map((i) => i.issue_id);
    assert.ok(
      issueIds.includes('pricing_applicability_requires_context'),
      'pricing_applicability_requires_context should still be raised when confirmedDisposalTreatmentResolved is false.',
    );
  });
});

describe('confirmedGoverningScheduleResolved regression (unchanged path)', () => {
  const rateScheduleFact = minimalPipelineFact('rate_schedule_present', true);

  it('still suppresses pricing_applicability_requires_context via confirmedGoverningScheduleResolved with original message', () => {
    const doc = makeContractDocument({
      textPreview:
        'Tipping fees for vegetative, mixed, and C&D debris are pass-through costs '
        + 'billed at actual disposal site charges without markup.',
      sectionSignals: { rate_section_present: true, fema_reference_present: true },
      factMap: {
        rate_schedule_present: rateScheduleFact,
        disposal_fee_treatment: minimalPipelineFact('disposal_fee_treatment', 'pass_through'),
      },
    });

    const analysis = analyzeContractIntelligence({
      primaryDocument: doc,
      relatedDocuments: [],
      confirmedGoverningScheduleResolved: true,
      confirmedDisposalTreatmentResolved: false,
    });
    assert.ok(analysis, 'Expected analysis to be produced.');

    const issueIds = analysis.issues.map((i) => i.issue_id);
    assert.ok(
      !issueIds.includes('pricing_applicability_requires_context'),
      'pricing_applicability_requires_context should be suppressed via confirmedGoverningScheduleResolved.',
    );

    const suppressed = analysis.trace_summary.suppressed_issues.find(
      (i) => i.issue_id === 'pricing_applicability_requires_context',
    );
    assert.ok(suppressed, 'Suppressed trace should contain pricing_applicability_requires_context entry.');
    assert.ok(
      suppressed.reason.includes('rate schedule kind'),
      `Governing-schedule suppression reason should mention rate schedule kind, got: "${suppressed.reason}"`,
    );
  });
});

describe('Williamson split-pricing end-to-end scenario', () => {
  it('suppresses pricing_applicability_requires_context when disposal_fee_treatment overridden to "split" with confirmedDisposalTreatmentResolved', () => {
    const rateScheduleFact = minimalPipelineFact('rate_schedule_present', true);
    const disposalFact = minimalPipelineFact('disposal_fee_treatment', 'split');

    const doc = makeContractDocument({
      textPreview:
        'Final disposal hauling and transport is governed by the unit-price-by-CYD-mileage '
        + 'schedule in Exhibit A. Tipping fees for vegetative, mixed, and C&D debris are '
        + 'pass-through costs billed at actual disposal site charges.',
      sectionSignals: {
        rate_section_present: true,
        fema_reference_present: true,
        rate_section_pages: [3],
        rate_section_label: 'Exhibit A Unit Price Schedule',
      },
      factMap: {
        rate_schedule_present: rateScheduleFact,
        disposal_fee_treatment: disposalFact,
      },
    });

    const analysis = analyzeContractIntelligence({
      primaryDocument: doc,
      relatedDocuments: [],
      confirmedDisposalTreatmentResolved: true,
    });
    assert.ok(analysis, 'Expected analysis to be produced.');

    assert.equal(
      analysis.pricing_model.disposal_fee_treatment?.value,
      'split',
      'Williamson override value "split" should be reflected in the analysis.',
    );

    const issueIds = analysis.issues.map((i) => i.issue_id);
    assert.ok(
      !issueIds.includes('pricing_applicability_requires_context'),
      'pricing_applicability_requires_context should be suppressed for the Williamson split-pricing scenario.',
    );

    const suppressed = analysis.trace_summary.suppressed_issues.find(
      (i) => i.issue_id === 'pricing_applicability_requires_context',
    );
    assert.ok(suppressed, 'Suppressed trace must contain the pricing issue entry.');
    assert.ok(
      suppressed.reason.includes('disposal fee treatment'),
      `Expected disposal-treatment suppression reason, got: "${suppressed.reason}"`,
    );
  });
});
