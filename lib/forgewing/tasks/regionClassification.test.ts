import { describe, expect, it, vi } from 'vitest';

import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  runForgewingRegionClassification,
  type ForgewingRegionClassificationInput,
} from '@/lib/forgewing/tasks/regionClassification';

const config = {
  enabled: true,
  model: 'claude-test',
  timeoutMs: 250,
  maxCalls: 1,
  maxOutputTokens: 800,
} as const;

function box(y0 = 0.1) {
  return {
    coordinateSpace: 'page_normalized' as const,
    origin: 'top_left' as const,
    x0: 0.1,
    y0,
    x1: 0.9,
    y1: y0 + 0.1,
    rotation: 0 as const,
  };
}

function input(overrides: Partial<ForgewingRegionClassificationInput> = {}) {
  const value: ForgewingRegionClassificationInput = {
    organizationId: 'organization-1',
    sourceDocumentId: 'document-1',
    extractionSnapshotId: 'snapshot-1',
    segments: [{
      observationId: 'segment-1',
      kind: 'segment',
      organizationId: 'organization-1',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'source-artifact-1',
      extractionSnapshotId: 'snapshot-1',
      pageArtifactId: 'page-artifact-1',
      page: 1,
      boundingBox: box(),
      text: 'Schedule of rates',
      readingOrder: 1,
      chainCompleteness: 'complete',
      detectionKinds: ['ruling_lines'],
    }],
    cells: [{
      observationId: 'cell-1',
      kind: 'cell',
      organizationId: 'organization-1',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'source-artifact-1',
      extractionSnapshotId: 'snapshot-1',
      pageArtifactId: 'page-artifact-1',
      page: 1,
      boundingBox: box(0.12),
      text: 'Labor rate',
      readingOrder: 2,
      rowStart: 0,
      rowSpan: 1,
      columnStart: 0,
      columnSpan: 1,
      structure: 'ordinary',
      targetSegmentId: 'segment-1',
    }],
    ...overrides,
  };
  return value;
}

describe('Forgewing region classification', () => {
  it('returns before slicing or calling when disabled', async () => {
    const provider = vi.fn();
    const result = await runForgewingRegionClassification({} as never, {
      config: { ...config, enabled: false },
      provider,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'forgewing_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('builds a validated non-authoritative proposal from known evidence IDs', async () => {
    const result = await runForgewingRegionClassification(input(), {
      config,
      provider: async () => JSON.stringify({
        state: 'observed',
        classification: 'rate_schedule',
        evidenceIds: ['segment-1', 'cell-1'],
        confidence: 0.8,
        rationale: 'The bounded region contains a rate table.',
      }),
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.bundle.authority).toBe('non_authoritative');
    expect(result.bundle.run).toMatchObject({
      organizationId: 'organization-1',
      extractionSnapshotId: 'snapshot-1',
    });
    expect(result.bundle.proposals[0]?.taskId).toBe(result.bundle.taskId);
    expect(result.bundle.proposals[0]).toMatchObject({
      state: 'observed',
      value: { label: 'rate_schedule' },
      inputObservationIds: ['segment-1', 'cell-1'],
    });
    expect(result.bundle.proposals[0]?.evidence[1]).toMatchObject({
      artifactId: 'cell-1',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'source-artifact-1',
      pageArtifactId: 'page-artifact-1',
      rawSpan: 'Labor rate',
    });
  });

  it('keeps input hashing and run identity deterministic', async () => {
    const provider = async () => JSON.stringify({
      state: 'observed',
      classification: 'table',
      evidenceIds: ['segment-1'],
      confidence: 1,
    });
    const first = await runForgewingRegionClassification(input(), { config, provider });
    const second = await runForgewingRegionClassification(input(), { config, provider });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    if (first.status === 'applied' && second.status === 'applied') {
      expect(first.bundle.run).toEqual(second.bundle.run);
      expect(first.bundle.proposals[0]?.proposalId).toBe(second.bundle.proposals[0]?.proposalId);
    }
  });

  it('prioritizes an ambiguous-chain segment deterministically', async () => {
    const provider = vi.fn(async (request: { inputJson: string }) => {
      const bounded = JSON.parse(request.inputJson) as { target: { observationId: string } };
      return JSON.stringify({
        state: 'observed',
        classification: 'continuation',
        evidenceIds: [bounded.target.observationId],
        confidence: 0.6,
      });
    });
    const base = input();
    const result = await runForgewingRegionClassification(input({
      segments: [
        ...base.segments,
        { ...base.segments[0]!, observationId: 'segment-ambiguous', chainCompleteness: 'ambiguous' },
      ],
    }), { config, provider });
    expect(result.status).toBe('applied');
    expect(provider).toHaveBeenCalledOnce();
    expect(JSON.parse(provider.mock.calls[0]![0].inputJson).target.observationId)
      .toBe('segment-ambiguous');
  });

  it('records deterministic truncation and stays within the text bound', async () => {
    const provider = vi.fn(async (request: { inputJson: string }) => {
      expect(request.inputJson.length).toBeLessThan(10_000);
      return JSON.stringify({
        state: 'insufficient_evidence',
        evidenceIds: [],
        missingEvidence: ['truncated_input'],
        confidence: null,
      });
    });
    const base = input();
    const result = await runForgewingRegionClassification(input({
      segments: [{ ...base.segments[0]!, text: 'x'.repeat(20_000) }],
    }), { config, provider });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.metadata.inputTruncated).toBe(true);
      expect(result.warnings).toContain('input_truncated');
      expect(result.bundle.proposals[0]?.state).toBe('insufficient_evidence');
    }
  });

  it('applies a cited long target after exact per-evidence truncation', async () => {
    const base = input();
    const result = await runForgewingRegionClassification(input({
      segments: [{ ...base.segments[0]!, text: 'x'.repeat(6_000) }],
    }), {
      config,
      provider: async () => JSON.stringify({
        state: 'observed',
        classification: 'table',
        evidenceIds: ['segment-1'],
        confidence: 0.7,
      }),
    });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.metadata.inputTruncated).toBe(true);
      expect(result.bundle.proposals[0]?.evidence[0]?.rawSpan).toHaveLength(4_000);
    }
  });

  it('keeps proven physical provenance coherent and permits evidence insufficiency', async () => {
    const base = input();
    const physicalCoordinate = {
      physicalPageNumber: 9,
      artifactLocalIndex: 8,
      sourceLayer: 'table_artifact' as const,
    };
    const physicalInput = input({
      segments: [{ ...base.segments[0]!, physicalCoordinate }],
      cells: [{ ...base.cells[0]!, physicalCoordinate }],
    });
    const observed = await runForgewingRegionClassification(physicalInput, {
      config,
      provider: async () => JSON.stringify({
        state: 'observed',
        classification: 'table',
        evidenceIds: ['segment-1'],
        confidence: 1,
      }),
    });
    expect(observed.status).toBe('applied');
    if (observed.status === 'applied') {
      expect(observed.bundle.proposals[0]).toMatchObject({
        physicalPageNumber: 9,
        artifactLocalIndex: 8,
        evidence: [{ physicalPageNumber: 9, artifactLocalIndex: 8, sourceLayer: 'table_artifact' }],
      });
    }
    const insufficient = await runForgewingRegionClassification(physicalInput, {
      config,
      provider: async () => JSON.stringify({
        state: 'insufficient_evidence',
        evidenceIds: [],
        missingEvidence: ['missing_source_observation'],
        confidence: null,
      }),
    });
    expect(insufficient.status).toBe('applied');
    if (insufficient.status === 'applied') {
      expect(insufficient.bundle.proposals[0]).not.toHaveProperty('physicalPageNumber');
    }
  });

  it('rejects duplicate observation identity before calling the provider', async () => {
    const provider = vi.fn();
    const base = input();
    const result = await runForgewingRegionClassification(input({
      cells: [{ ...base.cells[0]!, observationId: 'segment-1' }],
    }), { config, provider });
    expect(result).toMatchObject({ status: 'failed', reason: 'input_contract_violation' });
    expect(provider).not.toHaveBeenCalled();
  });

  it.each([
    ['not-json', 'invalid_model_json'],
    [JSON.stringify({ state: 'observed', classification: 'table', evidenceIds: [], confidence: 1 }), 'model_schema_rejected'],
    [JSON.stringify({ state: 'observed', classification: 'table', evidenceIds: ['fabricated'], confidence: 1 }), 'unknown_evidence_reference'],
    [JSON.stringify({ state: 'wrong_task', evidenceIds: ['segment-1'], confidence: 1 }), 'model_schema_rejected'],
    [JSON.stringify({ state: 'unresolved', evidenceIds: ['segment-1'], confidence: 2 }), 'model_schema_rejected'],
    [JSON.stringify({ state: 'unresolved', evidenceIds: ['segment-1'], confidence: null, rationale: 'x'.repeat(401) }), 'model_schema_rejected'],
    [JSON.stringify({ state: 'unresolved', evidenceIds: ['segment-1'], confidence: null, taskType: 'region_classification' }), 'model_schema_rejected'],
  ])('abstains on untrusted output %s', async (raw, warning) => {
    const result = await runForgewingRegionClassification(input(), {
      config,
      provider: async () => raw,
    });
    expect(result.status).toBe('abstained');
    if (result.status === 'abstained') {
      expect(result.warnings).toContain(warning);
      expect(result.bundle.proposals).toEqual([]);
      expect(result.bundle.abstentions[0]?.reason).toBe('runtime_unavailable');
    }
  });

  it('abstains without a provider call when the budget is exhausted', async () => {
    const provider = vi.fn();
    const result = await runForgewingRegionClassification(input(), {
      config,
      provider,
      budget: new ForgewingCallBudget(0),
    });
    expect(result.status).toBe('abstained');
    expect(provider).not.toHaveBeenCalled();
    if (result.status === 'abstained') {
      expect(result.warnings).toContain('budget_exhausted');
      expect(result.bundle.abstentions[0]?.reason).toBe('budget_unavailable');
    }
  });

  it.each([
    ['organizationId', 'organization-2'],
    ['sourceDocumentId', 'document-2'],
    ['sourceArtifactId', 'source-artifact-2'],
    ['extractionSnapshotId', 'snapshot-2'],
  ] as const)('does not call the provider for mixed %s identity', async (field, value) => {
    const provider = vi.fn();
    const base = input();
    const result = await runForgewingRegionClassification(input({
      segments: [{ ...base.segments[0]!, [field]: value }],
    }), { config, provider });
    expect(result).toMatchObject({ status: 'failed', reason: 'input_contract_violation' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('turns provider timeout into a runtime abstention', async () => {
    vi.useFakeTimers();
    const task = runForgewingRegionClassification(input(), {
      config: { ...config, timeoutMs: 10 },
      provider: () => new Promise(() => undefined),
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await task;
    expect(result.status).toBe('abstained');
    if (result.status === 'abstained') expect(result.warnings).toContain('provider_timeout');
    vi.useRealTimers();
  });
});
