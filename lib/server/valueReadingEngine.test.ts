import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { regionAssertionEntryTargets } from '@/lib/humanFactAssertions/regionBoundAssertions';
import type { ValueReadingEligibility } from '@/lib/server/forgewingGates';
import {
  buildValueReadingRequest,
  parseUnreadableLineCaseId,
  parseValueReadingOutput,
  runValueReading,
  VALUE_READING_EXECUTION,
  type ValueReadingEngineClient,
  type ValueReadingEngineDependencies,
  type ValueReadingProvider,
  type ValueReadingProviderRequest,
} from '@/lib/server/valueReadingEngine';

const ORG = 'org-1';
const PROJECT = 'project-1';
const DOC = '11111111-1111-4111-8111-111111111111';
const ARTIFACT = '22222222-2222-4222-8222-222222222222';
const DIGEST = 'a'.repeat(64);

function extractionData(digest = DIGEST) {
  return { extraction: { content_layers_v1: { pdf: {
    text: { pages: [{ plain_text_blocks: [{ text: 'x' }] }] },
    page_extraction_coverage_v1: { pages: [{ page_number: 8, page_representation_digest: digest }] },
    layout_observations_v1: { source_artifact_id: ARTIFACT, observations: [
      { id: 'o1', raw_text: 'Debris', physical_page_number: 8 },
      { id: 'o2', raw_text: 'sia 50', physical_page_number: 8 },
      { id: 'o3', raw_text: 'Hauling', physical_page_number: 8 },
      { id: 'o4', raw_text: '$8.75', physical_page_number: 8 },
    ] },
    priced_schedule_reconstruction_v1: {
      parser_version: 'priced_schedule_reconstruction_v2', pages: [],
      unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 8,
        header_lines: [], priced_lines: [
          { raw_text: 'Debris CY sia 50', y: 300, source_refs: [
            { observation_id: 'o1', x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
            { observation_id: 'o2', x_min: 5, x_max: 6, y_min: 3, y_max: 4 }] },
          { raw_text: 'Hauling TON $8.75', y: 320, source_refs: [
            { observation_id: 'o3', x_min: 1, x_max: 2, y_min: 5, y_max: 6 },
            { observation_id: 'o4', x_min: 5, x_max: 6, y_min: 5, y_max: 6 }] },
        ] }],
    },
  } } } };
}

const ANCHOR = regionAssertionEntryTargets(extractionData())[0]!.anchorKey;
const CASE_ID = `unreadable:${DOC}:${ANCHOR}`;
const ELIGIBLE: ValueReadingEligibility = { eligible: true, entitlementEventId: 'ent-1', dataPolicyEventIds: ['dp-1'], dailyCap: 5 };
const VALUE_OUTPUT = JSON.stringify({ reading: 'value', description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5,
  rationale: 'The rate cell reads $14.50.' });

type Store = {
  document: Record<string, unknown> | null;
  extractions: Array<Record<string, unknown>>;
  assertions: Array<Record<string, unknown>>;
  proposals: Array<Record<string, unknown>>;
  outcomes: Array<Record<string, unknown>>;
  rpcCalls: string[];
};

function fake(overrides: Partial<Store> = {}) {
  const store: Store = {
    document: { id: DOC, organization_id: ORG, project_id: PROJECT },
    extractions: [{ id: 'extraction-1', document_id: DOC, created_at: '2026-10-04T00:00:00Z', data: extractionData() }],
    assertions: [], proposals: [], outcomes: [], rpcCalls: [], ...overrides,
  };
  const client: ValueReadingEngineClient = {
    rpc: async (fn, args) => {
      store.rpcCalls.push(fn);
      if (fn === 'record_forgewing_value_reading_proposal') {
        const existing = store.proposals.find((row) => row.request_digest_sha256 === args.p_request_digest_sha256);
        if (existing) {
          return existing.proposal_digest_sha256 === args.p_proposal_digest_sha256
            ? { data: [{ proposal_row_id: existing.id, inserted: false }], error: null }
            : { data: null, error: { code: '23505', message: 'value-reading request digest collision' } };
        }
        const id = `row-${store.proposals.length + 1}`;
        store.proposals.push({
          id, proposal_id: args.p_proposal_id, proposal_digest_sha256: args.p_proposal_digest_sha256, proposal_version: 3,
          recovery_type: 'priced_value_reading', organization_id: args.p_organization_id, project_id: args.p_project_id,
          source_document_id: args.p_source_document_id, source_artifact_id: args.p_source_artifact_id,
          extraction_snapshot_id: args.p_extraction_snapshot_id, resolution_case_id: args.p_resolution_case_id,
          physical_page_number: args.p_physical_page_number, page_representation_digest: args.p_page_representation_digest,
          fact_key: args.p_fact_key, anchor_key: args.p_anchor_key, source_observation_ids: args.p_source_observation_ids,
          source_region: args.p_source_region, reading_outcome: args.p_reading_outcome, proposed_rate_row: args.p_proposed_rate_row,
          reading_basis: args.p_reading_basis, provider_model: args.p_provider_model, rationale: args.p_rationale,
          authority: 'non_authoritative', created_at: '2026-10-04T01:00:00Z', request_digest_sha256: args.p_request_digest_sha256,
        });
        return { data: [{ proposal_row_id: id, inserted: true }], error: null };
      }
      if (fn === 'record_forgewing_recovery_generation_outcome') {
        store.outcomes.push(args);
        return { data: [{ outcome_row_id: `outcome-${store.outcomes.length}`, inserted: true }], error: null };
      }
      return { data: null, error: { code: '42883', message: `unexpected rpc ${fn}` } };
    },
    from(table: string) {
      return {
        select() {
          const filters: Array<[string, unknown]> = [];
          const rowsFor = () => {
            const source = table === 'document_extractions' ? store.extractions
              : table === 'human_fact_assertions' ? store.assertions
                : table === 'forgewing_recovery_proposals' ? store.proposals : [];
            return source.filter((row) => filters.every(([column, value]) =>
              !(column in row) || row[column] === value || (Array.isArray(value) && value.includes(row[column]))));
          };
          const query = {
            eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
            in: (column: string, values: readonly string[]) => { filters.push([column, [...values]]); return query; },
            is: () => query, order: () => query,
            maybeSingle: async () => ({ data: table === 'documents' ? store.document : null, error: null }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rowsFor(), error: null }).then(resolve),
          };
          return query as never;
        },
      };
    },
  };
  return { client, store };
}

function provider(output: string | (() => Promise<string>), model: string | null = null) {
  const calls: ValueReadingProviderRequest[] = [];
  const port: ValueReadingProvider = {
    providerModel: model,
    read: async (request) => {
      calls.push(request);
      return typeof output === 'string' ? output : output();
    },
  };
  return { port, calls };
}

const IMAGE = { mediaType: 'image/png' as const, bytes: new Uint8Array([137, 80, 78, 71]) };

function deps(overrides: Partial<ValueReadingEngineDependencies> = {}) {
  const reserve = vi.fn(async () => ({ status: 'reserved' as const, reservationId: 'reservation-1', usedInWindow: 1 }));
  const render = vi.fn(async () => IMAGE);
  const eligibility = vi.fn(async () => ELIGIBLE);
  return {
    reserve, render, eligibility,
    value: { reserve, renderRegionImage: render, resolveEligibility: eligibility, ...overrides } as ValueReadingEngineDependencies,
  };
}

const INPUT = { organizationId: ORG, projectId: PROJECT, caseId: CASE_ID, requestedBy: 'actor-1', includeTextExcerpts: false };

afterEach(() => vi.useRealTimers());

describe('value-reading engine (B4.3)', () => {
  it('reads once, records one non-authoritative proposal bound like a B3 write, then reuses it', async () => {
    const { client, store } = fake();
    const { port, calls } = provider(VALUE_OUTPUT);
    const d = deps({ provider: port });
    const result = await runValueReading(client, INPUT, d.value);
    expect(result).toMatchObject({ status: 'proposed', reused: false, proposal: {
      reading: { kind: 'value', rateRow: { description: 'Debris removal', unit_type: 'CY', rate_amount: 14.5 } },
      binding: { sourceArtifactId: ARTIFACT, extractionSnapshotId: 'extraction-1', anchorKey: ANCHOR,
        sourceObservationIds: ['o1', 'o2'], resolutionCaseId: CASE_ID, projectId: PROJECT },
      readingBasis: 'region_image', providerModel: null,
    } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ image: IMAGE, textExcerpts: null,
      timeoutMs: VALUE_READING_EXECUTION.timeoutMs, maxOutputTokens: VALUE_READING_EXECUTION.maxOutputTokens });
    expect(d.reserve).toHaveBeenCalledWith(client, expect.objectContaining({
      organizationId: ORG, reservedBy: 'actor-1', dailyCap: 5, requestDigestSha256: calls[0]!.requestDigestSha256 }));
    expect(d.eligibility).toHaveBeenCalledWith({ organizationId: ORG, contentClasses: ['page_region_images'] });

    const again = await runValueReading(client, INPUT, d.value);
    expect(again).toMatchObject({ status: 'proposed', reused: true });
    expect(calls).toHaveLength(1);
    expect(d.reserve).toHaveBeenCalledTimes(1);
    expect(d.render).toHaveBeenCalledTimes(1);
    // The engine never writes truth.
    expect(store.rpcCalls).not.toContain('record_region_bound_human_fact_assertion');
    expect(store.proposals).toHaveLength(1);
  });

  it('sends text excerpts only when asked, and then needs the text_excerpts approval too', async () => {
    const { client } = fake();
    const { port, calls } = provider(VALUE_OUTPUT);
    const d = deps({ provider: port });
    const result = await runValueReading(client, { ...INPUT, includeTextExcerpts: true }, d.value);
    expect(result).toMatchObject({ status: 'proposed', proposal: { readingBasis: 'region_image_with_text_excerpts' } });
    expect(d.eligibility).toHaveBeenCalledWith({ organizationId: ORG, contentClasses: ['page_region_images', 'text_excerpts'] });
    expect(calls[0]!.textExcerpts).toEqual({ targetLineText: 'Debris CY sia 50', neighbouringLineTexts: ['Hauling TON $8.75'] });
  });

  it('records an unreadable reading as a proposal that proposes no value', async () => {
    const { client } = fake();
    const { port } = provider(JSON.stringify({ reading: 'unreadable', rationale: 'The cell is blacked out.' }));
    const result = await runValueReading(client, INPUT, deps({ provider: port }).value);
    expect(result).toMatchObject({ status: 'proposed', proposal: { reading: { kind: 'unreadable' } } });
  });

  it('records gate refusals for this organization, never for the deployment switch, and sends nothing', async () => {
    for (const [reason, code] of [['data_policy_not_approved', 'data_policy_not_approved'], ['no_entitlement', 'entitlement_missing'],
      ['budget_not_configured', 'budget_exhausted']] as const) {
      const { client, store } = fake();
      const { port, calls } = provider(VALUE_OUTPUT);
      const d = deps({ provider: port, resolveEligibility: async () => ({ eligible: false, reason }) });
      expect(await runValueReading(client, INPUT, d.value)).toEqual({ status: 'refused', reason, outcomeRecorded: true });
      expect(store.outcomes[0]).toMatchObject({ p_recovery_type: 'priced_value_reading', p_outcome_code: code,
        p_sanitized_reason: reason, p_provider_invoked: false, p_candidate_ids: [] });
      expect(calls).toHaveLength(0);
      expect(d.reserve).not.toHaveBeenCalled();
      expect(d.render).not.toHaveBeenCalled();
    }
    const { client, store } = fake();
    const d = deps({ resolveEligibility: async () => ({ eligible: false, reason: 'kill_switch_off' }) });
    expect(await runValueReading(client, INPUT, d.value)).toEqual({ status: 'refused', reason: 'kill_switch_off', outcomeRecorded: false });
    expect(store.outcomes).toHaveLength(0);
  });

  it('wires no provider by default and refuses before spending budget', async () => {
    const { client } = fake();
    const d = deps();
    expect(await runValueReading(client, INPUT, d.value))
      .toEqual({ status: 'refused', reason: 'provider_not_configured', outcomeRecorded: false });
    expect(d.reserve).not.toHaveBeenCalled();
  });

  it('stops at an exhausted budget before rendering or calling', async () => {
    const { client, store } = fake();
    const { port, calls } = provider(VALUE_OUTPUT);
    const d = deps({ provider: port, reserve: async () => ({ status: 'budget_exhausted', usedInWindow: 5 }) });
    expect(await runValueReading(client, INPUT, d.value))
      .toMatchObject({ status: 'failed', outcomeCode: 'budget_exhausted', outcomeRecorded: true });
    expect(calls).toHaveLength(0);
    expect(d.render).not.toHaveBeenCalled();
    expect(store.outcomes[0]).toMatchObject({ p_provider_invoked: false });
  });

  it('times out a provider that does not answer, and records the spent attempt', async () => {
    vi.useFakeTimers();
    const { client, store } = fake();
    const { port } = provider(() => new Promise<string>(() => {}));
    const pending = runValueReading(client, INPUT, deps({ provider: port }).value);
    await vi.advanceTimersByTimeAsync(VALUE_READING_EXECUTION.timeoutMs + 1);
    expect(await pending).toMatchObject({ status: 'failed', outcomeCode: 'provider_failed', reason: 'provider_timeout' });
    expect(store.outcomes[0]).toMatchObject({ p_outcome_code: 'provider_failed', p_provider_invoked: true });
    expect(store.proposals).toHaveLength(0);
  });

  it('refuses invalid or out-of-contract output deterministically', async () => {
    for (const [output, code, reason] of [
      ['not json', 'structured_output_invalid', 'invalid_json'],
      [JSON.stringify({ reading: 'value', description: 'x', unit_type: 'CY', rate_amount: '14.5', rationale: 'r' }),
        'structured_output_invalid', 'invalid_proposal'],
      [JSON.stringify({ reading: 'value', description: 'x', unit_type: 'CY', rate_amount: 14.5, rationale: 'r', confidence: 0.9 }),
        'structured_output_invalid', 'invalid_proposal'],
      [JSON.stringify({ reading: 'value', description: 'x', unit_type: 'CY', rate_amount: -1, rationale: 'r' }),
        'deterministic_validation_failed', 'proposal_value_validation_failed'],
    ] as const) {
      const { client, store } = fake();
      const result = await runValueReading(client, INPUT, deps({ provider: provider(output).port }).value);
      expect(result).toMatchObject({ status: 'failed', outcomeCode: code, reason });
      expect(store.proposals).toHaveLength(0);
    }
  });

  it('discards a reading whose page was re-extracted while the provider was reading', async () => {
    const { client, store } = fake();
    const { port } = provider(async () => {
      store.extractions = [{ id: 'extraction-2', document_id: DOC, created_at: '2026-10-05T00:00:00Z', data: extractionData('b'.repeat(64)) }];
      return VALUE_OUTPUT;
    });
    expect(await runValueReading(client, INPUT, deps({ provider: port }).value))
      .toMatchObject({ status: 'failed', outcomeCode: 'evidence_binding_failed', reason: 'binding_changed' });
    expect(store.proposals).toHaveLength(0);
  });

  it('records a missing region image as a binding failure after the slot was reserved', async () => {
    const { client, store } = fake();
    const { port, calls } = provider(VALUE_OUTPUT);
    const result = await runValueReading(client, INPUT, deps({ provider: port, renderRegionImage: async () => null }).value);
    expect(result).toMatchObject({ status: 'failed', outcomeCode: 'evidence_binding_failed', reason: 'region_image_unavailable' });
    expect(calls).toHaveLength(0);
    expect(store.outcomes[0]).toMatchObject({ p_provider_invoked: false });
  });

  it('resolves only open lines of this organization and project', async () => {
    const { port } = provider(VALUE_OUTPUT);
    expect(await runValueReading(fake().client, { ...INPUT, projectId: 'project-2' }, deps({ provider: port }).value))
      .toMatchObject({ status: 'refused', reason: 'case_not_found' });
    expect(await runValueReading(fake().client, { ...INPUT, caseId: 'finding:abc' }, deps({ provider: port }).value))
      .toMatchObject({ status: 'refused', reason: 'case_not_found' });
    const reviewed = fake({ assertions: [{
      id: 'a1', organization_id: ORG, source_document_id: DOC, fact_key: 'contract_rate_row', source_binding: 'region_bound',
      asserted_value: { description: 'Debris', unit_type: 'CY', rate_amount: 14.5 }, supersedes_assertion_id: null,
      actor_id: 'actor-1', reason: 'r', asserted_at: '2026-10-04T00:00:00Z', status: 'active', source_artifact_id: ARTIFACT,
      physical_page_number: 8, source_region: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 6, y_min: 3, y_max: 4 }] },
      page_representation_digest: DIGEST, parser_version: null, source_observation_ids: ['o1', 'o2'],
      original_source_text: 'Debris sia 50', anchor_key: ANCHOR, review_origin: 'operator_entered', forgewing_proposal_id: null,
    }] });
    const d = deps({ provider: port });
    expect(await runValueReading(reviewed.client, INPUT, d.value)).toMatchObject({ status: 'refused', reason: 'target_not_open' });
    expect(d.eligibility).not.toHaveBeenCalled();
  });
});

describe('value-reading request and output contracts (B4.3)', () => {
  it('parses only the case ids the queue issues', () => {
    expect(parseUnreadableLineCaseId(CASE_ID)).toEqual({ documentId: DOC, anchorKey: ANCHOR });
    expect(parseUnreadableLineCaseId(`finding:${DOC}`)).toBeNull();
  });

  it('pins the binding, crop, excerpts, model and prompt in one deterministic digest', () => {
    const binding = {
      organizationId: ORG, projectId: PROJECT, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      extractionSnapshotId: 'extraction-1', resolutionCaseId: CASE_ID, physicalPageNumber: 8, pageRepresentationDigest: DIGEST,
      factKey: 'contract_rate_row' as const, anchorKey: ANCHOR, sourceObservationIds: ['o1', 'o2'],
      sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 1, x_max: 6, y_min: 3, y_max: 4 }] },
    };
    const base = { binding, targetLineText: 't', neighbouringLineTexts: ['n'], includeTextExcerpts: false, model: null };
    const digest = buildValueReadingRequest(base).requestDigestSha256;
    expect(buildValueReadingRequest(base).requestDigestSha256).toBe(digest);
    // A new extraction run of an identical page is the same request.
    expect(buildValueReadingRequest({ ...base, binding: { ...binding, extractionSnapshotId: 'extraction-9' } })
      .requestDigestSha256).toBe(digest);
    for (const changed of [
      { ...base, binding: { ...binding, pageRepresentationDigest: 'b'.repeat(64) } },
      { ...base, binding: { ...binding, organizationId: 'org-2' } },
      { ...base, includeTextExcerpts: true },
      { ...base, model: 'model-x' },
    ]) {
      expect(buildValueReadingRequest(changed).requestDigestSha256).not.toBe(digest);
    }
  });

  it('never repairs output and carries no model self-reported certainty', () => {
    expect(parseValueReadingOutput(VALUE_OUTPUT)).toMatchObject({ ok: true });
    expect(parseValueReadingOutput('```json\n' + VALUE_OUTPUT + '\n```')).toMatchObject({ ok: false, reason: 'invalid_json' });
    expect(parseValueReadingOutput(JSON.stringify({ reading: 'unreadable', rationale: '   ' })))
      .toMatchObject({ ok: false, reason: 'invalid_proposal' });
  });
});
