import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildValidationSummary,
  findFirstFactRecord,
  makeFinding,
  type ValidatorFactRecord,
  type ValidatorFactSource,
} from '@/lib/validator/shared';

function makeFact(params: {
  source: ValidatorFactSource;
  value: unknown;
}): ValidatorFactRecord {
  return {
    id: `doc-1:${params.source}:contract_ceiling`,
    document_id: 'doc-1',
    key: 'contract_ceiling',
    value: params.value,
    source: params.source,
    field_type: 'currency',
    evidence: [],
  };
}

describe('validator fact priority', () => {
  it('prefers a human override over reviewed and extracted facts', () => {
    const factsByDocumentId = new Map<string, ValidatorFactRecord[]>([
      ['doc-1', [
        makeFact({ source: 'legacy_structured_field', value: 1000 }),
        makeFact({ source: 'normalized_row', value: 2000 }),
        makeFact({ source: 'human_review', value: 3000 }),
        makeFact({ source: 'human_override', value: 4000 }),
      ]],
    ]);

    const fact = findFirstFactRecord(
      factsByDocumentId,
      ['doc-1'],
      ['contract_ceiling'],
    );

    assert.equal(fact?.source, 'human_override');
    assert.equal(fact?.value, 4000);
  });

  it('prefers a human review over normalized extraction when no override exists', () => {
    const factsByDocumentId = new Map<string, ValidatorFactRecord[]>([
      ['doc-1', [
        makeFact({ source: 'legacy_typed_field', value: 1000 }),
        makeFact({ source: 'normalized_row', value: 2000 }),
        makeFact({ source: 'human_review', value: 3000 }),
      ]],
    ]);

    const fact = findFirstFactRecord(
      factsByDocumentId,
      ['doc-1'],
      ['contract_ceiling'],
    );

    assert.equal(fact?.source, 'human_review');
    assert.equal(fact?.value, 3000);
  });

  it('prefers canonical contract intelligence over normalized extraction rows', () => {
    const factsByDocumentId = new Map<string, ValidatorFactRecord[]>([
      ['doc-1', [
        makeFact({ source: 'legacy_structured_field', value: 1000 }),
        makeFact({ source: 'normalized_row', value: 2000 }),
        makeFact({ source: 'canonical_contract_intelligence', value: 3000 }),
      ]],
    ]);

    const fact = findFirstFactRecord(
      factsByDocumentId,
      ['doc-1'],
      ['contract_ceiling'],
    );

    assert.equal(fact?.source, 'canonical_contract_intelligence');
    assert.equal(fact?.value, 3000);
  });

  it('persists contract validation context in the shared validation summary shape', () => {
    const summary = buildValidationSummary([], 'VALIDATED', {
      contractDocumentId: 'contract-doc-1',
      contractValidationContext: {
        document_id: 'contract-doc-1',
        analysis: {
          pricing_model: {
            contract_ceiling_type: {
              value: 'rate_based',
              state: 'explicit',
              confidence: 0.94,
              evidence_anchors: [],
              source_fact_ids: ['contract_ceiling_type'],
            },
          },
        } as never,
        evidence_by_id: new Map(),
      },
    });

    assert.equal(summary.contract_document_id, 'contract-doc-1');
    assert.deepEqual(summary.contract_validation_context, {
      document_id: 'contract-doc-1',
      analysis: {
        pricing_model: {
          contract_ceiling_type: {
            value: 'rate_based',
            state: 'explicit',
            confidence: 0.94,
            evidence_anchors: [],
            source_fact_ids: ['contract_ceiling_type'],
          },
        },
      },
      relationship_context: null,
    });
  });

  it('adds upstream validator exception and inspection fields with evidence basis', () => {
    const warning = makeFinding({
      projectId: 'golden-project',
      ruleId: 'TICKET_INTEGRITY_MISSING_SUPPORT',
      category: 'ticket_integrity',
      severity: 'warning',
      subjectType: 'document',
      subjectId: 'invoice-doc-1',
      field: 'ticket_support',
      expected: 'support complete',
      actual: 'missing disposal site',
      evidence: [{
        evidence_type: 'document_fact',
        source_document_id: 'invoice-doc-1',
        record_id: 'ticket-row-1',
      }],
    });
    const blocker = {
      ...makeFinding({
        projectId: 'golden-project',
        ruleId: 'REQUIRED_SOURCES_INVOICE_SUPPORT_MISSING',
        category: 'required_sources',
        severity: 'critical',
        subjectType: 'document',
        subjectId: 'invoice-doc-2',
        blockedReason: 'Invoice support is missing.',
        evidence: [{
          evidence_type: 'document_fact',
          source_document_id: 'invoice-doc-2',
          record_id: 'invoice-row-1',
        }],
      }),
      linked_action_id: 'action-1',
    };

    const summary = buildValidationSummary([warning, blocker], 'BLOCKED');

    assert.equal(summary.invoice_exception_eligibility?.open_ticket_count, 1);
    assert.equal(summary.invoice_exception_eligibility?.exception_type, 'blocking_validator_exception');
    assert.match(
      summary.invoice_exception_eligibility?.approval_gate_basis ?? '',
      /ticket support does not match/i,
    );
    assert.deepEqual(summary.reviewed_documents_with_warnings, [{
      document_id: 'invoice-doc-1',
      warning_count: 1,
      review_event_source: `validator_finding:${warning.id}`,
    }]);
    assert.deepEqual(summary.first_document_to_inspect, {
      document_id: 'invoice-doc-2',
      risk_reason: 'Invoice support is missing.',
      linked_action_id: 'action-1',
      priority_source: `validator_finding:${blocker.id}`,
    });
  });
});
