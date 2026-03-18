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
    documentTitle: 'EMERG03 Invoice Package',
    documentName: 'invoice.pdf',
    projectName: 'EMERG03',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'EMERG03-001',
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
    (decision) => decision.decision_type === 'amount_matches_payment_recommendation',
  );
  const missingContract = mapped.decisions.find(
    (decision) => decision.decision_type === 'contract_ceiling_risk',
  );

  assert.ok(amountVariance);
  assert.ok(missingContract);
  assert.equal(amountVariance.lifecycle_status, 'open');
  assert.equal(amountVariance.severity, 'critical');
  assert.equal(amountVariance.details.intelligence_status, 'mismatch');
  assert.equal(missingContract.lifecycle_status, 'open');
  assert.equal(missingContract.severity, 'high');
  assert.equal(missingContract.details.intelligence_status, 'missing');

  const amountTask = mapped.tasks.find(
    (task) => task.task_type === 'intelligence_invoice_amount_matches_payment_recommendation',
  );
  const contractTask = mapped.tasks.find(
    (task) => task.task_type === 'intelligence_invoice_contract_ceiling_risk',
  );

  assert.ok(amountTask);
  assert.ok(contractTask);
  assert.equal(amountTask.title, 'Verify invoice due matches approved recommendation');
  assert.match(amountTask.description ?? '', /Invoice current due/);
  assert.equal(contractTask.title, 'Attach linked contract for ceiling validation');
  assert.match(contractTask.description ?? '', /No contract was found/);
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
        },
      },
      extraction: {
        text_preview: 'Exhibit A rate schedule attached. Not to exceed $30,000,000.',
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
