import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { runProjectValidation } from '@/lib/validator/projectValidator';

/**
 * The retired SOURCES_NO_RATE_SCHEDULE through the whole real read path, with real
 * extracted facts. Only the database is a stand-in. It holds three things the
 * retirement rests on: nothing emits it, a corrected version would have added
 * nothing, and rates held in the contract need no separate linked schedule.
 */

const PROJECT_ID = 'project-1';
const ORG = 'org-1';
const AT = '2026-01-01T00:00:00.000Z';

function documentRow(id: string, title: string, documentType: string) {
  return {
    id, project_id: PROJECT_ID, organization_id: ORG, title, name: `${id}.pdf`, document_type: documentType, document_role: null,
    storage_path: `${id}.pdf`, created_at: AT, processing_status: 'decisioned', operational_status: 'active', processed_at: AT, intelligence_trace: null,
  };
}

function factRow(key: string, value: Readonly<{ text?: string; number?: number; boolean?: boolean }>) {
  return {
    id: `fact-${key}`, status: 'active', document_id: 'contract', field_key: key, field_type: 'text',
    field_value_text: value.text ?? null, field_value_number: value.number ?? null, field_value_date: null,
    field_value_boolean: value.boolean ?? null, source: 'extraction', confidence: 0.9,
  };
}

function serveDatabase(documents: readonly unknown[], facts: readonly unknown[]) {
  const rows: Readonly<Record<string, readonly unknown[]>> = {
    projects: [{ id: PROJECT_ID, organization_id: ORG, name: 'Project', code: 'P1', validation_status: 'FINDINGS_OPEN', validation_summary_json: null, validation_phase: 'contract_setup' }],
    documents,
    document_extractions: facts,
  };
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from(table: string) {
      const result = { data: rows[table] ?? [], error: null };
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
          if (property === 'maybeSingle' || property === 'single') return async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
          return () => chain;
        },
      });
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  } as never);
}

const CONTRACT = documentRow('contract', 'Debris Contract', 'contract');
const PRICE_SHEET = documentRow('sheet', 'Price Sheet', 'price sheet');

const CEILING_TYPES = [null, 'rate_based', 'nte', 'lump_sum'] as const;
const SCHEDULE_FACTS = [
  [],
  [factRow('rate_schedule_present', { boolean: true })],
  [factRow('rate_schedule_present', { boolean: false })],
  [factRow('rate_section_present', { boolean: true })],
  [factRow('unit_price_structure_present', { boolean: true })],
  [factRow('rate_row_count', { number: 0 })],
  [factRow('rate_row_count', { number: 5 })],
  [factRow('rate_items_detected', { number: 5 })],
  [factRow('rate_table', { text: 'Haul 0-15 miles' })],
];
const DOCUMENT_SETS = [[CONTRACT], [CONTRACT, PRICE_SHEET]];

function* everyFactShape() {
  for (const documents of DOCUMENT_SETS) {
    for (const ceilingType of CEILING_TYPES) {
      for (const scheduleFacts of SCHEDULE_FACTS) {
        yield {
          documents,
          facts: [...(ceilingType ? [factRow('contract_ceiling_type', { text: ceilingType })] : []), ...scheduleFacts],
        };
      }
    }
  }
}

describe('SOURCES_NO_RATE_SCHEDULE through the real read path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never fires, whatever facts extraction produced', async () => {
    let runs = 0;
    for (const { documents, facts } of everyFactShape()) {
      serveDatabase(documents, facts);
      const { result } = await runProjectValidation(PROJECT_ID);
      expect(result.findings.map((finding) => finding.rule_id)).not.toContain('SOURCES_NO_RATE_SCHEDULE');
      runs += 1;
    }
    expect(runs).toBe(2 * 4 * 9);
  });

  it('would add nothing if corrected: the dedicated rule already fires wherever a corrected rule would', async () => {
    let correctedWouldFire = 0;
    const uncovered: string[] = [];
    for (const { documents, facts } of everyFactShape()) {
      serveDatabase(documents, facts);
      const { result, input } = await runProjectValidation(PROJECT_ID);
      const lookups = input.factLookups;
      const requiresSchedule = lookups.contractCeilingType === 'rate_based' || lookups.rateSchedulePresent === true || (lookups.rateRowCount ?? 0) > 0;
      // The rule's own question, asked without counting the contract as a schedule.
      const separateSchedule = lookups.pricingContextDocumentIds.length > 0 || input.familyDocumentIds.rate_sheet.length > 0;
      if (input.truthCategoryDocumentIds.contract_identity.length > 0 && requiresSchedule && !lookups.hasRateScheduleFacts && !separateSchedule) {
        correctedWouldFire += 1;
        if (!result.findings.some((finding) => finding.rule_id === 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED')) {
          uncovered.push(JSON.stringify(facts.map((fact) => fact.field_key)));
        }
      }
    }
    expect(uncovered).toEqual([]);
    // The condition was reached, so the check above is not vacuous.
    expect(correctedWouldFire).toBeGreaterThan(0);
  });

  it('does not ask for a separate linked schedule when the contract holds its own rates', async () => {
    serveDatabase([CONTRACT], [
      factRow('contract_ceiling_type', { text: 'rate_based' }),
      factRow('rate_schedule_present', { boolean: true }),
      factRow('rate_row_count', { number: 5 }),
    ]);
    const { result, input } = await runProjectValidation(PROJECT_ID);
    const rules = result.findings.filter((finding) => finding.status === 'open').map((finding) => finding.rule_id);
    expect(input.familyDocumentIds.rate_sheet).toEqual([]);
    expect(input.factLookups.pricingContextDocumentIds).toEqual([]);
    expect(rules).not.toContain('SOURCES_NO_RATE_SCHEDULE');
    expect(rules).not.toContain('FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED');
  });

  it('keeps the contract in the pricing search list, beside a separate price sheet', async () => {
    serveDatabase([CONTRACT, PRICE_SHEET], []);
    const { input } = await runProjectValidation(PROJECT_ID);
    expect(input.truthCategoryDocumentIds.pricing.sort()).toEqual(['contract', 'sheet']);
    expect(input.factLookups.pricingContextDocumentIds).toEqual(['sheet']);
  });
});
