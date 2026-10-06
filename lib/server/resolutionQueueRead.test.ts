import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { readResolutionQueue, type ResolutionReadClient } from '@/lib/server/resolutionQueueRead';

const ORG = 'org-1';
const PROJECT = 'project-1';
const DOC = 'doc-1';
const DIGEST = 'a'.repeat(64);

const extraction = {
  document_id: DOC, created_at: '2026-10-04T00:00:00Z',
  data: { extraction: { content_layers_v1: { pdf: {
    text: { pages: [{ plain_text_blocks: [{ text: 'x' }] }] },
    page_extraction_coverage_v1: { pages: [{ page_number: 2, page_representation_digest: DIGEST }] },
    priced_schedule_reconstruction_v1: {
      parser_version: 'priced_schedule_reconstruction_v2', pages: [],
      unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 2,
        header_lines: [], priced_lines: [{ raw_text: 'Hauling TON $ 8.7S', y: 300, source_refs: [
          { observation_id: 'o1', text: 'Hauling', x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
          { observation_id: 'o2', text: '8.7S', x_min: 5, x_max: 6, y_min: 3, y_max: 4 },
        ] }] }],
    },
  } } } },
};

function fakeClient(tables: Record<string, unknown[]>, projectOrg = ORG) {
  const writes: string[] = [];
  const reads: string[] = [];
  const client = {
    rpc: vi.fn(async () => { writes.push('rpc'); return { data: null, error: null }; }),
    from(table: string) {
      return {
        select() {
          reads.push(table);
          const result = { data: table === 'projects' ? null : tables[table] ?? [], error: null };
          const query = {
            eq: () => query, in: () => query, is: () => query, order: () => query,
            maybeSingle: async () => ({ data: table === 'projects' ? { id: PROJECT, organization_id: projectOrg } : null, error: null }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return query;
        },
        insert: () => { writes.push(`insert:${table}`); throw new Error('write attempted'); },
        update: () => { writes.push(`update:${table}`); throw new Error('write attempted'); },
        delete: () => { writes.push(`delete:${table}`); throw new Error('write attempted'); },
      };
    },
  };
  return { client: client as unknown as ResolutionReadClient, writes, reads };
}

describe('resolution queue server read (B5-A)', () => {
  it('derives cases from existing records without writing anything', async () => {
    const { client, writes } = fakeClient({
      documents: [{ id: DOC, title: 'Contract', name: 'c.pdf', document_type: 'contract' }],
      document_extractions: [extraction],
    });
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: false });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.queue.cases).toHaveLength(1);
    expect(result.queue.cases[0]).toMatchObject({
      kind: 'unreadable_priced_line', documentId: DOC, physicalPageNumber: 2, originalSourceText: 'Hauling TON $ 8.7S',
    });
    expect(writes).toEqual([]);
  });

  it('draws the case evidence on its source page, server-side, from the same blob (B5-B)', async () => {
    const withArtifact = structuredClone(extraction);
    (withArtifact.data.extraction.content_layers_v1.pdf as Record<string, unknown>).layout_observations_v1 = {
      source_artifact_id: 'artifact-1', observations: [],
      source_page_geometries: [{ source_layer: 'ocr', physical_page_number: 2, page_representation_digest: DIGEST,
        pixel_width: 1700, pixel_height: 2200 }],
    };
    const { client } = fakeClient({
      documents: [{ id: DOC, title: 'Contract' }],
      document_extractions: [withArtifact],
    });
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: false });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.queue.cases[0]!.evidence[0]).toMatchObject({
      role: 'current',
      visual: {
        kind: 'diagnostic', sourceArtifactId: 'artifact-1', sourceDocumentId: DOC, physicalPageNumber: 2,
        pageRepresentationDigest: DIGEST, ocrPixelWidth: 1700, ocrPixelHeight: 2200,
        boxes: [{ observationId: 'o1', rawText: 'Hauling' }, { observationId: 'o2', rawText: '8.7S' }],
      },
    });
  });

  it('does not read Forgewing proposals when Forgewing is off', async () => {
    const { client } = fakeClient({ documents: [{ id: DOC, title: 'Contract' }] });
    const readRecoveryQueue = vi.fn();
    await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: false, readRecoveryQueue });
    expect(readRecoveryQueue).not.toHaveBeenCalled();
  });

  it('reads proposals per document when Forgewing is on', async () => {
    const { client } = fakeClient({ documents: [{ id: DOC, title: 'Contract' }] });
    const readRecoveryQueue = vi.fn(async () => ({ status: 'ok' as const, candidates: [] }));
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: true, readRecoveryQueue });
    expect(readRecoveryQueue).toHaveBeenCalledWith({ organizationId: ORG, sourceDocumentId: DOC }, expect.anything());
    expect(result.status === 'ok' && result.queue.forgewingSuggestionsIncluded).toBe(true);
  });

  it('lists Forgewing suggestions only for an entitled organization', async () => {
    const readRecoveryQueue = vi.fn(async () => ({ status: 'ok' as const, candidates: [] }));
    const run = async (entitled: boolean) => {
      const { client } = fakeClient({ documents: [{ id: DOC, title: 'Contract' }] });
      const resolveEntitlement = vi.fn(async () => (entitled
        ? { entitled: true as const, reason: 'entitled' as const, eventId: 'e-1' }
        : { entitled: false as const, reason: 'no_entitlement' as const }));
      const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
        { admin: client, resolveEntitlement, readRecoveryQueue });
      expect(resolveEntitlement).toHaveBeenCalledWith(expect.anything(), ORG);
      return result.status === 'ok' && result.queue.forgewingSuggestionsIncluded;
    };
    expect(await run(false)).toBe(false);
    expect(readRecoveryQueue).not.toHaveBeenCalled();
    expect(await run(true)).toBe(true);
    expect(readRecoveryQueue).toHaveBeenCalled();
  });

  it('refuses a project outside the actor organization', async () => {
    const { client, reads } = fakeClient({}, 'other-org');
    await expect(readResolutionQueue({ organizationId: ORG, projectId: PROJECT }, { admin: client, forgewingEnabled: false }))
      .resolves.toEqual({ status: 'not_found' });
    expect(reads).toEqual(['projects']);
  });

  it('keeps the manual Core queue when optional Forgewing value-reading records fail to load', async () => {
    const fake = fakeClient({ documents: [{ id: DOC }], document_extractions: [extraction] });
    const client: ResolutionReadClient = { ...fake.client, from(table) {
      if (table === 'forgewing_recovery_proposals') throw new Error('Optional value-reading store unavailable');
      return fake.client.from(table);
    } };
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT }, { admin: client,
      forgewingEnabled: true, readRecoveryQueue: vi.fn(async () => ({ status: 'ok' as const, candidates: [] })) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.queue.cases[0]!.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'record_disposition', 'open_document']);
    expect(result.queue.cases[0]!.suggestions).toEqual([]);
  });
});

describe('evidence attention in the resolution queue (Forgewing generalization, phase 1)', () => {
  // Diagnostics bind to UUID scope, exactly as production identities are.
  const UORG = '00000000-0000-4000-8000-0000000000a1';
  const UDOC = '00000000-0000-4000-8000-0000000000d1';
  it('opens a case for a priced line extraction withheld on a page it read, from the same diagnostics the panel shows', async () => {
    const withheld = { ...structuredClone(extraction), document_id: UDOC };
    const pdf = withheld.data.extraction.content_layers_v1.pdf as Record<string, unknown>;
    pdf.layout_observations_v1 = { source_artifact_id: '00000000-0000-4000-8000-0000000000f1', observations: [
      { id: 'o1', physical_page_number: 2, raw_text: 'Hauling', metadata: { page_representation_digest: DIGEST } },
      { id: 'o2', physical_page_number: 2, raw_text: '8.7S', metadata: { page_representation_digest: DIGEST } },
    ] };
    pdf.priced_schedule_reconstruction_v1 = { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
      physical_page_number: 2, status: 'reconstructed', rows: [], columns: [], unassigned_lines: [],
      rejected_spines: [{ reason: 'inconsistent_row_pitch', physical_page_number: 2, raw_text: 'Hauling TON $ 8.7S',
        source_refs: [{ observation_id: 'o1', text: 'Hauling', x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
          { observation_id: 'o2', text: '8.7S', x_min: 5, x_max: 6, y_min: 3, y_max: 4 }] }],
    }] };
    const { client, writes } = fakeClient({ documents: [{ id: UDOC, title: 'Contract' }], document_extractions: [withheld] }, UORG);
    const result = await readResolutionQueue({ organizationId: UORG, projectId: PROJECT }, { admin: client, forgewingEnabled: false });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.queue.cases).toMatchObject([{ kind: 'withheld_priced_line', documentId: UDOC, physicalPageNumber: 2,
      originalSourceText: 'Hauling TON $ 8.7S', diagnostic: { code: 'inconsistent_row_pitch', recoverability: 'not_recoverable' } }]);
    expect(result.queue.cases[0]!.actions.map((action) => action.kind)).toEqual(['enter_reviewed_value', 'record_disposition', 'open_document']);
    expect(writes).toEqual([]);
  });
  it('opens a review-required case for a published row whose rate was read from a scan, and none for a native one', async () => {
    const run = async (rateSource: 'pdfjs' | 'ocr_fallback') => {
      const doc = { ...structuredClone(extraction), document_id: UDOC };
      const pdf = doc.data.extraction.content_layers_v1.pdf as Record<string, unknown>;
      pdf.layout_observations_v1 = { source_artifact_id: '00000000-0000-4000-8000-0000000000f1', observations: [] };
      const ref = (id: string, text: string, x: number, source: string) =>
        ({ observation_id: id, text, x_min: x, x_max: x + 8, y_min: 3, y_max: 4, source });
      const cell = (role: string, id: string, text: string, x: number, source: string) =>
        ({ role, raw_text: text, source_refs: [ref(id, text, x, source)], x_min: x, x_max: x + 8, y_min: 3, y_max: 4 });
      pdf.priced_schedule_reconstruction_v1 = { parser_version: 'priced_schedule_reconstruction_v3', pages: [{
        physical_page_number: 2, status: 'reconstructed', columns: [], rejected_spines: [], unassigned_lines: [],
        rows: [{ row_index: 0, physical_page_number: 2, raw_text: 'Hauling | TON | $8.75', x_min: 1, x_max: 120, y_min: 3, y_max: 4,
          cells: [cell('description', 'o1', 'Hauling', 1, rateSource), cell('unit', 'o2', 'TON', 40, rateSource),
            cell('rate', 'o3', '$8.75', 80, rateSource)] }],
      }] };
      const { client, writes } = fakeClient({ documents: [{ id: UDOC, title: 'Contract' }], document_extractions: [doc] }, UORG);
      const result = await readResolutionQueue({ organizationId: UORG, projectId: PROJECT }, { admin: client, forgewingEnabled: false });
      expect(writes).toEqual([]);
      if (result.status !== 'ok') throw new Error(result.status);
      return result.queue.cases.filter((entry) => entry.kind === 'review_required_value');
    };
    expect(await run('ocr_fallback')).toMatchObject([{ documentId: UDOC, physicalPageNumber: 2, originalSourceText: 'Hauling | TON | $8.75' }]);
    expect(await run('pdfjs')).toEqual([]);
  });
});
