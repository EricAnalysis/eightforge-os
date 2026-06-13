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

const williamsonRateAgreementText = [
  openingClauseText,
  'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A.',
  'All rates in Exhibit A shall be considered not-to-exceed rates for emergency response purposes.',
  'Nothing in this Contract or Exhibit A shall be construed to guarantee any minimum amount of work or compensation.',
  'EXHIBIT A EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES.',
  'Tipping Fee - Vegetative | Cubic Yard | Passthrough.',
  'Hazardous Trees 25"-36" trunk diameter | Tree | $316.00.',
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

  const statusChip = intelligence.entities.find((entity: { key: string; value: string }) => entity.key === 'status');

  assert.ok(intelligence.summary.headline.includes('Contract needs review'));
  assert.equal(statusChip?.value, 'Needs review');
  assert.notEqual(statusChip?.value, 'All checks passed');
});

test('unit-rate Williamson contract does not invent an overall NTE or numeric tip fee', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'Williamson County Contract',
    documentName: 'williamson-contract.pdf',
    projectName: 'Williamson Co',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Aftermath Disaster Recovery, Inc.',
        },
      },
      extraction: { text_preview: williamsonRateAgreementText },
    },
    relatedDocs: [],
  });

  const extracted = intelligence.extracted as {
    contractorName?: string;
    notToExceedAmount?: number;
    contractCeilingType?: string;
    contractCeilingDisplay?: string;
    contractCeiling?: string;
    rateSchedulePresent?: boolean;
    tipFee?: number;
  };

  assert.equal(extracted.contractorName, 'Aftermath Disaster Recovery, Inc.');
  assert.equal(extracted.rateSchedulePresent, true);
  assert.equal(extracted.notToExceedAmount, undefined);
  assert.equal(extracted.contractCeilingType, 'rate_based');
  assert.equal(extracted.contractCeilingDisplay, 'Rate based ceiling per schedule');
  assert.equal(
    extracted.contractCeiling,
    'No total ceiling stated; Exhibit A rates are not to exceed',
  );
  assert.equal(extracted.tipFee, undefined);
  assert.equal(intelligence.entities.some((entity: { key: string }) => entity.key === 'nte'), false);
  assert.equal(
    intelligence.entities.some((entity: { key: string; value: string }) =>
      entity.key === 'contract_ceiling' && entity.value === 'Rate based ceiling per schedule'),
    true,
  );
  assert.equal(intelligence.decisions.some((d: { title: string }) => d.title === 'Missing rate schedule (Exhibit A)'), false);
  assert.equal(intelligence.decisions.some((d: { title: string }) => d.title === 'Tip fee detected'), false);
  assert.equal(intelligence.decisions.some((d: { title: string }) => d.title === 'No overall contract ceiling detected'), false);
  assert.equal(
    intelligence.decisions.some((d: { field_key?: string; observed_value?: string | number | null }) =>
      d.field_key === 'contract_ceiling' && d.observed_value === 'Rate based ceiling per schedule'),
    true,
  );
});
