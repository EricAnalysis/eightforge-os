import assert from 'node:assert/strict';
import test from 'node:test';

const queryTemplatesModulePromise = import(
  new URL('../lib/ask/queryTemplates.ts', import.meta.url).href,
).then((module) => module.default ?? module);
const sqlGuardrailsModulePromise = import(
  new URL('../lib/ask/sqlGuardrails.ts', import.meta.url).href,
).then((module) => module.default ?? module);

test('document ask template resolves grounded fact lookup', async () => {
  const { resolveDocumentTemplate } = await queryTemplatesModulePromise;
  const result = resolveDocumentTemplate('What is the billed amount on this invoice?');

  assert.ok(result);
  assert.equal(result?.id, 'document_fact_lookup');
  assert.equal(result?.params?.fact_key, 'billed_amount');
});

test('project ask template resolves invoices over ceiling', async () => {
  const { resolveProjectTemplate } = await queryTemplatesModulePromise;
  const result = resolveProjectTemplate('What invoices exceed contract ceiling');

  assert.ok(result);
  assert.equal(result?.id, 'project_invoices_exceed_contract_ceiling');
});

test('guardrail plan stays scoped to allowed tables and a single document id', async () => {
  const { resolveDocumentTemplate } = await queryTemplatesModulePromise;
  const { buildGuardedQueryPlan } = await sqlGuardrailsModulePromise;
  const template = resolveDocumentTemplate('What support is still missing for this invoice?');

  assert.ok(template);
  const plan = buildGuardedQueryPlan('document', template!, 'doc_123');

  assert.deepEqual(plan.allowed_tables, ['documents']);
  assert.ok(plan.filters.some((filter: string) => filter.includes('doc_123')));
  assert.match(plan.query_plan, /trace/i);
});
