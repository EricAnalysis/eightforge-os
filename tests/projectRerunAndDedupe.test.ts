import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildDocumentIntelligence } from '../lib/documentIntelligence';
import { getProjectRerunStoredDocTypes } from '../lib/pipeline/projectRerun';
import type { DocumentIntelligenceOutput } from '../lib/types/documentIntelligence';

describe('project rerun and task dedupe', () => {
  it('project rerun targeting expands stored doc types (contract → invoice + ticket)', () => {
    const targets = getProjectRerunStoredDocTypes({
      changedDocumentType: 'contract',
      trigger: 'document_uploaded',
    });

    // Contract influences invoice + ticket; stored ticket may be "ticket" or "debris_ticket".
    assert.ok(targets.includes('invoice'));
    assert.ok(targets.includes('ticket'));
    assert.ok(targets.includes('debris_ticket'));
  });

  it('stable task dedupe uses machine keys (canonical invoice matches rule taskType)', () => {
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
      // Related contract exercises cross-doc context; no payment_rec so upload task is justified.
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

    // Evidence-grounded fact: no linked payment recommendation in the package.
    assert.equal(intelligence.facts?.linked_payment_recommendation_present, false);

    // Task must come from canonical structured decision (applyRuleEngine skips invoice — no rule merge).
    const payRecGap = intelligence.decisions.find((d) => d.rule_id === 'invoice_payment_recommendation_missing');
    assert.ok(payRecGap, 'expected canonical missing pay-rec decision');
    assert.ok(
      (payRecGap?.fact_refs ?? []).includes('linked_payment_recommendation_present'),
      'decision should cite the presence fact',
    );
    assert.ok(payRecGap?.relatedTaskIds?.length, 'decision should link to a workflow task');

    const keys = intelligence.tasks.map((t) => t.dedupeKey).filter(Boolean);
    const uploadPayRecTasks = keys.filter((k) => k === 'taskType:upload_payment_rec');
    assert.equal(uploadPayRecTasks.length, 1);

    const uploadTask = intelligence.tasks.find((t) => t.dedupeKey === 'taskType:upload_payment_rec');
    assert.ok(
      uploadTask?.title.toLowerCase().includes('payment recommendation'),
      'task title should name the concrete document gap',
    );
  });
});
