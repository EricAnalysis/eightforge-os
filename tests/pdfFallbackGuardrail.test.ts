import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentIntelligenceOutput } from '../lib/types/documentIntelligence';

const { buildDocumentIntelligence } = await import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href,
);

function getDecision(intelligence: DocumentIntelligenceOutput, type: string) {
  return intelligence.decisions.find((d) => d.type === type) ?? null;
}

test('pdf_fallback shallow extraction downgrades rule “missing” to info', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'Contract',
    documentName: 'contract.pdf',
    projectName: null,
    extractionData: {
      fields: {
        typed_fields: {},
      },
      extraction: {
        mode: 'pdf_fallback',
        text_preview: null,
      },
    },
    relatedDocs: [],
  }) as DocumentIntelligenceOutput;

  const nteDecision = getDecision(intelligence, 'ctr_001');
  const contractorDecision = getDecision(intelligence, 'ctr_003');

  assert.ok(nteDecision, 'Expected CTR-001 decision to exist');
  assert.equal(nteDecision!.status, 'info');
  assert.ok(nteDecision!.confidence != null && nteDecision!.confidence < 1, 'Expected downgraded confidence');

  assert.ok(contractorDecision, 'Expected CTR-003 decision to exist');
  assert.equal(contractorDecision!.status, 'info');
});

test('pdf_fallback guardrail does not trigger when structured fields exist', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'Contract',
    documentName: 'contract.pdf',
    projectName: null,
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Aftermath Disaster Recovery, Inc',
        },
      },
      extraction: {
        mode: 'pdf_fallback',
        text_preview: null,
      },
    },
    relatedDocs: [],
  }) as DocumentIntelligenceOutput;

  const nteDecision = getDecision(intelligence, 'ctr_001');
  assert.ok(nteDecision, 'Expected CTR-001 decision to exist');
  assert.equal(nteDecision!.status, 'missing');
});

