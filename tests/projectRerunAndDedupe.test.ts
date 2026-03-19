import assert from 'node:assert/strict';
import test from 'node:test';

const { getProjectRerunStoredDocTypes } = await import(
  new URL('../lib/pipeline/projectRerun.ts', import.meta.url).href,
);

const { buildDocumentIntelligence } = await import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href,
);

import type { DocumentIntelligenceOutput } from '../lib/types/documentIntelligence';

test('project rerun targeting expands stored doc types (contract → invoice + ticket)', () => {
  const targets = getProjectRerunStoredDocTypes({
    changedDocumentType: 'contract',
    trigger: 'document_uploaded',
  });

  // Contract influences invoice + ticket; stored ticket may be "ticket" or "debris_ticket".
  assert.ok(targets.includes('invoice'));
  assert.ok(targets.includes('ticket'));
  assert.ok(targets.includes('debris_ticket'));
});

test('stable task dedupe uses machine keys (builder + rule emit same taskType once)', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'invoice',
    documentTitle: 'Williamson County Invoice Package',
    documentName: 'invoice.pdf',
    projectName: 'Williamson Co TN',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'INV-001',
          vendor_name: 'Aftermath Disaster Recovery Inc',
          invoice_date: '2026-03-18',
          current_amount_due: 1000,
        },
      },
      extraction: { text_preview: '' },
    },
    // Important: include a related doc (contract) so cross-document rules run,
    // but do NOT include payment_rec, so both builder and rule can request it.
    relatedDocs: [
      {
        id: 'contract-1',
        document_type: 'contract',
        name: 'contract.pdf',
        title: 'Contract',
        extraction: {
          fields: { typed_fields: { vendor_name: 'Aftermath Disaster Recovery Inc', nte_amount: 5000000 } },
          extraction: { text_preview: 'Not to exceed $5,000,000' },
        },
      },
    ],
  }) as DocumentIntelligenceOutput;

  const keys = intelligence.tasks.map((t) => t.dedupeKey).filter(Boolean);
  const uploadPayRecTasks = keys.filter((k) => k === 'taskType:upload_payment_rec');
  assert.equal(uploadPayRecTasks.length, 1);
});

