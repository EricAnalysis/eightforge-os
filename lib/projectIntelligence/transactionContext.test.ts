import { describe, expect, it, vi } from 'vitest';

import type { ValidatorFinding } from '@/lib/ask/types';
import {
  CONTEXT_SECTION_KINDS,
  classifyOperatorIntent,
  planProjectContext,
  questionConcernsTransactions,
} from '@/lib/projectIntelligence/contextPlan';
import { assessProjectEvidence } from '@/lib/projectIntelligence/evidenceAssessment';
import { deterministicRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import { assembleProjectContext, contextRecordIndex, LOCAL_ONLY_POLICY, type ProjectContextSources } from '@/lib/projectIntelligence/projectContext';
import {
  TRANSACTION_CONTEXT_BOUNDS,
  TRANSACTION_FINDING_GROUPS,
  transactionContextNote,
  transactionFindingCounts,
  type TransactionContextPayload,
  type TransactionDatasetSummary,
} from '@/lib/projectIntelligence/transactionContext';
import { ProjectIntelligenceScopeError, readProjectIntelligenceSources } from '@/lib/server/projectIntelligenceRead';
import { readTransactionSummariesForProject } from '@/lib/server/transactionDataPersistence';
import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';

const PROJECT = { id: 'project-1', name: 'Goodlettsville', validationStatus: 'BLOCKED' };
const AT = '2026-10-01T00:00:00.000Z';

function finding(id: string, ruleId: string): ValidatorFinding {
  return { id, ruleId, severity: 'warning', category: 'transaction', description: `Finding ${id}`, blocksProject: false, lastRun: AT, timestamp: AT };
}

function dataset(overrides: Partial<TransactionDatasetSummary> = {}): TransactionDatasetSummary {
  return {
    id: 'dataset-1', documentId: 'doc-1', projectId: 'project-1', rowCount: 1204, totalExtendedCost: 50_000,
    tickets: {
      count: 980,
      cyd: { invoiced: 100, all: 120 }, mileage: { invoiced: 10, all: 12 },
      netTonnage: { invoiced: null, all: null }, diameter: { invoiced: null, all: null },
    },
    dateRangeStart: '2026-01-02', dateRangeEnd: '2026-02-03', distinctInvoiceCount: 4, uninvoicedLineCount: 7,
    missingFields: { rateCode: 12, invoiceNumber: 0, quantity: null, extendedCost: 1 },
    zeroCostRowCount: 0, extremeUnitRateRowCount: 0, flaggedReviews: [], createdAt: AT,
    ...overrides,
  };
}

function sources(overrides: Partial<ProjectContextSources> = {}): ProjectContextSources {
  return { project: PROJECT, findings: { open: [], latestRunAt: AT }, documents: [], precedence: { families: [], relationships: [] }, facts: [], reviewedTruth: { effective: [], held: [] }, ...overrides };
}

function assemble(question: string, input: ProjectContextSources) {
  const plan = planProjectContext('why_flagged', { question });
  return assembleProjectContext({ organizationId: 'org-1', plan, sources: input, policy: LOCAL_ONLY_POLICY });
}

describe('which questions read ticket data', () => {
  it.each([
    'Why are these tickets flagged?',
    'Why is this transaction flagged?',
    'What should I do about the loads on this truck?',
    'Why is the trailer mileage flagged?',
    'Why is the CYD flagged?',
  ])('reads it for %s', (question) => {
    expect(questionConcernsTransactions(question)).toBe(true);
    const classified = classifyOperatorIntent(question);
    expect(classified).not.toBeNull();
    expect(planProjectContext(classified!.intent, { question }).sections).toContain('transaction_context');
  });

  it.each([
    'Do I need another rate schedule?',
    'Do I need to upload the price sheet again?',
    'Why did this upload fail?',
    'What is missing here?',
  ])('does not read it for %s', (question) => {
    expect(questionConcernsTransactions(question)).toBe(false);
    expect(planProjectContext('need_document', { question }).sections).not.toContain('transaction_context');
  });

  it('is never read for a plan with no question, and a finding alone does not bring it in', () => {
    expect(planProjectContext('why_flagged').sections).not.toContain('transaction_context');
    expect(planProjectContext('why_flagged', { focusFindingId: 'finding-1' }).sections).not.toContain('transaction_context');
  });

  it('gives the same question the same plan, ahead of sections competing for budget', () => {
    const question = 'Why are these tickets flagged?';
    expect(planProjectContext('why_flagged', { question })).toEqual(planProjectContext('why_flagged', { question }));
    expect(planProjectContext('why_flagged', { question }).sections.slice(0, 3)).toEqual(['project_identity', 'validator_findings', 'transaction_context']);
  });

  it('skips the read entirely when the plan does not name it', async () => {
    const readTransactions = vi.fn();
    const admin = {} as never;
    await readProjectIntelligenceSources(
      { admin, organizationId: 'org-1', project: { id: 'project-1', name: 'A', validation_status: null, validation_summary_json: null }, question: 'Do I need another rate schedule?', plan: planProjectContext('need_document', { question: 'Do I need another rate schedule?' }) },
      { readTransactions, loadFindings: (async () => ({ all: [], latestRunAt: AT })) as never, loadDocuments: (async () => ({ all: [] })) as never, loadPrecedence: (async () => ({ documents: [], families: [], relationships: [] })) as never, loadFacts: (async () => ({ facts: [] })) as never },
    );
    expect(readTransactions).not.toHaveBeenCalled();
  });
});

describe('reading it', () => {
  const question = 'Why are these tickets flagged?';
  const baseDeps = { loadFindings: (async () => ({ all: [], latestRunAt: AT })) as never, loadDocuments: (async () => ({ all: [] })) as never, loadPrecedence: (async () => ({ documents: [], families: [], relationships: [] })) as never, loadFacts: (async () => ({ facts: [] })) as never, readReviewedTruth: (async () => ({ effective: [], held: [] })) as never };
  const params = { admin: {} as never, organizationId: 'org-1', project: { id: 'project-1', name: 'A', validation_status: null, validation_summary_json: null }, question, plan: planProjectContext('why_flagged', { question }) };

  it('stops on a row from another project rather than filtering it', async () => {
    const readTransactions = vi.fn(async () => ({ totalDatasetCount: 1, datasets: [dataset({ projectId: 'project-other' })] }));
    await expect(readProjectIntelligenceSources(params, { ...baseDeps, readTransactions })).rejects.toBeInstanceOf(ProjectIntelligenceScopeError);
  });

  it('reports a failed read as failed, never as no tickets', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const readTransactions = vi.fn(async () => { throw new Error('boom'); });
    const read = await readProjectIntelligenceSources(params, { ...baseDeps, readTransactions });
    expect(read).toMatchObject({ status: 'ok', sources: { transactions: null } });
    const context = assemble(question, sources({ transactions: null }));
    expect(context.omissions).toContainEqual({ kind: 'transaction_context', reason: 'read_failed' });
    vi.restoreAllMocks();
  });
});

describe('the persisted summary read', () => {
  function client(result: { data: unknown[] | null; error: unknown; count?: number | null }) {
    const calls: Record<string, unknown[]> = { eq: [] };
    const chain: Record<string, unknown> = {
      select: (columns: string, options: unknown) => { calls.select = [columns, options]; return chain; },
      eq: (column: string, value: unknown) => { (calls.eq as unknown[]).push([column, value]); return chain; },
      order: () => chain,
      limit: (value: number) => { calls.limit = [value]; return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return { admin: { from: (table: string) => { calls.table = [table]; return chain; } } as never, calls };
  }

  it('reads named summary paths for one project, bounded, and never the whole blob or a row', async () => {
    const { admin, calls } = client({ data: [], error: null, count: 0 });
    await readTransactionSummariesForProject({ admin, projectId: 'project-1', limit: 5 });
    expect(calls.table).toEqual(['transaction_data_datasets']);
    expect(calls.eq).toEqual([['project_id', 'project-1']]);
    expect(calls.limit).toEqual([5]);
    const columns = String(calls.select![0]).split(',').map((column) => column.trim());
    expect(columns).not.toContain('summary_json');
    for (const column of columns.filter((entry) => entry.includes('summary_json'))) expect(column).toMatch(/summary_json->/u);
    expect(String(calls.select![0])).not.toMatch(/grouped_by|outlier_rows|record_json|raw_row/u);
  });

  it('maps ticket-grain totals and reports only reviews that flagged something', async () => {
    const { admin } = client({ error: null, count: 9, data: [{
      id: 'dataset-1', document_id: 'doc-1', project_id: 'project-1', row_count: 10, total_extended_cost: '55.5',
      total_cyd_ticket_grain: 5, total_cyd_ticket_grain_full: 6, overview_total_tickets: 8, total_tickets: 99,
      rows_with_missing_rate_code: 2, date_range_start: '2026-01-02', date_range_end: 'not a date',
      truck_trip_time_review: { review_key: 'truck_trip_time_review', label: 'Truck trip time', available: true, status: 'needs_review', reviewed_row_count: 10, flagged_row_count: 2, summary: 'Two trips too short.', flagged_record_ids: ['row-1', 'row-2'] },
      mileage_review: { review_key: 'mileage_review', label: 'Mileage', available: true, flagged_row_count: 0 },
      load_call_review: { review_key: 'load_call_review', label: 'Load call', available: false, flagged_row_count: 4 },
    }] });
    const read = await readTransactionSummariesForProject({ admin, projectId: 'project-1', limit: 5 });
    expect(read.totalDatasetCount).toBe(9);
    const [only] = read.datasets;
    expect(only).toMatchObject({ rowCount: 10, totalExtendedCost: 55.5, dateRangeStart: '2026-01-02', dateRangeEnd: null,
      tickets: { count: 8, cyd: { invoiced: 5, all: 6 }, mileage: { invoiced: null, all: null } },
      missingFields: { rateCode: 2, invoiceNumber: null } });
    expect(only!.flaggedReviews.map((review) => review.reviewKey)).toEqual(['truck_trip_time_review']);
  });

  it('throws on any read error, including a missing table', async () => {
    const { admin } = client({ data: null, error: { code: '42P01', message: 'relation does not exist' } });
    await expect(readTransactionSummariesForProject({ admin, projectId: 'project-1', limit: 5 })).rejects.toThrow('Failed to load transaction summaries.');
  });
});

describe('the section', () => {
  const question = 'Why are these tickets flagged?';

  it('names only rules the catalogue knows', () => {
    for (const rule of Object.values(TRANSACTION_FINDING_GROUPS).flat()) expect(validatorRuleExplanation(rule), rule).not.toBeNull();
  });

  it('groups open findings by rule and ignores the rest', () => {
    expect(transactionFindingCounts([
      finding('b', 'IDENTITY_DUPLICATE_TICKET'), finding('a', 'TRANSACTION_TICKET_GRAIN_CONFLICT'),
      finding('c', 'TICKET_ORPHANED_LOAD'), finding('d', 'SOURCES_NO_CONTRACT'),
    ])).toEqual([
      { group: 'duplicate_or_conflicting_tickets', count: 2, findingIds: ['a', 'b'] },
      { group: 'orphaned_load', count: 1, findingIds: ['c'] },
    ]);
  });

  it('is bounded however much is on file', () => {
    const many = Array.from({ length: 9 }, (_, index) => dataset({ id: `dataset-${index}`, flaggedReviews: [{
      reviewKey: 'truck_trip_time_review', label: 'Truck trip time', status: 'needs_review', reviewedRowCount: 100, flaggedRowCount: 40, summary: null,
      flaggedRecordIds: Array.from({ length: 40 }, (__, row) => `row-${index}-${row}`),
    }] }));
    const open = Array.from({ length: 30 }, (_, index) => finding(`finding-${index}`, 'TICKET_ORPHANED_LOAD'));
    const context = assemble(question, sources({ findings: { open, latestRunAt: AT }, transactions: { totalDatasetCount: 9, datasets: many } }));
    const section = context.sections.find((entry) => entry.kind === 'transaction_context')!;
    const payload = section.payload as TransactionContextPayload;
    expect(payload.datasets).toHaveLength(TRANSACTION_CONTEXT_BOUNDS.maxDatasets);
    expect(payload.totalDatasetCount).toBe(9);
    expect(payload.openFindings).toEqual([{ group: 'orphaned_load', count: 30 }]);
    expect(section.records).toHaveLength(TRANSACTION_CONTEXT_BOUNDS.maxDatasets + TRANSACTION_CONTEXT_BOUNDS.maxFindingRecords + TRANSACTION_CONTEXT_BOUNDS.maxFlaggedRecords);
    expect(payload.datasets.flatMap((entry) => entry.flaggedReviews.flatMap((review) => review.flaggedRecordIds)).length).toBeLessThanOrEqual(TRANSACTION_CONTEXT_BOUNDS.maxFlaggedRecords);
  });

  it('makes every flagged line it shows citable', () => {
    const context = assemble(question, sources({ transactions: { totalDatasetCount: 1, datasets: [dataset({ flaggedReviews: [{
      reviewKey: 'truck_trip_time_review', label: 'Truck trip time', status: 'needs_review', reviewedRowCount: 10, flaggedRowCount: 1, summary: 'One trip too short.', flaggedRecordIds: ['row-1'],
    }] })] } }));
    const index = contextRecordIndex(context);
    expect(index.get('dataset-1')).toMatchObject({ sectionKind: 'transaction_context', documentId: 'doc-1' });
    expect(index.get('row-1')).toMatchObject({ sectionKind: 'transaction_context', documentId: 'doc-1', label: 'Truck trip time: flagged line' });
  });

  it('does not add ticket totals across uploads', () => {
    const payload = { totalDatasetCount: 2, openFindings: [], datasets: [dataset(), dataset({ id: 'dataset-2' })] };
    const note = transactionContextNote(payload)!;
    expect(note).toContain('980 tickets');
    expect(note).not.toContain('1,960');
    expect(note).toContain('2 ticket data uploads are on file, and their totals are not added together.');
  });

  it('is a planned kind that any other plan lists as not used', () => {
    expect(CONTEXT_SECTION_KINDS).toContain('transaction_context');
    const context = assembleProjectContext({ organizationId: 'org-1', plan: planProjectContext('need_document'), sources: sources(), policy: LOCAL_ONLY_POLICY });
    expect(context.omissions).toContainEqual({ kind: 'transaction_context', reason: 'not_in_plan' });
  });
});

describe('the answer', () => {
  const question = 'Why are these tickets flagged?';
  const open = [finding('finding-1', 'TICKET_ORPHANED_LOAD')];

  function recommend(input: ProjectContextSources, plan = planProjectContext('why_flagged', { question, focusFindingId: 'finding-1' })) {
    const context = assembleProjectContext({ organizationId: 'org-1', plan, sources: input, policy: LOCAL_ONLY_POLICY });
    return deterministicRecommendation({ context, assessment: assessProjectEvidence({ intent: 'why_flagged', focusFindingId: 'finding-1', sources: input }), primaryFinding: null });
  }

  it('adds what is on file and cites the upload, without changing the reading or next step', () => {
    const withData = recommend(sources({ findings: { open, latestRunAt: AT }, transactions: { totalDatasetCount: 1, datasets: [dataset()] } }));
    const without = recommend(sources({ findings: { open, latestRunAt: AT } }), planProjectContext('why_flagged', { focusFindingId: 'finding-1' }));
    expect(withData.answer).toContain('1,204 rows and 980 tickets from 2026-01-02 to 2026-02-03');
    expect(withData.answer).toContain('12 rows with no rate code');
    expect(withData.evidenceRefs.map((ref) => ref.recordId)).toContain('dataset-1');
    expect(withData.evidenceState).toBe(without.evidenceState);
    expect(withData.recommendedNextStep).toEqual(without.recommendedNextStep);
  });

  it('says so when no ticket data has been read, and when it could not be read', () => {
    const none = recommend(sources({ findings: { open, latestRunAt: AT }, transactions: { totalDatasetCount: 0, datasets: [] } }));
    expect(none.answer).toContain('No ticket data has been read for this project.');
    const failed = recommend(sources({ findings: { open, latestRunAt: AT }, transactions: null }));
    expect(failed.answer).not.toContain('No ticket data');
    expect(failed.missingInformation.join(' ')).toContain('could not be read');
  });

  it('leaves an answer that never asked about tickets exactly as it was', () => {
    const plan = planProjectContext('why_flagged', { focusFindingId: 'finding-1' });
    const input = sources({ findings: { open, latestRunAt: AT } });
    const answer = recommend(input, plan);
    expect(answer.answer).not.toMatch(/ticket data/u);
    expect(answer.missingInformation.join(' ')).not.toMatch(/ticket data/u);
  });
});
