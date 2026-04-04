import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractAnalysisResult } from '@/lib/contracts/types';
import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';

function runContractAnalysis(params: {
  textPreview: string;
  typedFields?: Record<string, unknown>;
  structuredFields?: Record<string, unknown>;
  sectionSignals?: Record<string, unknown>;
  pageText?: string[];
}): ContractAnalysisResult {
  const result = runDocumentPipeline({
    documentId: 'contract-intel-doc',
    documentType: 'contract',
    documentTitle: 'Emergency Debris Contract',
    documentName: 'emergency-debris-contract.pdf',
    projectName: 'EightForge Test',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Alpha Debris LLC',
          ...params.typedFields,
        },
      },
      extraction: {
        text_preview: params.textPreview,
        evidence_v1: {
          structured_fields: params.structuredFields ?? {},
          section_signals: {
            fema_reference_present: true,
            ...params.sectionSignals,
          },
          page_text: (params.pageText ?? [params.textPreview]).map((text, index) => ({
            page_number: index + 1,
            text,
          })),
        },
      },
    },
    relatedDocs: [],
  });

  assert.ok(result.contractAnalysis, 'Expected contract analysis to be attached to the pipeline result.');
  return result.contractAnalysis;
}

describe('contract intelligence analysis', () => {
  it('keeps execution-based expiration as derived and requires confirmation', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal services are provided under this agreement. '
        + 'The initial term shall be ninety (90) days from the date of execution.',
      structuredFields: {
        executed_date: '2026-01-15',
      },
    });

    assert.equal(analysis.term_model.initial_term_length?.value, '90 days');
    assert.equal(analysis.term_model.expiration_date?.state, 'derived');
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'derived_value_requires_confirmation'),
    );
  });

  it('keeps effective date distinct from work authorization when notice to proceed controls activation', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'This emergency debris removal agreement is effective as of March 1, 2026. '
        + 'Contractor shall commence work only upon written Notice to Proceed. '
        + 'Mobilization shall occur within 72 hours of the Notice to Proceed.',
      typedFields: {
        effective_date: '2026-03-01',
      },
      structuredFields: {
        executed_date: '2026-02-20',
      },
    });

    assert.equal(analysis.contract_identity.effective_date?.value, '2026-03-01');
    assert.equal(analysis.contract_identity.effective_date?.state, 'explicit');
    assert.equal(analysis.activation_model.activation_trigger_type?.value, 'notice_to_proceed');
    assert.equal(analysis.activation_model.activation_trigger_type?.state, 'conditional');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'activation_trigger')
        ?.operator_review_required,
      true,
    );
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'conditional_without_trigger_status'),
    );
  });

  it('allows rate schedule presence while keeping pricing applicability unresolved', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal unit rates are set forth in Exhibit A. '
        + 'Landfill charges shall be reimbursed as pass-through costs. '
        + 'Services shall be authorized by written task order.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [12],
      },
    });

    assert.equal(analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(analysis.pricing_model.pricing_applicability?.state, 'conditional');
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'pricing_applicability_unclear'),
    );
  });

  it('classifies an explicit dollar cap as a total ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices set forth in Exhibit A. '
        + 'The total amount payable under this Agreement shall not exceed $30,000,000.',
      typedFields: {
        nte_amount: 30000000,
      },
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [12],
      },
      pageText: [
        'Compensation shall be based on the unit prices set forth in Exhibit A.',
        'The total amount payable under this Agreement shall not exceed $30,000,000.',
      ],
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'total');
    assert.equal(analysis.pricing_model.contract_ceiling?.value, 30000000);
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      true,
    );
  });

  it('classifies not-to-exceed schedule language as a rate-based ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A. '
        + 'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [8],
      },
      pageText: [
        'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A.',
        'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
      ],
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'rate_based');
    assert.equal(analysis.pricing_model.contract_ceiling?.value, null);
    assert.ok((analysis.pricing_model.contract_ceiling_type?.evidence_anchors.length ?? 0) > 0);
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      true,
    );
  });

  it('keeps truly schedule-only pricing classified as having no explicit ceiling', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Compensation shall be based on the unit prices set forth in Exhibit A. '
        + 'Emergency debris removal unit rates are attached as Exhibit A.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [5],
      },
    });

    assert.equal(analysis.pricing_model.contract_ceiling_type?.value, 'none');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'contract_ceiling')?.found,
      false,
    );
  });

  it('treats FEMA eligibility and monitoring language as operational gates', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Following the storm event, payment is limited to FEMA-eligible work and documented eligible costs. '
        + 'All haul tickets must be verified by the debris monitor and included with each invoice.',
    });

    assert.equal(analysis.documentation_model.monitoring_required?.state, 'conditional');
    assert.equal(analysis.compliance_model.fema_eligibility_gate?.state, 'conditional');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'monitoring_dependency')
        ?.operator_review_required,
      true,
    );
    assert.ok(
      analysis.issues.some((issue) => issue.issue_type === 'documentation_prerequisite_unclear'),
    );
    assert.ok(analysis.issues.some((issue) => issue.issue_type === 'fema_gate_ambiguous'));
  });

  it('selects the role-grounded contractor when weaker typed noise disagrees', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'Emergency debris removal services may be activated following a declared disaster event. '
        + 'Contractor: Beta Debris Services LLC.',
      typedFields: {
        vendor_name: 'Alpha Debris LLC',
      },
      structuredFields: {
        contractor_name: 'Beta Debris Services LLC',
        contractor_name_source: 'explicit_definition',
      },
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Beta Debris Services LLC');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_type !== 'conflicting_evidence'),
    );
  });

  it('resolves Williamson-style OCR contractor drift when one role-grounded candidate is dominant', () => {
    const openingPage = [
      'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND ARTERMATH DISASTER RECOVERY, INC.',
      'This Contract is made by and between Williamson County, Tennessee, and Artermath Disaster Recovery, Inc. (hereinafter "Contractor").',
      'Contractor shall commence work only upon written Notice to Proceed.',
    ].join(' ');

    const analysis = runContractAnalysis({
      textPreview: openingPage,
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'Artermath Disaster Recovery, Inc.',
        contractor_name_source: 'explicit_definition',
      },
      pageText: [
        openingPage,
        'Footer contact: Williamson County procurement office. Prepared by operations support.',
      ],
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_id !== 'contractor_identity_conflict'),
    );
  });

  it('ignores weak footer-style organization noise when a contractor is clearly defined', () => {
    const analysis = runContractAnalysis({
      textPreview: [
        'This Contract is between Example County and Aftermath Disaster Recovery, Inc. (hereinafter "Contractor").',
        'Prepared by WM Gulf Coast Landfill contact desk for routing only.',
      ].join(' '),
      typedFields: {
        vendor_name: 'Aftermath Disaster Recovery, Inc.',
      },
      structuredFields: {
        contractor_name: 'WM Gulf Coast Landfill',
        contractor_name_source: 'heuristic',
      },
      pageText: [
        'This Contract is between Example County and Aftermath Disaster Recovery, Inc. (hereinafter "Contractor"). Contractor shall maintain mobilization readiness.',
        'Prepared by WM Gulf Coast Landfill contact desk for routing only. Footer notes and disposal contact information.',
      ],
    });

    assert.equal(analysis.contract_identity.contractor_name?.state, 'explicit');
    assert.equal(analysis.contract_identity.contractor_name?.value, 'Aftermath Disaster Recovery, Inc.');
    assert.ok(
      analysis.issues.every((issue) => issue.issue_id !== 'contractor_identity_conflict'),
    );
  });

  it('suppresses activation issues when a debris contract lacks actual trigger dependency evidence', () => {
    const analysis = runContractAnalysis({
      textPreview:
        'This emergency debris removal agreement remains in effect for one year. '
        + 'Compensation shall be based on the unit prices set forth in Exhibit A.',
      sectionSignals: {
        rate_section_present: true,
        rate_section_pages: [8],
      },
      structuredFields: {
        executed_date: '2026-04-01',
      },
    });

    assert.equal(analysis.activation_model.activation_trigger_type?.value, null);
    assert.equal(analysis.activation_model.activation_trigger_type?.state, 'missing_critical');
    assert.equal(
      analysis.coverage_status.find((coverage) => coverage.coverage_id === 'activation_trigger')?.found,
      false,
    );
    assert.ok(
      analysis.issues.every(
        (issue) => issue.issue_id !== 'missing_required_clause:activation_trigger',
      ),
    );
    assert.ok(
      analysis.trace_summary.suppressed_issues.some(
        (issue) => issue.issue_id === 'missing_required_clause:activation_trigger',
      ),
    );
  });
});
