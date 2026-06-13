import assert from 'node:assert/strict';
import test from 'node:test';

const intelligenceModulePromise = import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href,
).then((module) => module.default ?? module);
const decisionActionsModulePromise = import(
  new URL('../lib/decisionActions.ts', import.meta.url).href,
).then((module) => module.default ?? module);

function buildStlInvoiceWithSparseContract(buildDocumentIntelligence: (input: any) => any) {
  return buildDocumentIntelligence({
    documentType: 'invoice',
    documentTitle: 'STL Invoice 20260207.xlsx - AF28021_01INV',
    documentName: 'STL Invoice 20260207.xlsx - AF28021_01INV.pdf',
    projectName: 'St. Louis 0525',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'AF28021',
          vendor_name: 'Acme Debris Removal',
          invoice_date: '2026-02-07',
          current_amount_due: 76359.62,
        },
      },
      extraction: {
        text_preview: 'Original contract sum $80,000,000',
      },
    },
    relatedDocs: [
      {
        id: 'contract-1',
        document_type: 'contract',
        name: 'St Louis MO 0525_St Louis LGS Storms Tornadoes 0525_Contract_1.pdf',
        title: 'St Louis MO 0525_St Louis LGS Storms Tornadoes 0525_Contract_1',
        extraction: {
          fields: {
            typed_fields: {
              vendor_name: 'Acme Debris Removal',
            },
          },
          extraction: {
            text_preview: 'Emergency debris removal agreement for St. Louis with no attached pricing exhibit.',
          },
        },
      },
      {
        id: 'payrec-1',
        document_type: 'payment_rec',
        name: 'AF28021_03REC.pdf',
        title: 'AF28021 Payment Recommendation',
        extraction: {
          fields: {
            typed_fields: {
              approved_amount: 76359.62,
              vendor_name: 'Acme Debris Removal',
              date_of_invoice: '2026-02-07',
            },
          },
          extraction: {
            text_preview: 'Approved amount $76,359.62',
          },
        },
      },
    ],
  });
}

test('missing governing rate mapping generates a concrete STL action', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const intelligence = buildStlInvoiceWithSparseContract(buildDocumentIntelligence);

  const decision = intelligence.decisions.find((item: { field_key?: string }) => item.field_key === 'governing_rates');
  assert.ok(decision);
  assert.equal(
    decision.primary_action?.description,
    'Map billed line items on invoice AF28021 to the governing rate schedule for contract for St. Louis 0525.',
  );
});

test('contract ceiling mismatch generates a concrete STL action', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const intelligence = buildDocumentIntelligence({
    documentType: 'contract',
    documentTitle: 'St Louis MO 0525_St Louis LGS Storms Tornadoes 0525_Contract_1',
    documentName: 'St Louis MO 0525_St Louis LGS Storms Tornadoes 0525_Contract_1.pdf',
    projectName: 'St. Louis 0525',
    extractionData: {
      fields: {
        typed_fields: {
          vendor_name: 'Acme Debris Removal',
          nte_amount: 30000000,
          contract_date: '2026-02-01',
        },
      },
      extraction: {
        text_preview: 'Compensation shall be based on the unit prices and time-and-materials rates set forth in Exhibit A. Not to exceed $30,000,000.',
      },
    },
    relatedDocs: [
      {
        id: 'invoice-doc-af28021',
        document_type: 'invoice',
        name: 'STL Invoice 20260207.xlsx - AF28021_01INV.pdf',
        title: 'AF28021_01INV',
        extraction: {
          fields: { typed_fields: {} },
          extraction: { text_preview: 'Original contract sum $80,000,000' },
        },
      },
    ],
  });

  const decision = intelligence.decisions.find((item: { field_key?: string }) =>
    item.field_key?.startsWith('contract_ceiling:'),
  );
  assert.ok(decision);
  assert.equal(
    decision.primary_action?.description,
    'Confirm whether invoice AF28021_01INV exceeds the current contract ceiling in contract for St. Louis 0525.',
  );
});

test('decisions without actions are flagged', async () => {
  const { validateDecisionActionCoverage } = await decisionActionsModulePromise;
  const warnings = validateDecisionActionCoverage([
    { title: 'Missing: rate schedule', primary_action: null, action: null },
  ]);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /missing primary action/i);
});

test('covered STL contract and invoice actions are not vague', async () => {
  const { buildDocumentIntelligence } = await intelligenceModulePromise;
  const {
    isVagueDecisionActionDescription,
    validateDecisionActionCoverage,
  } = await decisionActionsModulePromise;
  const intelligence = buildStlInvoiceWithSparseContract(buildDocumentIntelligence);

  const warnings = validateDecisionActionCoverage(intelligence.decisions);
  assert.equal(warnings.length, 0);

  for (const decision of intelligence.decisions) {
    assert.ok(decision.primary_action, `${decision.title} should have a primary action`);
    assert.equal(
      isVagueDecisionActionDescription(decision.primary_action.description),
      false,
      `${decision.title} emitted a vague action`,
    );
  }
});
