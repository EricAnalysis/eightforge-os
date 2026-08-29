import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  persistExtractionStep1Shadow,
  publishExtractionStep1ShadowNonBlocking,
} from '@/lib/extraction/persistence/step1Shadow';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { hashParserManifest, type ParserManifest } from '@/lib/extraction/domain/parserManifest';
import type { Step3InterpretationBridgeInput } from '@/lib/extraction/domain/step3InterpretationBridge';

const SOURCE_ID = '10000000-0000-4000-8000-000000000001';
const DOCUMENT_ID = '20000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = '30000000-0000-4000-8000-000000000001';
const SOURCE_SHA = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';

function extractFunction(sql: string, name: string): string {
  const match = new RegExp(
    `CREATE OR REPLACE FUNCTION public\\.${name}\\(payload jsonb\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
  ).exec(sql);
  if (!match?.[1]) throw new Error(`missing SQL function ${name}`);
  return match[1];
}

function consumedKeys(sqlFunction: string, variable: 'payload' | 'item'): Set<string> {
  return new Set(
    [...sqlFunction.matchAll(new RegExp(`${variable}->>?\\s*'([^']+)'`, 'g'))]
      .map((match) => match[1]),
  );
}

function collectionLoop(sqlFunction: string, collection: string): string {
  const match = new RegExp(
    `FOR item IN[\\s\\S]*?jsonb_array_elements\\(payload->'${collection}'\\)[\\s\\S]*?LOOP([\\s\\S]*?)END LOOP;`,
  ).exec(sqlFunction);
  if (!match?.[1]) throw new Error(`missing SQL loop for ${collection}`);
  return match[1];
}

function client(options?: { rejectPublish?: boolean }) {
  const calls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (
    name: string,
    args: { payload: Record<string, unknown> },
  ) => {
    calls.push({ name, payload: args.payload });
    if (name === 'resolve_extraction_step1_source') {
      return {
        data: {
          source_artifact_id: SOURCE_ID,
          organization_id: ORGANIZATION_ID,
          source_document_id: DOCUMENT_ID,
          source_sha256: SOURCE_SHA,
          storage_object_version: 'object:version:1',
          media_type_sniffed: 'application/pdf',
          byte_length: 3,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        error: null,
      };
    }
    if (options?.rejectPublish) {
      return { data: null, error: { message: 'publication rejected' } };
    }
    const payload = args.payload;
    return {
      data: {
        source_artifact_id: SOURCE_ID,
        extraction_run_id: payload.run_id,
        extraction_snapshot_id: payload.snapshot_id,
        reused: false,
      },
      error: null,
    };
  });
  return {
    admin: { rpc } as never,
    calls,
  };
}

function input(admin: never) {
  return {
    admin,
    organizationId: ORGANIZATION_ID,
    sourceDocumentId: DOCUMENT_ID,
    sourceBytes: new Uint8Array([1, 2, 3]).buffer,
    storageObjectVersion: 'object:version:1',
    mediaType: 'application/pdf',
    legacyExtractionPayload: {
      fields: { typed_fields: { total: 'unanchored legacy value' } },
      extraction: {},
    },
    locatedObservations: {
      pages: [{
        page_number: 1,
        render_sha256: 'a'.repeat(64),
        width: 100,
        height: 200,
        text_detected: true,
        physical_page_provenance: { state: 'iterated', seed: {
          physical_page_number: 1,
          total_physical_pages: 7,
          source_layer: 'pdf_page_render',
          artifact_local_index: 0,
        } },
        words: [{
          text: 'Observed',
          confidence: 99,
          bbox: { x0: 10, y0: 20, x1: 50, y1: 40 },
        }],
      }],
    },
    analysisJobId: 'job-1',
    analysisMode: 'heuristic',
    observedAt: '2026-07-24T00:00:00.000Z',
  } as const;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Step 1 shadow persistence', () => {
  it('forwards deterministic continuation and arbitration artifacts through the Step 3 bridge unchanged', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const mock = client();
    const baseInput = input(mock.admin);
    const enginePages = (['native', 'ocr'] as const).map((engine) => ({
      ...baseInput.locatedObservations.pages[0],
      words: [{
        ...baseInput.locatedObservations.pages[0]!.words[0]!,
        text: engine === 'native' ? 'Observed' : 'Obserwed',
      }],
      physical_page_provenance: { state: 'iterated' as const, seed: {
        physical_page_number: 1,
        total_physical_pages: 7,
        source_layer: engine === 'native' ? 'pdf_native_text' as const : 'ocr' as const,
        artifact_local_index: 0,
      } },
      engine,
      parser: {
        stage: engine === 'native' ? 'native_text' as const : 'ocr' as const,
        name: engine,
        version: 'v1',
        configuration_hash: `${engine}-configuration`,
      },
    }));
    const enginePagesBefore = JSON.stringify(enginePages);
    const bridge = vi.fn(async (bridgeInput: Step3InterpretationBridgeInput) => {
      expect(bridgeInput).toBeDefined();
      return {
        interpretation_snapshot: null,
        semantic_column_mappings: [],
        interpretation_records: [],
      };
    });
    await persistExtractionStep1Shadow({
      ...baseInput,
      locatedObservations: { ...baseInput.locatedObservations, engine_pages: enginePages },
      step3InterpretationBridge: bridge,
    });
    const publishPayload = mock.calls.find(
      (call) => call.name === 'publish_extraction_step1_shadow',
    )?.payload;
    expect(bridge).toHaveBeenCalledOnce();
    expect(bridge.mock.calls[0]?.[0]).toHaveProperty('continuation_links');
    expect(bridge.mock.calls[0]?.[0].continuation_links).toBe(
      publishPayload?.continuation_links,
    );
    expect(bridge.mock.calls[0]?.[0].arbitration_decisions).toBe(
      publishPayload?.arbitration_decisions,
    );
    const bridgeCandidates = bridge.mock.calls[0]?.[0].region_candidates ?? [];
    const persistedFragments = publishPayload?.fragments as readonly unknown[];
    expect(bridgeCandidates.length).toBeGreaterThan(0);
    for (const candidate of bridgeCandidates) {
      expect(persistedFragments).toContain(candidate);
    }
    expect(JSON.stringify(enginePages)).toBe(enginePagesBefore);
    expect(bridge.mock.calls[0]?.[0].arbitration_decisions)
      .toEqual([expect.objectContaining({ decision: 'conflict' })]);
  });

  it('protects the shared shadow assignment from stale Step 0 or Step 1 writers', () => {
    const migration = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations/20260724010000_phase3_step1_shadow_publication.sql',
      ),
      'utf8',
    );
    const roleMigration = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations/20260727020000_persist_candidate_fragment_dependency_roles.sql',
      ),
      'utf8',
    );
    expect(roleMigration).toContain("item->'source_fragment_dependencies'");
    expect(migration).toContain('enforce_shadow_assignment_monotonic');
    expect(migration).toContain("OLD.activation_mode <> 'shadow'");
    expect(migration).toContain('NEW.assigned_at < OLD.assigned_at');
    expect(migration).toContain("'assignment_updated', assignment_updated");
  });

  it('sends the production-built payload shape consumed by both SQL RPCs', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const mock = client();
    const result = await persistExtractionStep1Shadow(input(mock.admin));
    expect(result).toMatchObject({
      candidateCount: 1,
      verifiedFieldCount: 1,
      gapCount: 1,
      skippedRecordCount: 1,
    });

    const migration = fs.readFileSync(
      path.join(
        process.cwd(),
        'supabase/migrations/20260724010000_phase3_step1_shadow_publication.sql',
      ),
      'utf8',
    );
    const sourceCall = mock.calls.find(
      (call) => call.name === 'resolve_extraction_step1_source',
    );
    const publishCall = mock.calls.find(
      (call) => call.name === 'publish_extraction_step1_shadow',
    );
    expect(sourceCall).toBeDefined();
    expect(publishCall).toBeDefined();

    const sourceSqlKeys = consumedKeys(
      extractFunction(migration, 'resolve_extraction_step1_source'),
      'payload',
    );
    const publishSql = extractFunction(migration, 'publish_extraction_step1_shadow');
    const publishSqlKeys = consumedKeys(publishSql, 'payload');
    const sourcePayloadKeys = new Set(Object.keys(sourceCall?.payload ?? {}));
    const publishPayloadKeys = new Set(Object.keys(publishCall?.payload ?? {}));
    expect([...sourceSqlKeys].filter((key) => !sourcePayloadKeys.has(key))).toEqual([]);
    expect([...publishSqlKeys].filter((key) => !publishPayloadKeys.has(key))).toEqual([]);

    const payload = publishCall?.payload ?? {};
    expect(payload.completed_at).toBe('2026-07-24T00:00:00.000Z');
    expect(payload.artifact_schema_version).toBe('extraction-artifact-v2');
    expect(payload.parser_manifest).toEqual(expect.objectContaining({
      artifact_schema_version: 'extraction-artifact-v1',
    }));
    const parserManifest = payload.parser_manifest as ParserManifest;
    const parserManifestHash = hashParserManifest(parserManifest);
    expect(payload.parser_manifest_hash).toBe(parserManifestHash);
    expect(payload.idempotency_key).toBe(`step1-shadow:${hashCanonical({
      source_artifact_id: SOURCE_ID,
      parser_manifest_hash: parserManifestHash,
      artifact_schema_version: 'extraction-artifact-v2',
    })}`);
    expect(payload.pages).toEqual([expect.objectContaining({
      physical_page_coordinate: expect.objectContaining({
        sourceDocumentId: DOCUMENT_ID,
        sourceArtifactId: SOURCE_ID,
        physicalPageNumber: 1,
        sourceLayer: 'pdf_page_render',
        artifactLocalIndex: 0,
        mappingState: 'resolved_physical_page',
        mappingBasis: 'extractor_iterated_physical_page',
      }),
    })]);
    expect(payload.fragments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'token',
        physical_page_coordinate: expect.objectContaining({
          sourceDocumentId: DOCUMENT_ID,
          sourceArtifactId: SOURCE_ID,
          physicalPageNumber: 1,
          sourceLayer: 'ocr',
          mappingState: 'resolved_physical_page',
          mappingBasis: 'inherited_from_proven_parent',
        }),
      }),
    ]));
    for (const key of [
      'pages',
      'fragments',
      'candidates',
      'verified_fields',
      'gaps',
      'snapshot_members',
    ]) {
      expect(Array.isArray(payload[key]), `${key} must serialize as an array`).toBe(true);
    }
    expect(payload.candidates).toEqual([
      expect.objectContaining({
        source_fragment_dependencies: [{
          fragment_artifact_id: expect.any(String),
          dependency_role: 'content',
        }],
      }),
    ]);
    for (const collection of [
      'pages',
      'fragments',
      'candidates',
      'verified_fields',
      'gaps',
      'snapshot_members',
    ]) {
      const items = payload[collection] as Record<string, unknown>[];
      const keys = consumedKeys(collectionLoop(publishSql, collection), 'item');
      for (const key of keys) {
        expect(
          items.some((item) => Object.hasOwn(item, key)),
          `production ${collection} omit SQL-consumed key ${key}`,
        ).toBe(true);
      }
    }

    const artifactCollections = {
      page: payload.pages as Record<string, unknown>[],
      fragment: payload.fragments as Record<string, unknown>[],
      candidate: payload.candidates as Record<string, unknown>[],
      verified_field: payload.verified_fields as Record<string, unknown>[],
      gap: payload.gaps as Record<string, unknown>[],
      continuation_link: payload.continuation_links as Record<string, unknown>[],
      table_chain: payload.table_chains as Record<string, unknown>[],
      table_section: payload.table_sections as Record<string, unknown>[],
      arbitration_decision: payload.arbitration_decisions as Record<string, unknown>[],
    };
    const members = payload.snapshot_members as Array<Record<string, unknown>>;
    for (const member of members) {
      const kind = member.member_kind as keyof typeof artifactCollections;
      const idKey = {
        page: 'page_artifact_id',
        fragment: 'fragment_artifact_id',
        candidate: 'field_candidate_id',
        verified_field: 'verified_field_id',
        gap: 'processing_gap_id',
        continuation_link: 'continuation_link_id',
        table_chain: 'table_chain_id',
        table_section: 'table_section_id',
        arbitration_decision: 'arbitration_decision_id',
      }[kind];
      const artifact = artifactCollections[kind].find(
        (item) => item.id === member[idKey],
      );
      expect(artifact).toBeDefined();
      expect(member.dependency_hash).toBe(hashCanonical(artifact));
    }
    expect(payload.artifact_root_hash).toBe(hashCanonical({
      artifact_schema_version: payload.artifact_schema_version,
      members: members.map((member) => ({
        member_kind: member.member_kind,
        dependency_hash: member.dependency_hash,
        sequence: member.sequence,
      })),
    }));
  });

  it('serializes decode failure through the existing Step 1 publication RPC', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const mock = client();
    const result = await persistExtractionStep1Shadow({
      ...input(mock.admin),
      locatedObservations: {
        pages: [],
        content_gaps: [{
          gap_key: `step2:decode_failure:${SOURCE_SHA}`,
          stage: 'source_ingest',
          reason: 'decode_failure',
          retryable: false,
          attempts: 1,
          error_category: 'InvalidPDFException',
        }],
      },
    });
    const payload = mock.calls.find(
      (call) => call.name === 'publish_extraction_step1_shadow',
    )?.payload;

    expect(result).toMatchObject({ gapCount: 2 });
    expect(payload).toMatchObject({
      run_status: 'partial_terminal',
      snapshot_status: 'partial',
      gaps: expect.arrayContaining([expect.objectContaining({
        gap_key: `step2:decode_failure:${SOURCE_SHA}`,
        page: null,
        bounding_box: null,
        stage: 'source_ingest',
        reason: 'decode_failure',
        retryable: false,
        attempts: 1,
      })]),
    });
  });

  it('builds one convergent graph for concurrent unchanged-source publication', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const first = client();
    const second = client();
    await Promise.all([
      persistExtractionStep1Shadow(input(first.admin)),
      persistExtractionStep1Shadow(input(second.admin)),
    ]);
    const firstPayload = first.calls.find(
      (call) => call.name === 'publish_extraction_step1_shadow',
    )?.payload;
    const secondPayload = second.calls.find(
      (call) => call.name === 'publish_extraction_step1_shadow',
    )?.payload;
    expect(firstPayload).toMatchObject({
      run_id: secondPayload?.run_id,
      snapshot_id: secondPayload?.snapshot_id,
      artifact_root_hash: secondPayload?.artifact_root_hash,
      content_extraction_fingerprint: secondPayload?.content_extraction_fingerprint,
    });
  });

  it('quarantines real PDF and spreadsheet legacy content-layer shapes', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const pdf = client();
    const pdfResult = await persistExtractionStep1Shadow({
      ...input(pdf.admin),
      legacyExtractionPayload: {
        extraction: {
          content_layers_v1: {
            source_kind: 'pdf',
            pdf: {
              text: { pages: [{ page_number: 1, combined_text: 'legacy' }] },
              tables: { tables: [{ id: 'table-1' }] },
              forms: { fields: [{ id: 'field-1' }] },
            },
          },
        },
      },
      locatedObservations: { pages: [] },
    });
    expect(pdfResult).toMatchObject({ candidateCount: 0, gapCount: 3 });

    const spreadsheet = client();
    const spreadsheetResult = await persistExtractionStep1Shadow({
      ...input(spreadsheet.admin),
      legacyExtractionPayload: {
        extraction: {
          content_layers_v1: {
            source_kind: 'xlsx',
            spreadsheet: {
              workbook: { sheets: [{ name: 'Tickets' }] },
            },
          },
        },
      },
      locatedObservations: { pages: [] },
    });
    expect(spreadsheetResult).toMatchObject({ candidateCount: 0, gapCount: 1 });
  });

  it('keeps a rejected publication nonfatal', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'step1-test-build');
    const mock = client({ rejectPublish: true });
    await expect(
      publishExtractionStep1ShadowNonBlocking(input(mock.admin)),
    ).resolves.toBeNull();
  });
});
