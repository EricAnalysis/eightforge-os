import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { CONTEXT_SECTION_KINDS, OPERATOR_INTENTS, planProjectContext } from '@/lib/projectIntelligence/contextPlan';
import { EVIDENCE_STATES, NEXT_STEP_KINDS } from '@/lib/projectIntelligence/evidenceAssessment';
import { PRODUCT_SIGNAL_CATEGORIES, PRODUCT_SIGNAL_CODES, type ProductImprovementSignal } from '@/lib/projectIntelligence/improvementSignal';
import { assembleProjectContext, LOCAL_ONLY_POLICY, type ProjectContextSources } from '@/lib/projectIntelligence/projectContext';
import { operatorGuidanceTelemetry, type GuidanceProviderStatus } from '@/lib/projectIntelligence/telemetry';
import type { OperatorRecommendation } from '@/lib/projectIntelligence/operatorRecommendation';
import {
  guidanceEventRow,
  readStoredProjectSignals,
  recordGuidanceAnswer,
  recordSignalReview,
  signalRow,
  SIGNAL_REVIEW_DISPOSITIONS,
} from '@/lib/server/projectIntelligenceRecords';

const MIGRATION = readFileSync('supabase/migrations/20261102120000_project_intelligence_records.sql', 'utf8');
const AT = '2026-10-01T00:00:00.000Z';
const FINDING = '33333333-3333-4333-8333-333333333333';
const SECRET = 'Goodlettsville secret price sheet';

function context(overrides: Partial<ProjectContextSources> = {}) {
  const plan = planProjectContext('why_flagged', { question: 'Why are these tickets flagged?' });
  return assembleProjectContext({
    organizationId: 'org-1', plan, policy: LOCAL_ONLY_POLICY,
    sources: {
      project: { id: 'project-1', name: SECRET, validationStatus: 'BLOCKED' },
      findings: { latestRunAt: AT, open: [{ id: FINDING, severity: 'critical', category: 'x', description: SECRET, blocksProject: true, lastRun: AT, timestamp: AT, snippet: SECRET }] },
      documents: [{ id: 'doc-1', title: SECRET, documentName: SECRET } as never],
      precedence: null, facts: [], reviewedTruth: { effective: [], held: [] }, transactions: { totalDatasetCount: 0, datasets: [] },
      ...overrides,
    },
  });
}

const RECOMMENDATION: OperatorRecommendation = {
  authority: 'non_authoritative', method: 'deterministic', intent: 'why_flagged', evidenceState: 'not_a_source_gap', answer: SECRET,
  recommendedNextStep: { kind: 'operator_judgment_required', instruction: SECRET, actionHref: null },
  evidenceRefs: [], confidence: 'medium', missingInformation: [SECRET], needsHumanReview: true,
};

const SIGNAL: ProductImprovementSignal = {
  schemaVersion: 'product_improvement_signal_v1', authority: 'non_authoritative', audience: 'internal', reviewRequired: true,
  category: 'validator_logic', code: 'source_present_linked_still_flagged', orchestratorRootCause: 'validation_rule_issue',
  ruleId: 'SOURCES_NO_CONTRACT', evidenceState: 'likely_system_issue', findingRef: FINDING, recordRefs: [FINDING],
};

function telemetry(built = context(), providerStatus: GuidanceProviderStatus = 'switch_off', rejection: string | null = null, measured = false) {
  return operatorGuidanceTelemetry({
    classified: { intent: 'why_flagged', basis: 'operator_phrase' }, context: built, recommendation: RECOMMENDATION, providerStatus, rejection,
    requestDigest: measured ? 'a'.repeat(64) : null, model: measured ? 'claude-sonnet-4-6' : null,
    observation: measured ? { inputTokens: 100, outputTokens: 20, latencyMs: 1234.5, stopReason: 'end_turn' } : null,
    signalCategories: [SIGNAL.category],
  });
}

function row(providerStatus: GuidanceProviderStatus = 'switch_off', rejection: string | null = null, measured = false) {
  const built = context();
  return guidanceEventRow({
    id: 'event-1', context: built, telemetry: telemetry(built, providerStatus, rejection, measured), signals: [SIGNAL], rejection,
    reservationId: measured ? 'r-1' : null, requestContract: 'project_ask_operator_guidance_v1', runtimeCommit: 'abc1234',
  });
}

function fakeAdmin(options: { insertError?: unknown; upsertError?: unknown; throws?: boolean; rows?: Record<string, unknown[]> } = {}) {
  const writes: { table: string; kind: string; value: unknown; options?: unknown }[] = [];
  const filters: [string, string, unknown][] = [];
  const admin = {
    from(table: string) {
      const result = { data: options.rows?.[table] ?? [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, order: () => chain, limit: () => chain,
        eq: (column: string, value: unknown) => { filters.push([table, column, value]); return chain; },
        in: (column: string, value: unknown) => { filters.push([table, column, value]); return chain; },
        maybeSingle: async () => ({ data: (options.rows?.[table] ?? [])[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
        insert: async (value: unknown) => {
          if (options.throws) throw new Error(SECRET);
          writes.push({ table, kind: 'insert', value });
          return { error: options.insertError ?? null };
        },
        upsert: async (value: unknown, upsertOptions: unknown) => {
          writes.push({ table, kind: 'upsert', value, options: upsertOptions });
          return { error: options.upsertError ?? null };
        },
        update: () => { throw new Error('unexpected update'); },
        delete: () => { throw new Error('unexpected delete'); },
      };
      return chain;
    },
  };
  return { admin: admin as never, writes, filters };
}

describe('a guidance event row', () => {
  it('carries exactly these fields', () => {
    expect(Object.keys(row()).sort()).toEqual([
      'answer_source', 'citation_count', 'confidence', 'context_read_digest_sha256', 'evidence_state', 'id', 'input_tokens', 'intent', 'intent_basis',
      'latency_ms', 'model', 'model_attempted', 'next_step', 'organization_id', 'output_tokens', 'project_id', 'provider_status', 'record_count',
      'request_contract', 'request_digest_sha256', 'reservation_id', 'runtime_commit', 'sections_not_approved', 'sections_not_available',
      'sections_over_budget', 'sections_planned', 'sections_read', 'sections_read_failed', 'sections_transmitted', 'signal_categories', 'signal_codes',
      'stop_reason', 'validation_failure_code',
    ].sort());
  });

  it('holds no customer text, whatever the request contained', () => {
    expect(JSON.stringify(row('accepted', null, true))).not.toContain('Goodlettsville');
    expect(JSON.stringify(row('accepted', null, true))).not.toContain('secret');
  });

  it('names its tenant and project', () => {
    expect(row()).toMatchObject({ organization_id: 'org-1', project_id: 'project-1' });
  });

  it('says what was planned, read and omitted, by reason', () => {
    const value = row();
    expect(value.sections_planned).toContain('transaction_context');
    expect(value.sections_not_available).toContain('transaction_context');
    expect(value.sections_read_failed).toContain('document_relationships');
    expect(value.sections_read).not.toContain('document_relationships');
    expect(value.sections_transmitted).toEqual([]);
    expect(value.signal_codes).toEqual(['source_present_linked_still_flagged']);
    expect(value.signal_categories).toEqual(['validator_logic']);
  });

  it('records the outcome of a model attempt with the right codes', () => {
    expect(row('switch_off')).toMatchObject({ model_attempted: false, answer_source: 'deterministic', validation_failure_code: null, request_contract: null });
    expect(row('gate_closed')).toMatchObject({ model_attempted: false, answer_source: 'deterministic' });
    expect(row('budget_exhausted')).toMatchObject({ model_attempted: false, answer_source: 'deterministic' });
    expect(row('provider_failed')).toMatchObject({ model_attempted: true, answer_source: 'deterministic_fallback', validation_failure_code: null });
    expect(row('rejected', 'unsupported_number', true)).toMatchObject({ model_attempted: true, answer_source: 'deterministic_fallback', validation_failure_code: 'unsupported_number' });
    expect(row('accepted', null, true)).toMatchObject({
      model_attempted: true, answer_source: 'model_accepted', validation_failure_code: null, model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 20,
      latency_ms: 1235, stop_reason: 'end_turn', request_contract: 'project_ask_operator_guidance_v1', request_digest_sha256: 'a'.repeat(64), reservation_id: 'r-1',
    });
  });

  it('drops a malformed commit or digest rather than storing it', () => {
    const built = context();
    const value = guidanceEventRow({ id: 'e', context: built, telemetry: { ...telemetry(built), requestDigest: 'not a digest' }, signals: [], rejection: null, reservationId: null, requestContract: 'x', runtimeCommit: 'not a commit' });
    expect(value.request_digest_sha256).toBeNull();
    expect(value.runtime_commit).toBeNull();
  });
});

describe('a signal row', () => {
  const build = (signal = SIGNAL) => signalRow({ id: 's-1', organizationId: 'org-1', projectId: 'project-1', intent: 'why_flagged', guidanceEventId: 'event-1', signal });

  it('keeps its evidence and provenance, and cannot claim authority', () => {
    expect(build()).toMatchObject({ authority: 'non_authoritative', review_required: true, finding_ref: FINDING, record_refs: [FINDING], guidance_event_id: 'event-1', source_intent: 'why_flagged', orchestrator_root_cause: 'validation_rule_issue' });
  });

  it('has no field that could hold prose or an instruction', () => {
    expect(Object.keys(build()).sort()).toEqual(['authority', 'category', 'evidence_state', 'finding_ref', 'guidance_event_id', 'id', 'orchestrator_root_cause', 'organization_id', 'project_id', 'record_refs', 'review_required', 'rule_id', 'schema_version', 'signal_code', 'signal_digest_sha256', 'source_intent'].sort());
  });

  it('gives the same observation one digest, and a different one another', () => {
    const first = build().signal_digest_sha256;
    expect(signalRow({ id: 's-2', organizationId: 'org-1', projectId: 'project-1', intent: 'what_to_do', guidanceEventId: null, signal: SIGNAL }).signal_digest_sha256).toBe(first);
    expect(build({ ...SIGNAL, code: 'source_data_needs_correction' }).signal_digest_sha256).not.toBe(first);
  });
});

describe('recording an answer', () => {
  const params = { context: context(), telemetry: telemetry(), signals: [SIGNAL], rejection: null, reservationId: null, requestContract: 'c' };

  it('appends the event and the signals, linked, and never updates', async () => {
    const { admin, writes } = fakeAdmin();
    let id = 0;
    await recordGuidanceAnswer(admin, { ...params, newId: () => `id-${++id}` });
    expect(writes.map((write) => [write.table, write.kind])).toEqual([['project_intelligence_guidance_events', 'insert'], ['project_intelligence_signals', 'upsert']]);
    expect((writes[1]!.value as { guidance_event_id: string }[])[0]!.guidance_event_id).toBe('id-1');
    expect(writes[1]!.options).toEqual({ onConflict: 'organization_id,project_id,signal_digest_sha256', ignoreDuplicates: true });
  });

  it('keeps a signal with no link when the event could not be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin, writes } = fakeAdmin({ insertError: { code: '42P01' } });
    await recordGuidanceAnswer(admin, params);
    expect((writes[1]!.value as { guidance_event_id: string | null }[])[0]!.guidance_event_id).toBeNull();
    expect(warn).toHaveBeenCalledWith('[projectIntelligence] record_not_written', { record: 'guidance_event', code: '42P01' });
    warn.mockRestore();
  });

  it('never throws, and logs no value from the row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { admin } = fakeAdmin({ throws: true });
    await expect(recordGuidanceAnswer(admin, params)).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
    warn.mockRestore();
  });

  it('writes no signal row when there is none', async () => {
    const { admin, writes } = fakeAdmin();
    await recordGuidanceAnswer(admin, { ...params, signals: [] });
    expect(writes.map((write) => write.table)).toEqual(['project_intelligence_guidance_events']);
  });
});

describe('reading and reviewing signals', () => {
  const stored = { id: 's-1', category: 'validator_logic', signal_code: 'source_present_linked_still_flagged', orchestrator_root_cause: null, rule_id: 'R', evidence_state: 'likely_system_issue', source_intent: 'why_flagged', finding_ref: FINDING, record_refs: [FINDING], guidance_event_id: null, first_observed_at: AT };

  it('reads by organization and project, and shows the latest review', async () => {
    const { admin, filters } = fakeAdmin({ rows: { project_intelligence_signals: [stored, { ...stored, id: 's-2' }], project_intelligence_signal_reviews: [
      { signal_id: 's-1', review_version: 1, disposition: 'deferred' }, { signal_id: 's-1', review_version: 2, disposition: 'accepted_for_triage' },
    ] } });
    const read = await readStoredProjectSignals(admin, { organizationId: 'org-1', projectId: 'project-1' });
    expect(filters).toEqual(expect.arrayContaining([['project_intelligence_signals', 'organization_id', 'org-1'], ['project_intelligence_signals', 'project_id', 'project-1'], ['project_intelligence_signal_reviews', 'organization_id', 'org-1']]));
    expect(read.map((entry) => [entry.id, entry.reviewStatus, entry.reviewVersion])).toEqual([['s-1', 'accepted_for_triage', 2], ['s-2', 'unreviewed', 0]]);
    expect(JSON.stringify(read)).not.toContain('project-1');
  });

  it('appends the next version, and writes only that row', async () => {
    const { admin, writes } = fakeAdmin({ rows: { project_intelligence_signals: [{ id: 's-1' }], project_intelligence_signal_reviews: [{ review_version: 2 }] } });
    const result = await recordSignalReview(admin, { organizationId: 'org-1', signalId: 's-1', reviewerActorId: 'user-1', disposition: 'rejected', newId: () => 'rev-1' });
    expect(result).toEqual({ status: 'recorded', reviewId: 'rev-1', reviewVersion: 3 });
    expect(writes).toEqual([{ table: 'project_intelligence_signal_reviews', kind: 'insert', value: { id: 'rev-1', signal_id: 's-1', organization_id: 'org-1', review_version: 3, disposition: 'rejected', reviewer_actor_id: 'user-1' } }]);
  });

  it('refuses a signal outside the organization', async () => {
    const { admin, writes, filters } = fakeAdmin();
    await expect(recordSignalReview(admin, { organizationId: 'org-other', signalId: 's-1', reviewerActorId: 'user-1', disposition: 'rejected' })).resolves.toEqual({ status: 'signal_not_found' });
    expect(writes).toEqual([]);
    expect(filters).toContainEqual(['project_intelligence_signals', 'organization_id', 'org-other']);
  });

  it('reports a lost race as a conflict', async () => {
    const { admin } = fakeAdmin({ insertError: { code: '23505' }, rows: { project_intelligence_signals: [{ id: 's-1' }] } });
    await expect(recordSignalReview(admin, { organizationId: 'org-1', signalId: 's-1', reviewerActorId: 'user-1', disposition: 'deferred' })).resolves.toEqual({ status: 'version_conflict' });
  });
});

describe('the migration', () => {
  it.each([
    ['intents', OPERATOR_INTENTS],
    ['section kinds', CONTEXT_SECTION_KINDS],
    ['evidence states', EVIDENCE_STATES],
    ['next steps', NEXT_STEP_KINDS],
    ['signal categories', PRODUCT_SIGNAL_CATEGORIES],
    ['signal codes', PRODUCT_SIGNAL_CODES],
    ['review dispositions', SIGNAL_REVIEW_DISPOSITIONS],
    ['provider statuses', ['not_attempted', 'switch_off', 'gate_closed', 'not_configured', 'model_unqualified', 'budget_exhausted', 'reservation_failed', 'provider_failed', 'rejected', 'accepted'] satisfies GuidanceProviderStatus[]],
  ])('admits every one of the %s', (_name, values) => {
    for (const value of values) expect(MIGRATION, value).toContain(`'${value}'`);
  });

  it('has no column that could hold customer text', () => {
    const columns = [...MIGRATION.matchAll(/^ {2}([a-z_0-9]+) (?:uuid|text|text\[\]|integer|boolean|timestamptz)\b/gmu)].map((match) => match[1]!);
    expect(columns.length).toBeGreaterThan(30);
    for (const column of columns) expect(column, column).not.toMatch(/question|answer_text|prose|excerpt|snippet|title|rationale|note|comment|summary|payload|body|explanation/u);
  });

  it('bounds every free-form text column', () => {
    for (const column of ['model', 'stop_reason', 'rule_id']) {
      expect(new RegExp(`^ {2}${column} text.*CHECK`, 'mu').test(MIGRATION), column).toBe(true);
    }
  });

  it('is append-only, tenant-scoped and server-only', () => {
    for (const table of ['project_intelligence_guidance_events', 'project_intelligence_signals', 'project_intelligence_signal_reviews']) {
      expect(MIGRATION).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(MIGRATION).toContain(`BEFORE UPDATE OR DELETE ON public.${table}`);
      expect(MIGRATION).toContain(`GRANT SELECT, INSERT ON TABLE public.${table} TO service_role`);
    }
    expect(MIGRATION).not.toMatch(/CREATE POLICY/u);
    expect(MIGRATION).not.toMatch(/GRANT [^;]*TO (?:anon|authenticated)/u);
    expect(MIGRATION).toContain('BEFORE INSERT ON public.project_intelligence_guidance_events');
    expect(MIGRATION).toContain('BEFORE INSERT ON public.project_intelligence_signals');
    expect(MIGRATION).toContain("FOREIGN KEY (signal_id, organization_id)");
    expect(MIGRATION).toContain("CHECK (authority = 'non_authoritative')");
  });

  it('changes nothing that already exists', () => {
    expect(MIGRATION.replace(/^--.*$/gmu, '')).not.toMatch(/ALTER TABLE (?!public\.project_intelligence_)|DROP |UPDATE public\.|DELETE FROM|INSERT INTO/u);
  });
});
