import { afterEach, describe, expect, it, vi } from 'vitest';

const runForgewingRegionClassification = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  reason: 'forgewing_disabled' as const,
})));
const runForgewingTableContinuation = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  reason: 'no_candidate_pairs' as const,
})));
const runForgewingColumnMapping = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  reason: 'no_candidate_tables' as const,
})));
const runForgewingObservationArbitration = vi.hoisted(() => vi.fn(async () => ({
  status: 'skipped' as const,
  reason: 'no_candidate_targets' as const,
})));

vi.mock('@/lib/forgewing/tasks/regionClassification', () => ({
  runForgewingRegionClassification,
}));
vi.mock('@/lib/forgewing/tasks/tableContinuation', () => ({
  runForgewingTableContinuation,
}));
vi.mock('@/lib/forgewing/tasks/columnMapping', () => ({
  runForgewingColumnMapping,
}));
vi.mock('@/lib/forgewing/tasks/observationArbitration', () => ({
  runForgewingObservationArbitration,
}));

vi.mock('@/lib/forgewing/runtime/modelConfig', () => ({
  isForgewingShadowEnabled: () => process.env.FORGEWING_SHADOW_ENABLED === '1',
  isForgewingColumnMappingEnabled: () => process.env.FORGEWING_SHADOW_ENABLED === '1'
    && process.env.FORGEWING_COLUMN_MAPPING_ENABLED === '1',
  isForgewingTableContinuationEnabled: () => process.env.FORGEWING_SHADOW_ENABLED === '1'
    && process.env.FORGEWING_TABLE_CONTINUATION_ENABLED === '1',
  isForgewingObservationArbitrationEnabled: () => process.env.FORGEWING_SHADOW_ENABLED === '1'
    && process.env.FORGEWING_OBSERVATION_ARBITRATION_ENABLED === '1',
}));

import {
  captureStorageObjectVersion,
  persistExtractionComplianceShadow,
  publishExtractionComplianceShadowNonBlocking,
  scheduleExtractionComplianceShadow,
  withForgewingRegionClassificationShadow,
} from '@/lib/extraction/persistence/complianceShadow';

function actionableResult(
  status: 'applied' | 'abstained' = 'applied',
  warnings: readonly string[] = [],
) {
  return {
    status,
    warnings,
    metadata: {
      model: 'claude-test',
      promptTemplateId: 'forgewing-region-classification',
      promptTemplateVersion: '1',
      timeoutMs: 100,
      maxOutputTokens: 100,
      calls: 1,
      inputTruncated: false,
    },
    bundle: {
      schemaVersion: 'forgewing-proposal-v1',
      authority: 'non_authoritative',
      run: {
        runId: 'forgewing-run-1',
        organizationId: 'organization-1',
        extractionSnapshotId: 'snapshot-1',
        inputSnapshotHash: 'a'.repeat(64),
      },
      taskId: 'task-1',
      taskType: 'region_classification',
      proposals: status === 'applied' ? [{
        sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
      }] : [],
      abstentions: status === 'abstained' ? [{
        sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
      }] : [],
    },
  };
}

describe('compliance shadow dual-write isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    runForgewingRegionClassification.mockClear();
    runForgewingTableContinuation.mockClear();
    runForgewingColumnMapping.mockClear();
    runForgewingObservationArbitration.mockClear();
  });

  it('keeps observation arbitration default-off before candidate construction or persistence', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = { interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] };
    const register = vi.fn();
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => payload), 'organization-1', 'document-1',
      { register, persist: vi.fn(async () => { throw new Error('must not persist'); }) },
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [],
      get region_candidates() { throw new Error('must not map candidates when disabled'); },
      get arbitration_decisions() { throw new Error('must not map decisions when disabled'); },
      verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(runForgewingObservationArbitration).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('maps existing arbitration artifacts only inside a detached task and isolates persistence failure', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_OBSERVATION_ARBITRATION_ENABLED', '1');
    const payload = { interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] };
    const result = actionableResult('applied');
    result.metadata.promptTemplateId = 'forgewing-observation-arbitration';
    result.bundle.schemaVersion = 'forgewing-observation-arbitration-proposal-v1';
    result.bundle.taskType = 'observation_arbitration';
    runForgewingObservationArbitration.mockResolvedValueOnce(result as never);
    const tasks: Array<() => Promise<void>> = [];
    const persist = vi.fn(async () => { throw new Error('storage unavailable'); });
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => payload), 'organization-1', 'document-1',
      { register: (task) => tasks.push(task), persist },
    );
    const signal = { value: 0.8, basis_artifact_ids: ['token-a'], calculator: {}, diagnostics: [] };
    const candidate = (id: string, text: string, stage: string, order: number) => ({
      id, organization_id: 'organization-1', source_document_id: 'document-1',
      source_artifact_id: 'artifact-1', extraction_run_id: 'run-1',
      page_artifact_id: 'page-1', source_sha256: 'a'.repeat(64), parser_manifest_hash: 'manifest-1',
      kind: 'region', page: 1,
      bounding_box: { coordinate_space: 'page_normalized', origin: 'top_left', x0: .1, y0: .1, x1: .9, y1: .2, rotation: 0 },
      raw_text: text, parser: { stage, name: stage, version: 'v1', configuration_hash: 'config-1' },
      recognition_confidence: 0.8, reading_order: order, region_role: 'unknown',
      child_fragment_ids: [`token-${id}`], ordered_token_ids: [`token-${id}`],
      engine_reported_confidence: 0.8,
      quality_signals: { glyph_validity: signal, geometry_coverage: signal, reading_order_consistency: signal, image_text_coverage: null },
      physical_page_coordinate: {
        mappingState: 'resolved_physical_page', sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
        physicalPageNumber: 1, artifactLocalIndex: 0, sourceLayer: stage === 'native_text' ? 'pdf_native_text' : 'ocr',
      },
    });
    const candidates = [candidate('candidate-a', '12.50', 'native_text', 1), candidate('candidate-b', '125.00', 'ocr', 2)];
    const decision = {
      id: 'decision-1', organization_id: 'organization-1', source_document_id: 'document-1',
      source_artifact_id: 'artifact-1', extraction_run_id: 'run-1', source_sha256: 'a'.repeat(64),
      parser_manifest_hash: 'manifest-1', page_artifact_id: 'page-1', parser: {},
      physical_region_id: 'candidate-a', candidate_ids: ['candidate-a', 'candidate-b'],
      accepted_candidate_ids: [], rejected_candidate_ids: ['candidate-a', 'candidate-b'],
      agreement: null, decision: 'conflict', diagnostics: ['Conflicting high-quality candidates remain.'],
    };
    const input = {
      extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [],
      region_candidates: candidates, arbitration_decisions: [decision], verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    };
    const inputBefore = JSON.stringify(input);
    await expect(bridge?.(input as never)).resolves.toBe(payload);
    expect(runForgewingObservationArbitration).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(JSON.stringify(input)).toBe(inputBefore);
    expect(runForgewingObservationArbitration).toHaveBeenCalledWith(expect.objectContaining({
      regionCandidates: expect.arrayContaining([
        expect.objectContaining({ candidateId: 'candidate-a', rawText: '12.50' }),
        expect.objectContaining({ candidateId: 'candidate-b', rawText: '125.00' }),
      ]),
      arbitrationDecisions: [expect.objectContaining({ targetId: 'decision-1', deterministicState: 'conflict' })],
    }));
    expect(persist).toHaveBeenCalledOnce();
  });

  it('keeps column mapping default-off before candidate mapping, provider, or persistence', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = { interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] };
    const register = vi.fn();
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => payload), 'organization-1', 'document-1',
      { register, persist: vi.fn(async () => { throw new Error('must not persist'); }) },
    );
    const input = { extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [], verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z' };
    await expect(bridge?.(input as never)).resolves.toBe(payload);
    expect(runForgewingColumnMapping).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('maps only ambiguous deterministic column signals in a detached task and contains persistence failure', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_COLUMN_MAPPING_ENABLED', '1');
    const deterministicPayload = {
      interpretation_snapshot: { status: 'partial' },
      semantic_column_mappings: [{
        id: 'mapping-1', table_segment_id: 'segment-1', column_index: 0,
        domain_role: 'other', status: 'ambiguous',
        assessment: {
          candidate_roles: [{ role: 'rate', score: .6 }],
          resolution_policy: { observed_top_score: .6, observed_margin: .05, minimum_score: .7, minimum_margin: .2 },
          decision_evidence: { ambiguity_reason: 'below_minimum_margin' },
        },
      }, {
        id: 'mapping-resolved', table_segment_id: 'segment-1', column_index: 1,
        domain_role: 'description', status: 'resolved', assessment: {},
      }],
      interpretation_records: [],
    };
    const columnResult = actionableResult('applied');
    columnResult.metadata.promptTemplateId = 'forgewing-column-mapping';
    columnResult.bundle.schemaVersion = 'forgewing-column-mapping-proposal-v1';
    columnResult.bundle.taskType = 'column_mapping';
    runForgewingColumnMapping.mockResolvedValueOnce(columnResult as never);
    const tasks: Array<() => Promise<void>> = [];
    const persist = vi.fn(async () => { throw new Error('storage unavailable'); });
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => deterministicPayload), 'organization-1', 'document-1',
      { register: (task) => tasks.push(task), persist },
    );
    const input = { extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [], verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z' };
    await expect(bridge?.(input as never)).resolves.toBe(deterministicPayload);
    expect(runForgewingColumnMapping).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(runForgewingColumnMapping).toHaveBeenCalledWith(expect.objectContaining({
      mappingSignals: [expect.objectContaining({ mappingId: 'mapping-1', columnIndex: 0 })],
    }));
    const columnTaskCalls = (runForgewingColumnMapping as unknown as {
      mock: { calls: Array<[unknown]> };
    }).mock.calls;
    expect(JSON.stringify(columnTaskCalls[0]?.[0])).not.toContain('description');
    expect(persist).toHaveBeenCalledOnce();
  });

  it('keeps table continuation default-off before mapping, provider, or persistence', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = { interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] };
    const register = vi.fn();
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => payload),
      'organization-1',
      'document-1',
      { register, persist: vi.fn(async () => { throw new Error('must not persist'); }) },
    );
    const input = { extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [], verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z' };
    await expect(bridge?.(input as never)).resolves.toBe(payload);
    expect(runForgewingTableContinuation).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('runs table continuation only in the detached registration and contains persistence failure', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_TABLE_CONTINUATION_ENABLED', '1');
    const payload = { interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] };
    const continuation = actionableResult('applied') as ReturnType<typeof actionableResult> & { bundle: ReturnType<typeof actionableResult>['bundle'] };
    continuation.metadata.promptTemplateId = 'forgewing-table-continuation';
    continuation.bundle.schemaVersion = 'forgewing-table-continuation-proposal-v1';
    continuation.bundle.taskType = 'table_continuation';
    runForgewingTableContinuation.mockResolvedValueOnce(continuation as never);
    const tasks: Array<() => Promise<void>> = [];
    const persist = vi.fn(async () => { throw new Error('storage unavailable'); });
    const bridge = withForgewingRegionClassificationShadow(
      vi.fn(async () => payload),
      'organization-1',
      'document-1',
      { register: (task) => tasks.push(task), persist },
    );
    const input = { extraction_snapshot_id: 'snapshot-1', chains: [], continuation_links: [], segments: [], cells: [], verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z' };
    await expect(bridge?.(input as never)).resolves.toBe(payload);
    expect(runForgewingTableContinuation).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    await expect(tasks[0]!()).resolves.toBeUndefined();
    expect(runForgewingTableContinuation).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('returns the deterministic Step 3 payload unchanged while Forgewing observes shadow input', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = {
      interpretation_snapshot: { id: 'interpretation-1' },
      semantic_column_mappings: [{ id: 'mapping-1' }],
      interpretation_records: [{ id: 'record-1' }],
    };
    const deterministicBridge = vi.fn(async () => payload);
    const bridge = withForgewingRegionClassificationShadow(
      deterministicBridge,
      'organization-1',
      'document-1',
    );
    const bridgeInput = {
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    };

    await expect(bridge?.(bridgeInput as never)).resolves.toBe(payload);
    expect(deterministicBridge).toHaveBeenCalledWith(bridgeInput);
    expect(runForgewingRegionClassification).toHaveBeenCalledOnce();
  });

  it('does no Forgewing input work or provider orchestration when default-off', async () => {
    const payload = {
      interpretation_snapshot: null,
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
      { register: () => undefined },
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      get chains() { throw new Error('must not slice when disabled'); },
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(runForgewingRegionClassification).not.toHaveBeenCalled();
  });

  it('contains Forgewing failure after deterministic Step 3 succeeds', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const payload = {
      interpretation_snapshot: null,
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    runForgewingRegionClassification.mockRejectedValueOnce(new Error('provider failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
      { register: () => undefined },
    );

    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(consoleError).toHaveBeenCalledWith(
      '[forgewingShadow] non-fatal region classification failure',
      expect.objectContaining({ mode: 'shadow', error: 'provider failed' }),
    );
    consoleError.mockRestore();
  });

  it.each([
    ['success', actionableResult('applied')],
    ['timeout', actionableResult('abstained', ['provider_timeout'])],
    ['schema rejection', actionableResult('abstained', ['model_schema_rejected'])],
  ])('keeps deterministic Step 3 identical on Forgewing %s', async (_case, outcome) => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    runForgewingRegionClassification.mockResolvedValueOnce(outcome as never);
    const payload = {
      interpretation_snapshot: { id: 'deterministic' },
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
      { register: () => undefined },
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
  });

  it('returns deterministic Step 3 without waiting for a never-settling persistence task', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    runForgewingRegionClassification.mockResolvedValueOnce(actionableResult() as never);
    const payload = {
      interpretation_snapshot: { id: 'deterministic' },
      semantic_column_mappings: [],
      interpretation_records: [],
    };
    const registered: Array<() => Promise<void>> = [];
    const persist = vi.fn(() => new Promise<never>(() => undefined));
    const bridge = withForgewingRegionClassificationShadow(
      async () => payload,
      'organization-1',
      'document-1',
      { register: (task) => registered.push(task), persist },
    );

    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1',
      chains: [],
      segments: [],
      cells: [],
      verified_field_handles: [],
      published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBe(payload);
    expect(registered).toHaveLength(1);
    expect(persist).not.toHaveBeenCalled();
    void registered[0]!();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('does not register persistence for skipped or pre-bundle failed results', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const register = vi.fn();
    for (const result of [
      { status: 'skipped', reason: 'no_candidate_regions' },
      {
        status: 'failed', reason: 'input_contract_violation', warnings: ['input_contract_violation'],
        metadata: actionableResult().metadata,
      },
    ]) {
      runForgewingRegionClassification.mockResolvedValueOnce(result as never);
      const bridge = withForgewingRegionClassificationShadow(
        async () => ({ interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] }),
        'organization-1',
        'document-1',
        { register },
      );
      await bridge?.({
        extraction_snapshot_id: 'snapshot-1', chains: [], segments: [], cells: [],
        verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z',
      } as never);
    }
    expect(register).not.toHaveBeenCalled();
  });

  it('contains persistence registration and task failures', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runForgewingRegionClassification.mockResolvedValueOnce(actionableResult() as never);
    const bridge = withForgewingRegionClassificationShadow(
      async () => ({ interpretation_snapshot: null, semantic_column_mappings: [], interpretation_records: [] }),
      'organization-1',
      'document-1',
      { register: () => { throw new Error('lifecycle unavailable'); } },
    );
    await expect(bridge?.({
      extraction_snapshot_id: 'snapshot-1', chains: [], segments: [], cells: [],
      verified_field_handles: [], published_at: '2026-08-14T00:00:00.000Z',
    } as never)).resolves.toBeDefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[forgewingShadow] persistence registration failed',
      expect.objectContaining({ error: 'lifecycle unavailable' }),
    );
    consoleError.mockRestore();
  });
  it('is non-fatal and never mutates the legacy extraction payload', async () => {
    const payload = {
      extraction: { mode: 'pdf_text', text_preview: 'unchanged' },
      fields: { typed_fields: { amount: 10 } },
    };
    const before = structuredClone(payload);
    const admin = {
      from: vi.fn(() => {
        throw new Error('new tables unavailable');
      }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await publishExtractionComplianceShadowNonBlocking({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageObjectVersion: 'object-id:2026-07-23T00:00:00.000Z',
      mediaType: 'text/plain',
      legacyExtractionPayload: payload,
      analysisJobId: 'job-1',
      analysisMode: 'heuristic',
    });

    expect(result).toBeNull();
    expect(payload).toEqual(before);
    expect(consoleError).toHaveBeenCalledWith(
      '[extractionComplianceShadow] non-fatal publish failure',
      expect.objectContaining({
        mode: 'shadow',
        sourceDocumentId: 'document-1',
      }),
    );
    consoleError.mockRestore();
  });

  it('hashes configured parser assignment independently of transient output success', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    vi.stubEnv('OPENAI_API_KEY', 'configured');
    vi.stubEnv('UNSTRUCTURED_API_KEY', 'configured');
    const rpc = vi.fn(async () => ({
      data: {
        source_artifact_id: 'source-1',
        extraction_run_id: 'run-1',
        extraction_snapshot_id: 'snapshot-1',
        interpretation_snapshot_id: 'interpretation-1',
      },
      error: null,
    }));
    const base = {
      admin: { rpc } as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('same source').buffer,
      storageObjectVersion: 'object-1:version-1',
      mediaType: 'application/pdf',
      analysisMode: 'deterministic',
    };
    const first = await persistExtractionComplianceShadow({
      ...base,
      analysisJobId: 'job-1',
      legacyExtractionPayload: { extraction: { parsed_elements_v1: { status: 'failed' } } },
    });
    const second = await persistExtractionComplianceShadow({
      ...base,
      analysisJobId: 'job-2',
      legacyExtractionPayload: {
        extraction: {
          parsed_elements_v1: { status: 'available' },
          content_layers_v1: { pdf: { tables: [{ id: 'vision:p1:t1' }] } },
        },
      },
    });
    expect(first.parserManifestHash).toBe(second.parserManifestHash);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('bounds a storage identity lookup that never settles', async () => {
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(() => new Promise(() => undefined)),
        })),
      },
    };

    await expect(captureStorageObjectVersion(
      admin as never,
      'documents',
      'org-1/document-1.pdf',
      1,
    )).resolves.toBeNull();
  });

  it('bounds compliance publication that never settles', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(async () => ({
            data: { id: 'object-1', version: 'version-1' },
            error: null,
          })),
        })),
      },
      rpc: vi.fn(() => new Promise(() => undefined)),
    };

    const task = scheduleExtractionComplianceShadow({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageBucket: 'documents',
      storagePath: 'org-1/document-1.pdf',
      storageVersionBeforeDownload: 'version-1:object-1',
      mediaType: 'application/pdf',
      legacyExtractionPayload: {},
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(admin.rpc).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(task).resolves.toBeUndefined();
  });

  it('bounds pending Step 1 publication without changing the caller lifecycle', async () => {
    vi.useFakeTimers();
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(async () => ({
            data: { id: 'object-1', version: 'version-1' },
            error: null,
          })),
        })),
      },
      rpc: vi.fn(() => new Promise(() => undefined)),
    };

    const task = scheduleExtractionComplianceShadow({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageBucket: 'documents',
      storagePath: 'org-1/document-1.pdf',
      storageVersionBeforeDownload: 'version-1:object-1',
      mediaType: 'application/pdf',
      legacyExtractionPayload: {},
      locatedObservations: { pages: [] },
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(admin.rpc).toHaveBeenCalledWith(
      'resolve_extraction_step1_source',
      expect.any(Object),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(task).resolves.toBeUndefined();
  });

  it('keeps rejected Step 1 publication nonfatal', async () => {
    vi.stubEnv('EIGHTFORGE_BUILD_DIGEST', 'build-digest-1');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const admin = {
      storage: {
        from: vi.fn(() => ({
          info: vi.fn(async () => ({
            data: { id: 'object-1', version: 'version-1' },
            error: null,
          })),
        })),
      },
      rpc: vi.fn(async () => {
        throw new Error('Step 1 unavailable');
      }),
    };

    await expect(scheduleExtractionComplianceShadow({
      admin: admin as never,
      organizationId: 'org-1',
      sourceDocumentId: 'document-1',
      sourceBytes: new TextEncoder().encode('source bytes').buffer,
      storageBucket: 'documents',
      storagePath: 'org-1/document-1.pdf',
      storageVersionBeforeDownload: 'version-1:object-1',
      mediaType: 'application/pdf',
      legacyExtractionPayload: {},
      locatedObservations: { pages: [] },
      analysisJobId: 'job-1',
      analysisMode: 'deterministic',
    })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      '[extractionStep1Shadow] non-fatal publish failure',
      expect.objectContaining({
        mode: 'shadow',
        sourceDocumentId: 'document-1',
      }),
    );
    consoleError.mockRestore();
  });
});
