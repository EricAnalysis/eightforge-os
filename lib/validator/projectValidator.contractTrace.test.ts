import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildPersistedContractValidationContextFromTrace,
  buildRateScheduleItems,
  extractCanonicalContractFacts,
} from '@/lib/validator/projectValidator';
import { evaluateCrossDocumentRateVerification } from '@/lib/validator/rulePacks/crossDocumentRateVerification';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
import type {
  ProjectTotals,
  ProjectValidatorInput,
  ValidatorDocumentIdsByFamily,
  ValidatorFactLookups,
  ValidatorFactRecord,
} from '@/lib/validator/shared';

const CONTRACT_ANALYSIS = {
  pricing_model: {
    contract_ceiling_type: {
      value: 'rate_based',
      confidence: 0.94,
      evidence_anchors: ['ev-contract-rate'],
    },
    rate_schedule_present: {
      value: true,
      confidence: 0.91,
      evidence_anchors: ['ev-contract-rate'],
    },
    rate_schedule_pages: {
      value: [7],
      confidence: 0.88,
      evidence_anchors: ['ev-contract-rate'],
    },
    pricing_applicability: {
      value: 'unit_rate_schedule_controls_pricing',
      confidence: 0.87,
      evidence_anchors: ['ev-contract-rate'],
    },
  },
  rate_schedule_rows: [
    {
      row_id: 'rate_row:1',
      description: 'Vegetative debris haul and reduction',
      unit: 'per cubic yard',
      rate: 6.9,
      category: 'Vegetative',
      page: 7,
      source_anchor_ids: ['ev-contract-rate'],
      rate_raw: 'Vegetative debris haul and reduction $6.90 per cubic yard',
      material_type: 'Vegetative',
      unit_type: 'per cubic yard',
      rate_amount: 6.9,
    },
  ],
} as unknown as ContractAnalysisResult;

describe('project validator contract trace convergence', () => {
  it('extracts canonical contract facts from persisted intelligence trace', () => {
    const facts = extractCanonicalContractFacts({
      id: 'contract-doc',
      document_type: 'contract',
      intelligence_trace: {
        classification: { family: 'contract' },
        facts: {
          contractor_name: 'Acme Debris LLC',
          contract_ceiling: 2500000,
          rate_schedule_present: true,
        },
      },
    });

    assert.deepEqual(facts, [
      { key: 'contractor_name', value: 'Acme Debris LLC' },
      { key: 'contract_ceiling', value: 2500000 },
      { key: 'rate_schedule_present', value: true },
    ]);
  });

  it('builds contract validation context directly from persisted contract analysis', () => {
    const context = buildPersistedContractValidationContextFromTrace({
      id: 'contract-doc',
      document_type: 'contract',
      intelligence_trace: {
        classification: { family: 'contract' },
        contract_analysis: CONTRACT_ANALYSIS,
        evidence: [
          {
            id: 'ev-contract-rate',
            kind: 'text',
            source_type: 'pdf',
            description: 'Rate schedule evidence',
            text: 'Exhibit A rate schedule applies.',
            location: { page: 7, nearby_text: 'Exhibit A rate schedule applies.' },
            confidence: 0.93,
            weak: false,
            source_document_id: 'contract-doc',
          },
        ],
      },
    });

    assert.ok(context);
    assert.equal(context?.document_id, 'contract-doc');
    assert.equal(
      context?.analysis.pricing_model.contract_ceiling_type?.value,
      'rate_based',
    );
    assert.equal(
      context?.analysis.pricing_model.rate_schedule_present?.value,
      true,
    );
    assert.equal(context?.evidence_by_id.get('ev-contract-rate')?.location.page, 7);
    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.rate, 6.9);
    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.page, 7);
  });

  it('uses attached price sheet trace rows for invoice rate authority after governing rows miss', () => {
    const contractContext = buildPersistedContractValidationContextFromTrace({
      id: 'governing-contract',
      document_type: 'contract',
      intelligence_trace: {
        classification: { family: 'contract' },
        contract_analysis: {
          pricing_model: {
            contract_ceiling_type: { value: 'rate_based' },
            rate_schedule_present: { value: true },
          },
          rate_schedule_rows: [],
        },
        evidence: [],
      },
    });
    assert.ok(contractContext);

    const priceSheetFacts = extractCanonicalContractFacts({
      id: 'goodlettsville-price-sheet',
      document_type: 'rate sheet',
      intelligence_trace: {
        classification: { family: 'rate_sheet' },
        facts: {
          rate_table: [
            {
              row_id: 'price-sheet-row:veg-haul',
              description: 'Vegetative debris haul and reduction',
              unit_type: 'CYD',
              rate_amount: 6.9,
              source_category: 'Vegetative',
              source_quality: 'clean',
            },
          ],
          rate_row_count: 1,
          rate_schedule_present: true,
        },
      },
    }).map((fact, index): ValidatorFactRecord => ({
      id: `price-sheet-fact:${index + 1}`,
      document_id: 'goodlettsville-price-sheet',
      key: fact.key,
      value: fact.value,
      source: 'canonical_contract_intelligence',
      field_type: null,
      evidence: [],
    }));
    const factsByDocumentId = new Map<string, ValidatorFactRecord[]>([
      ['goodlettsville-price-sheet', priceSheetFacts],
    ]);
    const rateScheduleItems = buildRateScheduleItems({
      factsByDocumentId,
      rateDocumentIds: ['goodlettsville-price-sheet', 'governing-contract'],
      contractValidationContext: contractContext,
    });
    const familyDocumentIds: ValidatorDocumentIdsByFamily = {
      contract: ['governing-contract'],
      rate_sheet: ['goodlettsville-price-sheet'],
      permit: [],
      invoice: ['invoice-doc'],
      ticket_support: [],
    };
    const projectTotals: ProjectTotals = {
      billed_total: 690,
      invoice_count: 1,
      invoice_line_count: 1,
      mobile_ticket_count: 0,
      load_ticket_count: 0,
    };
    const factLookups: ValidatorFactLookups = {
      contractProjectCodeFacts: [],
      invoiceProjectCodeFacts: [],
      contractPartyNameFacts: [],
      contractIdentityDocumentIds: ['governing-contract'],
      pricingContextDocumentIds: ['goodlettsville-price-sheet'],
      complianceContextDocumentIds: [],
      amendmentContextDocumentIds: [],
      nteFact: null,
      contractDocumentId: 'governing-contract',
      contractCeilingTypeFact: null,
      contractCeilingType: 'rate_based',
      rateSchedulePresentFact: null,
      rateSchedulePresent: true,
      rateRowCountFact: null,
      rateRowCount: 1,
      rateSchedulePagesFact: null,
      rateSchedulePagesDisplay: 'price sheet',
      rateUnitsDetectedFact: null,
      rateUnitsDetected: ['CYD'],
      timeAndMaterialsPresentFact: null,
      timeAndMaterialsPresent: false,
      rateScheduleFacts: priceSheetFacts,
      rateScheduleItems,
      hasRateScheduleFacts: true,
    };
    const input: ProjectValidatorInput = {
      project: {
        id: 'project-goodlettsville',
        organization_id: 'org-1',
        name: 'Goodlettsville',
        code: 'GOODLETTSVILLE',
      },
      validationPhase: 'billing_review',
      documents: [],
      documentRelationships: [{
        id: 'rel-price-sheet',
        project_id: 'project-goodlettsville',
        source_document_id: 'goodlettsville-price-sheet',
        target_document_id: 'governing-contract',
        relationship_type: 'attached_to',
      }],
      precedenceFamilies: [],
      familyDocumentIds,
      governingDocumentIds: familyDocumentIds,
      truthCategoryDocumentIds: {
        contract_identity: ['governing-contract'],
        pricing: ['goodlettsville-price-sheet', 'governing-contract'],
        compliance: [],
        amendments: [],
      },
      ruleStateByRuleId: new Map(),
      factsByDocumentId,
      allFacts: priceSheetFacts,
      mobileTickets: [],
      loadTickets: [],
      invoices: [],
      invoiceLines: [{
        id: 'invoice-line-veg-haul',
        source_document_id: 'invoice-doc',
        invoice_number: 'INV-001',
        description: 'Vegetative debris haul and reduction',
        unit_type: 'CYD',
        unit_price: 6.9,
        quantity: 100,
        line_total: 690,
      }],
      mobileToLoadsMap: new Map(),
      invoiceLineToRateMap: new Map(),
      projectTotals,
      factLookups,
      contractValidationContext: contractContext,
      transactionData: {
        datasets: [],
        rows: [],
        rollups: {
          grouped_by_rate_code: [],
          grouped_by_invoice: [],
          grouped_by_site_material: [],
        },
      },
    };

    const result = evaluateCrossDocumentRateVerification(input);
    const missingContractRate = result.findings.find(
      (finding) => finding.rule_id === 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
    );
    const missingSupport = result.findings.find(
      (finding) => finding.rule_id === 'CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS',
    );

    assert.equal(missingContractRate, undefined);
    assert.equal(result.summary.validation_units[0]?.contract_rate_found, true);
    assert.deepEqual(
      result.summary.validation_units[0]?.source_documents.contract_document_ids,
      ['goodlettsville-price-sheet'],
    );
    assert.ok(missingSupport);
    assert.equal(
      missingSupport.evidence.some(
        (entry) => entry.evidence_type === 'rate_schedule'
          && entry.source_document_id === 'goodlettsville-price-sheet',
      ),
      true,
    );
  });
});
