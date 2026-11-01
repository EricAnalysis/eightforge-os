import { describe, expect, it, vi } from 'vitest';

import { planProjectContext } from '@/lib/projectIntelligence/contextPlan';
import {
  ProjectIntelligenceScopeError,
  readProjectIntelligenceSources,
} from '@/lib/server/projectIntelligenceRead';

const PROJECT = { id: 'project-1', name: 'Goodlettsville', validation_status: 'BLOCKED', validation_summary_json: null };
const AT = '2026-10-01T00:00:00.000Z';

type Call = { table: string; eq: Array<[string, unknown]> };

/** A read-only stand-in for the database that records every filter; any write throws. */
function fakeAdmin(rows: Readonly<Record<string, unknown[]>>) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, eq: [] };
      calls.push(call);
      const result = { data: rows[table] ?? [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, in: () => chain, is: () => chain, order: () => chain, limit: () => chain,
        eq: (column: string, value: unknown) => { call.eq.push([column, value]); return chain; },
        maybeSingle: async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      for (const write of ['insert', 'update', 'upsert', 'delete']) {
        chain[write] = () => { throw new Error(`unexpected write to ${table}`); };
      }
      return chain;
    },
    rpc() { throw new Error('unexpected rpc'); },
  };
  return { admin: admin as never, calls };
}

const ROWS = {
  project_validation_findings: [{
    id: 'finding-1', run_id: 'run-1', rule_id: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', category: 'financial_integrity', severity: 'critical', status: 'open',
    subject_type: 'project', subject_id: 'project-1', field: 'rate_schedule_present', expected: 'present', actual: 'missing', blocked_reason: 'No schedule',
    linked_decision_id: null, linked_action_id: null, created_at: AT, updated_at: AT,
  }],
  project_validation_runs: [{ id: 'run-1', run_at: AT, completed_at: AT }],
  documents: [{ id: 'doc-1', project_id: 'project-1', title: 'Contract', name: 'contract.pdf', document_type: 'contract', processing_status: 'decisioned', created_at: AT, processed_at: AT }],
  document_relationships: [],
};

describe('readProjectIntelligenceSources', () => {
  it('binds every project read to the actor organization and the project (proof 2)', async () => {
    const { admin, calls } = fakeAdmin(ROWS);
    const result = await readProjectIntelligenceSources({
      admin, organizationId: 'org-1', project: PROJECT, question: 'What should I do?', plan: planProjectContext('what_to_do'),
    });
    expect(result.status).toBe('ok');
    const eqs = (table: string) => calls.filter((call) => call.table === table);
    expect(eqs('project_validation_findings').length).toBeGreaterThan(0);
    for (const call of eqs('project_validation_findings')) expect(call.eq).toContainEqual(['project_id', 'project-1']);
    for (const table of ['document_relationships', 'decisions']) {
      expect(eqs(table).length).toBeGreaterThan(0);
      for (const call of eqs(table)) {
        expect(call.eq).toContainEqual(['organization_id', 'org-1']);
        expect(call.eq).toContainEqual(['project_id', 'project-1']);
      }
    }
    const projectDocumentReads = eqs('documents').filter((call) => call.eq.length > 0);
    expect(projectDocumentReads.length).toBeGreaterThan(0);
    for (const call of projectDocumentReads) expect(call.eq).toContainEqual(['organization_id', 'org-1']);
  });

  it('stops the request if a read returns another project\'s record, rather than filtering it', async () => {
    const { admin } = fakeAdmin({ ...ROWS, documents: [{ ...ROWS.documents[0], project_id: 'project-2' }] });
    await expect(readProjectIntelligenceSources({
      admin, organizationId: 'org-1', project: PROJECT, question: 'What am I missing?', plan: planProjectContext('whats_missing'),
    })).rejects.toBeInstanceOf(ProjectIntelligenceScopeError);
  });

  it('loads only what the plan names (proof 3)', async () => {
    const loadDecisions = vi.fn();
    const readReviewedTruth = vi.fn();
    const loadFacts = vi.fn().mockResolvedValue({ source: 'document_facts', facts: [], conflicts: [] });
    const { admin, calls } = fakeAdmin(ROWS);
    const result = await readProjectIntelligenceSources(
      { admin, organizationId: 'org-1', project: PROJECT, question: 'Do I need another document?', plan: planProjectContext('need_document') },
      { loadDecisions, readReviewedTruth, loadFacts },
    );
    expect(loadDecisions).not.toHaveBeenCalled();
    expect(readReviewedTruth).not.toHaveBeenCalled();
    expect(loadFacts).toHaveBeenCalledTimes(1);
    expect(loadFacts.mock.calls[0]?.[0].fieldKeys).toContain('rate_schedule_present');
    expect(calls.map((call) => call.table)).not.toContain('decisions');
    expect(calls.map((call) => call.table)).not.toContain('document_extractions');
    if (result.status === 'ok') {
      expect(Object.keys(result.sources)).not.toContain('decisions');
      expect(Object.keys(result.sources)).not.toContain('reviewedTruth');
    }
  });

  it('does not read facts when the open findings make none relevant', async () => {
    const loadFacts = vi.fn();
    const { admin } = fakeAdmin({ ...ROWS, project_validation_findings: [{ ...ROWS.project_validation_findings[0], rule_id: 'INVOICE_DUPLICATE_BILLED_LINE', field: null }] });
    const result = await readProjectIntelligenceSources(
      { admin, organizationId: 'org-1', project: PROJECT, question: 'Do I need another document?', plan: planProjectContext('need_document') },
      { loadFacts },
    );
    expect(loadFacts).not.toHaveBeenCalled();
    expect(result.status === 'ok' && result.sources.facts).toEqual([]);
  });

  it('refuses a focus finding that is not open on this project', async () => {
    const { admin } = fakeAdmin(ROWS);
    const result = await readProjectIntelligenceSources({
      admin, organizationId: 'org-1', project: PROJECT, question: 'Why is this flagged?',
      plan: planProjectContext('why_flagged', { focusFindingId: 'finding-of-another-project' }),
    });
    expect(result).toEqual({ status: 'focus_finding_not_found' });
  });

  it('reports a failed read as null, never as an empty list', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin(ROWS);
    const result = await readProjectIntelligenceSources(
      { admin, organizationId: 'org-1', project: PROJECT, question: 'What am I missing?', plan: planProjectContext('whats_missing') },
      { loadDocuments: vi.fn().mockRejectedValue(new Error('boom')) },
    );
    expect(result.status === 'ok' && result.sources.documents).toBeNull();
    vi.restoreAllMocks();
  });
});
