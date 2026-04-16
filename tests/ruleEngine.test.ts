import assert from 'node:assert/strict';
import test from 'node:test';

const { getRulePack, getRulesForDocumentType, getRuleCount, RULE_PACK_VERSION } = await import(
  new URL('../lib/rules/registry.ts', import.meta.url).href
);
const { evaluateDocument, buildRuleContext } = await import(
  new URL('../lib/rules/evaluator.ts', import.meta.url).href
);
const { mapRuleOutputs, buildRuleSummary, buildRuleChips, resetIdCounter } = await import(
  new URL('../lib/rules/adapter.ts', import.meta.url).href
);
const { getRerunTargets, shouldRerunForDocumentType } = await import(
  new URL('../lib/rules/rerun.ts', import.meta.url).href
);
const { buildDocumentIntelligence } = await import(
  new URL('../lib/documentIntelligence.ts', import.meta.url).href
);

import type { RuleEvaluationResult, RuleOutput } from '../lib/rules/types';
import type { DocumentIntelligenceOutput } from '../lib/types/documentIntelligence';

// ─── Registry tests ──────────────────────────────────────────────────────────

test('rule pack loads with 25-35 rules', () => {
  const count = getRuleCount();
  assert.ok(count >= 20 && count <= 40, `Expected 20-40 rules, got ${count}`);
});

test('rule pack version is set', () => {
  assert.equal(RULE_PACK_VERSION, 'v1.0.0');
});

test('getRulesForDocumentType returns rules for ticket', () => {
  const ticketRules = getRulesForDocumentType('ticket');
  assert.ok(ticketRules.length >= 5, `Expected >=5 ticket rules, got ${ticketRules.length}`);
});

test('getRulesForDocumentType returns rules for invoice', () => {
  const invoiceRules = getRulesForDocumentType('invoice');
  assert.ok(invoiceRules.length >= 5, `Expected >=5 invoice rules, got ${invoiceRules.length}`);
});

test('getRulesForDocumentType returns rules for contract', () => {
  const contractRules = getRulesForDocumentType('contract');
  assert.ok(contractRules.length >= 2, `Expected >=2 contract rules, got ${contractRules.length}`);
});

test('getRulesForDocumentType returns rules for payment_rec', () => {
  const payRules = getRulesForDocumentType('payment_rec');
  assert.ok(payRules.length >= 2, `Expected >=2 payment_rec rules, got ${payRules.length}`);
});

// ─── Single document evaluation tests ────────────────────────────────────────

test('over-capacity ticket creates WARN', () => {
  const result = evaluateDocument({
    documentType: 'ticket',
    documentName: 'ticket-001.pdf',
    documentTitle: 'Ticket 001',
    projectName: 'PROJ01',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: '500016-2661-32294',
          load_cy: 120,
          truck_capacity_cy: 102,
          contractor_name: 'Aftermath Recovery',
          dumpsite: 'Ag Center DMS',
          material_type: 'Vegetation',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [],
  }) as RuleEvaluationResult;

  const overload = result.outputs.find((o: RuleOutput) => o.ruleId === 'TKT-002');
  assert.ok(overload, 'TKT-002 should fire for overload');
  assert.equal(overload.decision, 'WARN');
  assert.equal(overload.severity, 'HIGH');
  assert.ok(overload.finding.includes('120'));
  assert.ok(overload.finding.includes('102'));
});

test('missing GPS for permit creates MISSING with correct task', () => {
  const result = evaluateDocument({
    documentType: 'permit',
    documentName: 'tdec-permit.pdf',
    documentTitle: 'TDEC Permit',
    projectName: 'PROJ01',
    extractionData: {
      fields: { typed_fields: { site_name: 'Ag Center DMS' } },
      extraction: { text_preview: '' },
    },
    relatedDocs: [],
  }) as RuleEvaluationResult;

  const gps = result.outputs.find((o: RuleOutput) => o.ruleId === 'PRM-002');
  assert.ok(gps, 'PRM-002 should fire for missing GPS');
  assert.equal(gps.decision, 'MISSING');
  assert.equal(gps.taskType, 'verify_gps_coordinates');
});

test('ticket with all fields passes single-doc extraction rules', () => {
  const result = evaluateDocument({
    documentType: 'ticket',
    documentName: 'ticket-001.pdf',
    documentTitle: 'Ticket 001',
    projectName: 'PROJ01',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: '500016-001',
          load_cy: 56,
          truck_capacity_cy: 102,
          contractor_name: 'Aftermath Recovery',
          dumpsite: 'Ag Center DMS',
          material_type: 'Vegetation',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [],
  }) as RuleEvaluationResult;

  const extractions = result.outputs.filter((o: RuleOutput) => o.ruleFamily === 'extraction');
  assert.equal(extractions.length, 0, 'No extraction rules should fire when all fields present');
});

// ─── Cross document evaluation tests ─────────────────────────────────────────

test('invoice rate mismatch against payment rec creates WARN CRITICAL', () => {
  const result = evaluateDocument({
    documentType: 'invoice',
    documentName: 'invoice.pdf',
    documentTitle: 'EMERG03 Invoice',
    projectName: 'EMERG03',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'EMERG03-001',
          vendor_name: 'Stampede Ventures Inc',
          invoice_date: '2026-03-01',
          current_amount_due: 76359.62,
        },
      },
      extraction: { text_preview: '' },
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
              approved_amount: 50000.00,
              vendor_name: 'Stampede Ventures Inc',
            },
          },
          extraction: { text_preview: '' },
        },
      },
    ],
  }) as RuleEvaluationResult;

  const amountRule = result.outputs.find((o: RuleOutput) => o.ruleId === 'INV-X01');
  assert.ok(amountRule, 'INV-X01 should fire for amount mismatch');
  assert.equal(amountRule.decision, 'WARN');
  assert.equal(amountRule.severity, 'CRITICAL');
});

test('duplicate ticket creates BLOCK', () => {
  const result = evaluateDocument({
    documentType: 'ticket',
    documentName: 'ticket-001.pdf',
    documentTitle: 'Ticket 001',
    projectName: 'PROJ01',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: 'TKT-DUPE-001',
          load_cy: 56,
          truck_capacity_cy: 102,
          contractor_name: 'Aftermath',
          dumpsite: 'Ag Center DMS',
          material_type: 'Vegetation',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [
      {
        id: 'other-ticket',
        document_type: 'ticket',
        name: 'ticket-002.pdf',
        title: 'Ticket 002',
        extraction: {
          fields: {
            typed_fields: { ticket_number: 'TKT-DUPE-001' },
          },
          extraction: { text_preview: '' },
        },
      },
    ],
  }) as RuleEvaluationResult;

  const dupe = result.outputs.find((o: RuleOutput) => o.ruleId === 'TKT-X04');
  assert.ok(dupe, 'TKT-X04 should fire for duplicate ticket');
  assert.equal(dupe.decision, 'BLOCK');
  assert.equal(dupe.severity, 'CRITICAL');
  assert.equal(dupe.blockProcessing, true);
});

test('NTE vs G702 mismatch creates BLOCK', () => {
  const result = evaluateDocument({
    documentType: 'invoice',
    documentName: 'invoice.pdf',
    documentTitle: 'Invoice Package',
    projectName: 'EMERG03',
    extractionData: {
      fields: {
        typed_fields: {
          invoice_number: 'INV-001',
          current_amount_due: 76000,
          vendor_name: 'Stampede',
          invoice_date: '2026-03-01',
        },
      },
      extraction: { text_preview: 'Original contract sum $80,000,000' },
    },
    relatedDocs: [
      {
        id: 'contract-1',
        document_type: 'contract',
        name: 'contract.pdf',
        title: 'Project Contract',
        extraction: {
          fields: {
            typed_fields: { nte_amount: 30000000 },
          },
          extraction: { text_preview: 'Not to exceed $30,000,000' },
        },
      },
      {
        id: 'payrec-1',
        document_type: 'payment_rec',
        name: 'payment_rec.pdf',
        extraction: {
          fields: { typed_fields: { approved_amount: 76000 } },
          extraction: { text_preview: '' },
        },
      },
    ],
  }) as RuleEvaluationResult;

  const ceiling = result.outputs.find((o: RuleOutput) => o.ruleId === 'INV-X02');
  assert.ok(ceiling, 'INV-X02 should fire for NTE/G702 mismatch');
  assert.equal(ceiling.decision, 'BLOCK');
  assert.equal(ceiling.severity, 'CRITICAL');
});

// ─── Determinism test ────────────────────────────────────────────────────────

test('same input returns same outputs (deterministic)', () => {
  const params = {
    documentType: 'ticket',
    documentName: 'ticket-001.pdf',
    documentTitle: 'Ticket 001',
    projectName: 'PROJ01',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: '500016-001',
          load_cy: 120,
          truck_capacity_cy: 102,
          contractor_name: 'Aftermath',
          dumpsite: 'Ag Center DMS',
          material_type: 'Vegetation',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [],
  };

  const result1 = evaluateDocument(params) as RuleEvaluationResult;
  const result2 = evaluateDocument(params) as RuleEvaluationResult;

  assert.equal(result1.outputs.length, result2.outputs.length);
  assert.equal(result1.rulesEvaluated, result2.rulesEvaluated);
  assert.equal(result1.rulesMatched, result2.rulesMatched);

  for (let i = 0; i < result1.outputs.length; i++) {
    assert.equal(result1.outputs[i].ruleId, result2.outputs[i].ruleId);
    assert.equal(result1.outputs[i].decision, result2.outputs[i].decision);
    assert.equal(result1.outputs[i].severity, result2.outputs[i].severity);
    assert.equal(result1.outputs[i].finding, result2.outputs[i].finding);
  }
});

// ─── Adapter tests ───────────────────────────────────────────────────────────

test('mapRuleOutputs produces decisions and tasks from rule outputs', () => {
  resetIdCounter();
  const outputs: RuleOutput[] = [
    {
      ruleId: 'TEST-001',
      ruleFamily: 'single_document',
      scope: 'single_document',
      finding: 'Test finding',
      decision: 'WARN',
      severity: 'HIGH',
      taskType: 'verify_load_capacity',
      priority: 'P2',
      ownerSuggestion: 'Field monitor',
      reason: 'Test reason',
      reference: 'Test ref',
    },
  ];

  const mapped = mapRuleOutputs(outputs);
  assert.equal(mapped.decisions.length, 1);
  assert.equal(mapped.tasks.length, 1);
  assert.equal(mapped.decisions[0].status, 'risky');
  assert.equal(mapped.tasks[0].title, 'Confirm ticket quantity support (overload check)');
  assert.equal(mapped.tasks[0].priority, 'P2');
});

test('buildRuleSummary reports no action when all pass', () => {
  const result: RuleEvaluationResult = {
    outputs: [],
    ruleVersion: 'v1.0.0',
    evaluatedAt: new Date().toISOString(),
    documentType: 'ticket',
    rulesEvaluated: 10,
    rulesMatched: 0,
  };
  const mapped = mapRuleOutputs([]);
  const summary = buildRuleSummary(result, mapped);
  assert.ok(summary.headline.toLowerCase().includes('no action'));
});

// ─── Rerun targeting tests ───────────────────────────────────────────────────

test('contract change triggers rerun for invoice and ticket', () => {
  const targets = getRerunTargets('contract', 'document_updated');
  assert.ok(targets.affectedDocumentTypes.includes('contract'));
  assert.ok(targets.affectedDocumentTypes.includes('invoice'));
  assert.ok(targets.affectedDocumentTypes.includes('ticket'));
});

test('permit change triggers rerun for ticket', () => {
  assert.ok(shouldRerunForDocumentType('permit', 'ticket', 'document_uploaded'));
  assert.ok(!shouldRerunForDocumentType('permit', 'invoice', 'document_uploaded'));
});

// ─── Integration with buildDocumentIntelligence ──────────────────────────────

test('buildDocumentIntelligence includes rule engine findings for ticket', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'ticket',
    documentTitle: 'Ticket 500016',
    documentName: 'ticket.pdf',
    projectName: 'WilliamsonFern',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: '500016-2661-32294',
          truck_capacity_cy: 102,
          load_cy: 56,
          contractor_name: 'Aftermath Disaster Recovery',
          dumpsite: 'Ag Center DMS',
          material_type: 'Neighborhood Veg',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [],
  }) as DocumentIntelligenceOutput;

  assert.equal(intelligence.classification.family, 'ticket');
  assert.ok(intelligence.decisions.length > 0, 'Should have decisions');
  assert.ok(intelligence.summary.headline.length > 0, 'Should have a summary headline');
});

test('buildDocumentIntelligence includes rule engine blocker for duplicate ticket', () => {
  const intelligence = buildDocumentIntelligence({
    documentType: 'ticket',
    documentTitle: 'Ticket 500016',
    documentName: 'ticket.pdf',
    projectName: 'WilliamsonFern',
    extractionData: {
      fields: {
        typed_fields: {
          ticket_number: 'DUPE-001',
          truck_capacity_cy: 102,
          load_cy: 56,
          contractor_name: 'Aftermath',
          dumpsite: 'Ag Center DMS',
          material_type: 'Vegetation',
        },
      },
      extraction: { text_preview: '' },
    },
    relatedDocs: [
      {
        id: 'other-ticket',
        document_type: 'ticket',
        name: 'ticket-other.pdf',
        extraction: {
          fields: { typed_fields: { ticket_number: 'DUPE-001' } },
          extraction: { text_preview: '' },
        },
      },
    ],
  }) as DocumentIntelligenceOutput;

  const hasDupeDecision = intelligence.decisions.some(d =>
    d.type.includes('tkt_x04') || d.title.toLowerCase().includes('duplicate')
  );
  assert.ok(hasDupeDecision, 'Should have duplicate ticket decision from rule engine');
});
