import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  forgeDecisionGenerator,
  generateForgeDecisionsForDocument,
  type ForgeDecisionGeneratorInput,
} from './forgeDecisionGenerator';

function makeAnchor(id: string, page: number, snippet: string) {
  return { id, page, snippet };
}

describe('forgeDecisionGenerator', () => {
  it('ports the HTML question generator heuristics into Forge decisions', () => {
    const input: ForgeDecisionGeneratorInput = {
      documentId: 'doc-html-port',
      documentTitle: 'Williamson Emergency Contract',
      documentType: 'contract',
      facts: {
        contractor_name: {
          value: 'ABC Highway Services, Inc.',
          confidence: 0.62,
          anchors: [makeAnchor('a4', 9, 'CONTRACTOR: ABC Highway Services, Inc.')],
        },
        executed_date: {
          value: '2025-03-05',
          confidence: 0.91,
          anchors: [makeAnchor('a1', 1, 'Executed this 5th day of March, 2025')],
        },
        term_end_date: {
          value: '2025-06-03',
          confidence: 0.54,
          anchors: [makeAnchor('a2', 2, 'effective for a period of ninety (90) days from the date it is fully executed')],
        },
        term_clause: {
          value: true,
          confidence: 0.7,
          anchors: [makeAnchor('a2', 2, 'effective for a period of ninety (90) days from the date it is fully executed')],
        },
        rate_schedule: {
          value: true,
          confidence: 0.8,
          anchors: [makeAnchor('a3', 7, 'The following not-to-exceed rates shall apply')],
        },
        contract_ceiling: {
          value: null,
          confidence: 0.74,
          anchors: [makeAnchor('a3', 7, 'The following not-to-exceed rates shall apply')],
          machine_classification: 'rate_price_no_ceiling',
        },
      },
      missingFields: ['contract_ceiling', 'expiration_date'],
      derivedFields: [
        {
          field: 'term_end_date',
          source_field: 'executed_date',
          logic: '90 days from fully executed date',
          value: '2025-06-03',
          anchors: [makeAnchor('a2', 2, 'effective for a period of ninety (90) days from the date it is fully executed')],
        },
      ],
      conflicts: [
        {
          field: 'contractor_name',
          candidates: [
            'ABC Highway Services, Inc.',
            'Florida Department of Transportation',
          ],
          reason: 'owner-vs-contractor ambiguity',
          anchors: [makeAnchor('a4', 9, 'CONTRACTOR: ABC Highway Services, Inc.')],
        },
      ],
      patterns: [
        'duration_from_execution',
        'not_to_exceed_rates_only',
        'signature_block_contractor',
      ],
    };

    const decisions = forgeDecisionGenerator(input);

    assert.ok(
      decisions.some((decision) =>
        decision.field === 'contract_ceiling_type'
        && decision.severity === 'review'
        && /rate-based not-to-exceed schedule/i.test(decision.prompt),
      ),
    );
    assert.ok(
      decisions.some((decision) =>
        decision.field === 'expiration_date'
        && decision.answer_type === 'select: derive / enter explicit date / mark absent',
      ),
    );
    assert.ok(
      decisions.some((decision) =>
        decision.field === 'term_end_date'
        && /Derived value requires operator validation/i.test(decision.reason),
      ),
    );
    assert.ok(
      decisions.some((decision) =>
        decision.field === 'contractor_name'
        && /Low-confidence contractor_name/i.test(decision.reason),
      ),
    );
    assert.ok(
      decisions.some((decision) =>
        decision.field === 'contractor_name'
        && /Conflicting evidence detected/i.test(decision.reason),
      ),
    );
  });

  it('generates decisions from a realistic contract extraction path', () => {
    const decisions = generateForgeDecisionsForDocument({
      documentId: 'doc-real-contract',
      documentName: 'williamson-contract.pdf',
      documentTitle: 'Williamson Contract',
      documentType: 'contract',
      projectName: 'Storm Debris Cleanup',
      preferredExtractionData: {
        fields: {
          typed_fields: {
            vendor_name: 'R & J Land Clearing LLC',
            contract_date: '3/15/2025',
          },
        },
        extraction: {
          text_preview: [
            'CONTRACTOR: R & J Land Clearing LLC',
            'Exhibit A emergency debris removal unit rates.',
            'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
            'The contract is effective for a period of ninety (90) days from the date it is fully executed.',
          ].join('\n'),
          evidence_v1: {
            structured_fields: {
              contractor_name_source: 'explicit_definition',
            },
            section_signals: {
              rate_section_present: true,
              unit_price_structure_present: true,
              rate_section_pages: [7],
            },
          },
          content_layers_v1: {
            pdf: {
              evidence: [
                {
                  id: 'ev-contractor',
                  kind: 'text',
                  source_type: 'pdf',
                  description: 'Contractor block',
                  text: 'CONTRACTOR: R & J Land Clearing LLC',
                  location: { page: 1, label: 'Page 1' },
                  confidence: 0.99,
                  weak: false,
                  source_document_id: 'doc-real-contract',
                },
                {
                  id: 'ev-term',
                  kind: 'text',
                  source_type: 'pdf',
                  description: 'Term clause',
                  text: 'The contract is effective for a period of ninety (90) days from the date it is fully executed.',
                  location: { page: 2, label: 'Page 2' },
                  confidence: 0.98,
                  weak: false,
                  source_document_id: 'doc-real-contract',
                },
                {
                  id: 'ev-rate',
                  kind: 'text',
                  source_type: 'pdf',
                  description: 'Rate schedule',
                  text: 'Exhibit A emergency debris removal unit rates.',
                  location: { page: 7, label: 'Page 7' },
                  confidence: 0.97,
                  weak: false,
                  source_document_id: 'doc-real-contract',
                },
                {
                  id: 'ev-rate-nte',
                  kind: 'text',
                  source_type: 'pdf',
                  description: 'Rate ceiling clause',
                  text: 'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
                  location: { page: 7, label: 'Page 7' },
                  confidence: 0.98,
                  weak: false,
                  source_document_id: 'doc-real-contract',
                },
              ],
            },
          },
        },
      },
      executionTrace: {
        facts: {
          contractor_name: 'R & J Land Clearing LLC',
          executed_date: '2025-03-15',
          term_end_date: '2025-06-13',
          expiration_date: '2025-06-13',
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-03-29T16:00:00Z',
        engine_version: 'document_intelligence:v2',
      },
    });

    assert.ok(
      decisions.some((decision) =>
        decision.field === 'contract_ceiling_type'
        && decision.severity === 'review'
        && decision.anchors.some((anchor) => anchor.id === 'ev-rate-nte'),
      ),
    );
    assert.ok(!decisions.some((decision) => decision.field === 'contract_ceiling'));
    assert.ok(
      decisions.some((decision) =>
        (decision.field === 'term_end_date' || decision.field === 'expiration_date')
        && /Confirm the derived/i.test(decision.prompt),
      ),
    );
    assert.ok(
      decisions.some((decision) =>
        decision.anchors.some((anchor) => anchor.id === 'ev-term'),
      ),
    );
  });
});
