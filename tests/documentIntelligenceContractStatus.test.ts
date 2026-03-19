import assert from 'node:assert/strict';
import test from 'node:test';

const intelligenceModulePromise = import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href
).then((module) => module.default ?? module);
const extractionModulePromise = import(
  new URL('../lib/server/documentExtraction.ts', import.meta.url).href
).then((module) => module.default ?? module);

const openingClauseText = [
  'CONTRACT BETWEEN WILLIAMSON COUNTY, TENNESSEE AND | AFTERMATH DISASTER RECOVERY, INC.',
  'THIS CONTRACT ("Contract") is made by and between Williamson County, Tennessee,',
  'a governmental entity of the State of Tennessee, and | Aftermath Disaster Recovery, Inc.,',
  '(hereinafter "Contractor"), on this 19 day of February, 2026.',
].join(' ');

test('contract extraction captures contractor from opening party language', async () => {
  const { extractDocument } = await extractionModulePromise;
  const payload = await extractDocument(
    {
      id: 'doc-contract-party',
      title: 'Williamson Contract',
      name: 'williamson-contract.txt',
      document_type: 'contract',
      storage_path: 'contracts/williamson-contract.txt',
    },
    new TextEncoder().encode(openingClauseText).buffer,
    'text/plain',
    'williamson-contract.txt',
  );

  const typed = payload.fields.typed_fields as { vendor_name?: string | null } | null;
  assert.equal(typed?.vendor_name, 'Aftermath Disaster Recovery, Inc.');
});

test('contract intelligence infers contractor from opening clause when typed fields miss it', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'Williamson County Contract',
    documentName: 'williamson-contract.pdf',
    projectName: 'Williamson Co',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: null,
          contract_date: '2026-02-19',
        },
      },
      extraction: { text_preview: openingClauseText },
    },
    relatedDocs: [],
  });

  assert.equal(intelligence.classification.family, 'contract');
  assert.equal(
    (intelligence.extracted as { contractorName?: string }).contractorName,
    'Aftermath Disaster Recovery, Inc.',
  );
});

test('contract status chip does not report all clear when missing issues exist', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'Williamson County Contract',
    documentName: 'williamson-contract.pdf',
    projectName: 'Williamson Co',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: null,
          contract_date: '2026-02-19',
        },
      },
      extraction: { text_preview: 'This contract references Williamson County only.' },
    },
    relatedDocs: [],
  });

  const statusChip = intelligence.entities.find((entity) => entity.key === 'status');

  assert.ok(intelligence.summary.headline.includes('Contract needs review'));
  assert.equal(statusChip?.value, 'Needs review');
  assert.notEqual(statusChip?.value, 'All checks passed');
});
