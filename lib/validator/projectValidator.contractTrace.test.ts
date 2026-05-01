import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildPersistedContractValidationContextFromTrace,
  extractCanonicalContractFacts,
} from '@/lib/validator/projectValidator';
import type { ContractAnalysisResult } from '@/lib/contracts/types';

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
});
