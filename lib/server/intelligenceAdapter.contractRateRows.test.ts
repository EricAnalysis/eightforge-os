import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { mapIntelligenceToPersistenceRows } from '@/lib/server/intelligenceAdapter';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
import type { DocumentIntelligenceOutput } from '@/lib/types/documentIntelligence';

const CONTRACT_ANALYSIS = {
  pricing_model: {
    rate_schedule_present: {
      value: true,
      confidence: 0.91,
      evidence_anchors: ['ev-rate-1'],
    },
    rate_schedule_pages: {
      value: [7],
      confidence: 0.88,
      evidence_anchors: ['ev-rate-1'],
    },
    pricing_applicability: {
      value: 'unit_rate_schedule_controls_pricing',
      confidence: 0.84,
      evidence_anchors: ['ev-rate-1'],
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
      source_anchor_ids: ['ev-rate-1'],
      rate_raw: 'Vegetative debris haul and reduction $6.90 per cubic yard',
      material_type: 'Vegetative',
      source_category: 'Vegetative',
      canonical_category: 'vegetative_removal',
      category_confidence: 0.96,
      unit_type: 'per cubic yard',
      rate_amount: 6.9,
    },
  ],
} as unknown as ContractAnalysisResult;

function buildContractIntelligenceOutput(): DocumentIntelligenceOutput {
  return {
    classification: {
      family: 'contract',
      label: 'Contract',
    },
    summary: {
      headline: 'Contract analyzed',
      nextAction: 'Review rate schedule',
    },
    keyFacts: [],
    issues: [],
    entities: [],
    decisions: [],
    tasks: [],
    normalizedDecisions: [],
    flowTasks: [],
    facts: {
      contractor_name: 'Acme Debris LLC',
      governing_rate_tables: {
        detected: true,
      },
    },
    suggestedQuestions: [],
    extracted: {
      contractNumber: 'CON-001',
    } as never,
    contractAnalysis: CONTRACT_ANALYSIS,
  };
}

describe('intelligence adapter contract rate schedule persistence', () => {
  it('persists canonical contract rate rows and signals into execution trace facts', () => {
    const rows = mapIntelligenceToPersistenceRows({
      documentId: 'contract-doc',
      organizationId: 'org-1',
      intelligence: buildContractIntelligenceOutput(),
    });

    const facts = rows.executionTrace.facts as Record<string, unknown>;
    const governingRateTables = facts.governing_rate_tables as Record<string, unknown>;

    assert.equal(facts.rate_schedule_present, true);
    assert.deepEqual(facts.rate_schedule_pages, [7]);
    assert.equal(facts.pricing_applicability, 'unit_rate_schedule_controls_pricing');
    assert.equal(facts.rate_row_count, 1);
    assert.ok(Array.isArray(facts.rate_table));
    assert.equal((facts.rate_table as Array<Record<string, unknown>>)[0]?.rate_amount, 6.9);
    assert.equal((facts.rate_table as Array<Record<string, unknown>>)[0]?.canonical_category, 'vegetative_removal');
    assert.equal(governingRateTables.rate_row_count, 1);
    assert.ok(Array.isArray(governingRateTables.rate_schedule_rows));
  });
});
