import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentIntelligenceOutput } from '../lib/types/documentIntelligence';
import type { IntelligencePersistenceRows } from '../lib/server/intelligenceAdapter';

const { buildDocumentIntelligence } = await import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href,
);
const {
  mapIntelligenceToPersistenceRows,
} = await import(
  new URL('../lib/server/intelligenceAdapter.ts', import.meta.url).href,
);
const { supportsCanonicalIntelligencePersistence } = await import(
  new URL('../lib/canonicalIntelligenceFamilies.ts', import.meta.url).href,
);

test('invoice mismatch and missing contract map to actionable persisted rows', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'invoice',
    documentTitle: 'STL Invoice 20260207.xlsx - AF28021_01INV',
    documentName: 'STL Invoice 20260207.xlsx - AF28021_01INV.pdf',
    projectName: 'St. Louis 0525',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'AF28021',
          vendor_name: 'Stampede Ventures Inc',
          invoice_date: '2026-03-01',
          current_amount_due: 1000,
        },
      },
      extraction: {
        text_preview: 'Original contract sum $800,000',
      },
    },
    relatedDocs: [
      {
        id: 'payrec-1',
        document_type: 'payment_rec',
        name: 'payment rec.pdf',
        title: 'Payment Recommendation',
        extraction: {
          fields: {
            typed_fields: {
              approved_amount: 900,
              vendor_name: 'Stampede Ventures Inc',
              date_of_invoice: '2026-03-01',
            },
          },
          extraction: {
            text_preview: 'Approved amount $900',
          },
        },
      },
    ],
  }) as DocumentIntelligenceOutput;

  assert.equal(intelligence.classification.family, 'invoice');
  assert.ok(supportsCanonicalIntelligencePersistence(intelligence.classification.family));

  const mapped = mapIntelligenceToPersistenceRows({
    documentId: 'doc-1',
    organizationId: 'org-1',
    intelligence,
  }) as IntelligencePersistenceRows;

  const amountVariance = mapped.decisions.find(
    (decision) => decision.decision_type === 'invoice_total',
  );
  const missingContract = mapped.decisions.find(
    (decision) => decision.decision_type === 'linked_contract',
  );
  const amountVarianceDetails = (amountVariance?.details ?? null) as {
    intelligence_status?: string;
    primary_action?: { description?: string };
    project_context?: { label?: string };
  } | null;
  const missingContractDetails = (missingContract?.details ?? null) as {
    intelligence_status?: string;
    primary_action?: { description?: string };
  } | null;

  assert.ok(amountVariance);
  assert.ok(missingContract);
  assert.equal(amountVariance.lifecycle_status, 'open');
  assert.equal(amountVariance.severity, 'critical');
  assert.equal(amountVarianceDetails?.intelligence_status, 'mismatch');
  assert.equal(missingContract.lifecycle_status, 'open');
  assert.equal(missingContract.severity, 'high');
  assert.equal(missingContractDetails?.intelligence_status, 'missing');

  const amountTask = mapped.tasks.find(
    (task) => task.task_type === 'intelligence_invoice_invoice_total_recalculate_invoice',
  );
  const contractTask = mapped.tasks.find(
    (task) => task.task_type === 'intelligence_invoice_linked_contract_attach_contract',
  );

  assert.ok(amountTask);
  assert.ok(contractTask);
  assert.equal(amountTask.title, 'Recalculate invoice total against the approved payment recommendation');
  assert.match(amountTask.description ?? '', /corrected or confirmed/i);
  assert.equal(contractTask.title, 'Attach governing contract to the invoice review record');
  assert.match(contractTask.description ?? '', /governing contract terms and ceilings/i);

  assert.equal(
    amountVarianceDetails?.primary_action?.description,
    'Recalculate invoice AF28021 total against the approved payment recommendation amount $900.00.',
  );
  assert.equal(
    missingContractDetails?.primary_action?.description,
    'Attach the governing contract for invoice AF28021.',
  );
  assert.equal(amountVarianceDetails?.project_context?.label, 'St. Louis 0525');
});

test('canonical family helper includes payment recommendations and excludes generic documents', () => {
  assert.equal(supportsCanonicalIntelligencePersistence('payment_recommendation'), true);
  assert.equal(supportsCanonicalIntelligencePersistence('generic'), false);
});

test('passed readiness decisions are not persisted as open rows', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'EMERG03 Contract',
    documentName: 'contract.pdf',
    projectName: 'EMERG03',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Stampede Ventures Inc',
          nte_amount: 30000000,
          contract_date: '2026-02-01',
        },
      },
      extraction: {
        text_preview: 'The term of this agreement runs from February 1, 2026 through December 31, 2026. Exhibit A rate schedule attached. Not to exceed $30,000,000.',
      },
    },
    relatedDocs: [],
  }) as DocumentIntelligenceOutput;

  assert.equal(intelligence.classification.family, 'contract');
  const mapped = mapIntelligenceToPersistenceRows({
    documentId: 'doc-2',
    organizationId: 'org-1',
    intelligence,
  }) as IntelligencePersistenceRows;

  assert.equal(mapped.decisions.length, 0);
  assert.equal(mapped.tasks.length, 0);
});

test('cross-document persistence records governing document metadata from precedence-aware related docs', () => {
  const relatedDocs = [
    {
      id: 'contract-amendment-1',
      document_type: 'contract',
      name: 'contract-amendment-1.pdf',
      title: 'Contract Amendment 1',
      extraction: {
        fields: {
          typed_fields: {
            vendor_name: 'Stampede Ventures Inc',
            nte_amount: 900,
            contract_date: '2026-03-15',
          },
        },
        extraction: {
          text_preview: 'Contract amendment. Not to exceed $900. Exhibit A rate schedule attached.',
        },
      },
      document_role: 'contract_amendment',
      authority_status: 'active',
      effective_date: '2026-03-15',
      governing_family: 'contract',
      governing_reason: 'role_priority',
      governing_reason_detail: 'Selected because its contract role outranks the other candidate documents.',
      governing_document_id: 'contract-amendment-1',
      considered_document_ids: ['contract-amendment-1', 'base-contract-1'],
      is_governing: true,
    },
  ] as const;

  const intelligence = buildDocumentIntelligence({
    documentType: 'invoice',
    documentTitle: 'Invoice INV-001',
    documentName: 'invoice-inv-001.pdf',
    projectName: 'St. Louis 0525',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'INV-001',
          vendor_name: 'Stampede Ventures Inc',
          current_amount_due: 1000,
          original_contract_sum: 1000,
        },
      },
      extraction: {
        text_preview: 'Application and Certificate for Payment. Original contract sum $1,000.',
      },
    },
    relatedDocs: [...relatedDocs],
  }) as DocumentIntelligenceOutput;

  const mapped = mapIntelligenceToPersistenceRows({
    documentId: 'doc-3',
    organizationId: 'org-1',
    intelligence,
    relatedDocs: [...relatedDocs],
  }) as IntelligencePersistenceRows;

  const ceilingDecision = mapped.decisions.find(
    (decision) => decision.decision_type === 'contract_ceiling_risk',
  );
  assert.ok(ceilingDecision);
  assert.equal(ceilingDecision.details.applied_governing_document_id, 'contract-amendment-1');
  assert.equal(ceilingDecision.details.governing_family, 'contract');
  assert.equal(ceilingDecision.details.governing_reason, 'role_priority');
  assert.deepEqual(
    ceilingDecision.details.supporting_document_ids_considered,
    ['contract-amendment-1', 'base-contract-1'],
  );

  const relatedTask = mapped.tasks.find(
    (task) => task.related_decision_identity_key === ceilingDecision.identity_key,
  );
  assert.ok(relatedTask);
  assert.equal(relatedTask.details.applied_governing_document_id, 'contract-amendment-1');
  assert.equal(relatedTask.source_metadata.governing_family, 'contract');
});
