import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/validator/persistValidationRun', () => ({ persistValidationRun: vi.fn() }));

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { persistValidationRun } from '@/lib/validator/persistValidationRun';
import {
  buildDocumentIdsByFamily,
  buildExcludedValidationDocumentIds,
  loadValidatorSourceReads,
  runProjectValidation,
} from '@/lib/validator/projectValidator';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import { runValidationFlow } from '@/lib/validator/triggerProjectValidation';
import type { ProjectValidatorInput, ValidatorDocumentRow } from '@/lib/validator/shared';

/**
 * A failed precedence read stops validation instead of validating without
 * precedence. The real read path, the real rule packs and the real resolvers run;
 * only the database is a stand-in, and the failure is the real one: the
 * relationships query returns an error, which the real precedence loader throws.
 */

const PROJECT_ID = 'project-1';
const ORG = 'org-1';
const AT = '2026-01-01T00:00:00.000Z';

const CONTRACT = {
  id: 'contract', project_id: PROJECT_ID, organization_id: ORG, title: 'Debris Contract', name: 'contract.pdf', document_type: 'contract',
  document_role: null, storage_path: 'contract.pdf', created_at: AT, processing_status: 'decisioned', operational_status: 'active',
  processed_at: AT, intelligence_trace: null,
};

const RATE_BASED_FACT = {
  id: 'fact-1', status: 'active', document_id: 'contract', field_key: 'contract_ceiling_type', field_type: 'text',
  field_value_text: 'rate_based', field_value_number: null, field_value_date: null, field_value_boolean: null, source: 'extraction', confidence: 0.9,
};

const QUERY_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
const PERMISSION_DENIED = { code: '42501', message: 'permission denied for table document_relationships' };

/** Any chain resolves to the table's rows, or to the configured error. */
function database(options: Readonly<{ failRelationships: boolean; relationshipsError?: { code: string; message: string } }>) {
  const rows: Readonly<Record<string, readonly unknown[]>> = {
    projects: [{ id: PROJECT_ID, organization_id: ORG, name: 'Project', code: 'P1', validation_status: 'FINDINGS_OPEN', validation_summary_json: null, validation_phase: 'contract_setup' }],
    documents: [CONTRACT],
    document_extractions: [RATE_BASED_FACT],
  };
  return {
    from(table: string) {
      const error = table === 'document_relationships' && options.failRelationships
        ? options.relationshipsError ?? QUERY_TIMEOUT : null;
      const result = { data: error ? null : rows[table] ?? [], error };
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_target, property) {
          if (property === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
          if (property === 'maybeSingle' || property === 'single') {
            return async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
          }
          return () => chain;
        },
      });
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  };
}

function useDatabase(options: Readonly<{ failRelationships: boolean; relationshipsError?: { code: string; message: string } }>) {
  vi.mocked(getSupabaseAdmin).mockReturnValue(database(options) as never);
}

describe('a failed precedence read during validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a healthy read sees the contract and raises no false finding', async () => {
    useDatabase({ failRelationships: false });
    const { result, input } = await runProjectValidation(PROJECT_ID);
    const open = result.findings.filter((finding) => finding.status === 'open').map((finding) => finding.rule_id);
    expect(input.truthCategoryDocumentIds.contract_identity).toEqual(['contract']);
    expect(open).not.toContain('SOURCES_NO_CONTRACT');
    expect(open).toContain('FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED');
  });

  it('stops the source read with the query error, like every other read', async () => {
    useDatabase({ failRelationships: true });
    await expect(loadValidatorSourceReads(PROJECT_ID)).rejects.toThrow(QUERY_TIMEOUT.message);
  });

  it('stops on an error naming the table too, rather than validating without relationships', async () => {
    useDatabase({ failRelationships: true, relationshipsError: PERMISSION_DENIED });
    await expect(loadValidatorSourceReads(PROJECT_ID)).rejects.toThrow(PERMISSION_DENIED.message);
  });

  it('produces no validation result', async () => {
    useDatabase({ failRelationships: true });
    await expect(runProjectValidation(PROJECT_ID)).rejects.toThrow(QUERY_TIMEOUT.message);
  });

  it('saves nothing, so the last good run, its findings and its status stand', async () => {
    useDatabase({ failRelationships: true });
    await expect(runValidationFlow({ projectId: PROJECT_ID, source: 'manual', inputsSnapshotHash: 'hash' }))
      .rejects.toThrow(QUERY_TIMEOUT.message);
    expect(persistValidationRun).not.toHaveBeenCalled();
  });

  it('is why it must stop: without precedence a project with its contract looks contractless and its duplicates count', () => {
    const contract = { ...CONTRACT } as unknown as ValidatorDocumentRow;
    const categories = buildDocumentIdsByFamily([contract], [], []);
    expect(categories.familyDocumentIds.contract).toEqual(['contract']);
    expect(categories.truthCategoryDocumentIds.contract_identity).toEqual([]);
    const findings = runRequiredSourcesRules({
      project: { id: PROJECT_ID, organization_id: ORG, name: 'Project', code: 'P1' }, validationPhase: 'contract_setup',
      ruleStateByRuleId: new Map(), mobileTickets: [], loadTickets: [], invoices: [], invoiceLines: [], transactionData: null,
      factLookups: { contractCeilingType: null, rateSchedulePresent: null, rateRowCount: null, hasRateScheduleFacts: false },
      familyDocumentIds: categories.familyDocumentIds, governingDocumentIds: categories.governingDocumentIds,
      truthCategoryDocumentIds: categories.truthCategoryDocumentIds,
    } as unknown as ProjectValidatorInput);
    expect(findings.map((finding) => finding.rule_id)).toContain('SOURCES_NO_CONTRACT');
    expect([...buildExcludedValidationDocumentIds({ precedenceFamilies: [], documentRelationships: [] })]).toEqual([]);
  });
});
