import { describe, expect, it, vi } from 'vitest';

import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import type { ForgewingProvider } from '@/lib/forgewing/runtime/client';
import {
  runForgewingTableContinuation,
  type ForgewingTableContinuationCell,
  type ForgewingTableContinuationInput,
  type ForgewingTableContinuationSegment,
} from '@/lib/forgewing/tasks/tableContinuation';

const config = { enabled: true, model: 'test-model', timeoutMs: 25, maxCalls: 4, maxOutputTokens: 800 } as const;
const box = (y0 = .1) => ({ coordinateSpace: 'page_normalized' as const, origin: 'top_left' as const, x0: .1, y0, x1: .9, y1: Math.min(.99, y0 + .1), rotation: 0 as const });

function segment(id: string, page: number, overrides: Partial<ForgewingTableContinuationSegment> = {}): ForgewingTableContinuationSegment {
  return {
    observationId: id,
    kind: 'segment',
    organizationId: 'org-test',
    sourceDocumentId: 'document-test',
    sourceArtifactId: 'artifact-test',
    extractionSnapshotId: 'snapshot-test',
    pageArtifactId: `page-${page}`,
    boundingBox: box(),
    text: `segment ${id}`,
    readingOrder: 0,
    physicalCoordinate: { mappingState: 'resolved_physical_page', sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test', physicalPageNumber: page, artifactLocalIndex: page - 1, sourceLayer: 'table_artifact' },
    chainCompleteness: 'ambiguous',
    columns: [{ index: 0, x0: .1, x1: .5, observedHeader: 'Item', normalizedHeader: 'item', valueKinds: ['free_text'] }, { index: 1, x0: .5, x1: .9, observedHeader: 'Amount', normalizedHeader: 'amount', valueKinds: ['currency'] }],
    repeatedHeaderCount: 1,
    detectionKinds: ['repeated_headers'],
    ...overrides,
  };
}

function input(overrides: Partial<ForgewingTableContinuationInput> = {}): ForgewingTableContinuationInput {
  return {
    organizationId: 'org-test',
    sourceDocumentId: 'document-test',
    extractionSnapshotId: 'snapshot-test',
    segments: [segment('prior', 1), segment('next', 2)],
    cells: [],
    continuationLinks: [{ linkId: 'link-test', fromSegmentId: 'prior', toSegmentId: 'next', decision: 'ambiguous' }],
    ...overrides,
  };
}

function cell(id: string, targetSegmentId: string, page: number, text: string): ForgewingTableContinuationCell {
  return {
    observationId: id, kind: 'cell', organizationId: 'org-test',
    sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test',
    extractionSnapshotId: 'snapshot-test', pageArtifactId: `page-${page}`,
    boundingBox: box(.2), text, readingOrder: 1,
    physicalCoordinate: { mappingState: 'resolved_physical_page', sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test', physicalPageNumber: page, artifactLocalIndex: page * 10_000 + 1, sourceLayer: page === 1 ? 'ocr' : 'pdf_native_text' },
    targetSegmentId, rowStart: 1, rowSpan: 1, columnStart: 0, columnSpan: 1,
    structure: 'ordinary',
  };
}

const output = (relation: 'same_table' | 'separate_tables' | 'ambiguous' = 'same_table') => JSON.stringify({
  state: relation === 'ambiguous' ? 'ambiguous' : 'inferred',
  relation,
  evidenceIds: ['prior', 'next'],
  confidence: .7,
  rationaleCode: relation === 'same_table' ? 'column_structure_consistent' : 'mixed_evidence',
});

describe('runForgewingTableContinuation', () => {
  it('builds an adjacent cross-page proposal with reconstructed source evidence', async () => {
    const provider = vi.fn<ForgewingProvider>(async () => output());
    const result = await runForgewingTableContinuation(input(), { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(provider).toHaveBeenCalledTimes(1);
    expect(result.bundle.taskType).toBe('table_continuation');
    expect(result.bundle.proposals[0]).toMatchObject({ priorSegmentId: 'prior', nextSegmentId: 'next', priorPhysicalPageNumber: 1, nextPhysicalPageNumber: 2, relation: 'same_table' });
    expect(result.bundle.proposals[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test', physicalPageNumber: 1 }),
      expect.objectContaining({ sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test', physicalPageNumber: 2 }),
    ]));
  });

  it('accepts cited cells with their own proven local index and source layer', async () => {
    const value = input({ cells: [cell('prior-cell', 'prior', 1, 'prior row'), cell('next-cell', 'next', 2, 'next row')] });
    const provider: ForgewingProvider = async () => JSON.stringify({ state: 'inferred', relation: 'same_table', evidenceIds: ['prior-cell', 'next-cell'], confidence: .7, rationaleCode: 'row_sequence_continues' });
    const result = await runForgewingTableContinuation(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId: 'prior-cell', artifactLocalIndex: 10_001, sourceLayer: 'ocr' }),
      expect.objectContaining({ artifactId: 'next-cell', artifactLocalIndex: 20_001, sourceLayer: 'pdf_native_text' }),
    ]));
  });

  it('does no candidate mapping or provider work while task-specific flag is off', async () => {
    const provider = vi.fn(async () => { throw new Error('must not run'); });
    const result = await runForgewingTableContinuation({} as ForgewingTableContinuationInput, { config, taskEnabled: false, provider });
    expect(result).toEqual({ status: 'skipped', reason: 'table_continuation_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('skips unresolved, non-adjacent, linked, and rejected pairs without guessing', async () => {
    const provider = vi.fn(async () => output());
    const unresolved = segment('prior', 1, { physicalCoordinate: undefined });
    const cases = [
      input({ segments: [unresolved, segment('next', 2)] }),
      input({ segments: [segment('prior', 1), segment('next', 3)] }),
      input({ continuationLinks: [{ linkId: 'link-test', fromSegmentId: 'prior', toSegmentId: 'next', decision: 'linked' }] }),
      input({ continuationLinks: [{ linkId: 'link-test', fromSegmentId: 'prior', toSegmentId: 'next', decision: 'rejected' }] }),
    ];
    for (const value of cases) {
      await expect(runForgewingTableContinuation(value, { config, taskEnabled: true, provider })).resolves.toEqual({ status: 'skipped', reason: 'no_candidate_pairs' });
    }
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails closed on foreign identity before provider invocation', async () => {
    const provider = vi.fn(async () => output());
    const result = await runForgewingTableContinuation(input({ segments: [segment('prior', 1, { sourceArtifactId: 'foreign-artifact' }), segment('next', 2)] }), { config, taskEnabled: true, provider });
    expect(result.status).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  });

  it('contains unknown evidence IDs and malformed model JSON as abstentions', async () => {
    const unknown = await runForgewingTableContinuation(input(), { config, taskEnabled: true, provider: async () => JSON.stringify({ ...JSON.parse(output()), evidenceIds: ['prior', 'unknown'] }) });
    const malformed = await runForgewingTableContinuation(input(), { config, taskEnabled: true, provider: async () => 'not-json' });
    expect(unknown.status).toBe('abstained');
    expect(unknown.status === 'abstained' && unknown.warnings).toContain('unknown_evidence_reference');
    expect(malformed.status).toBe('abstained');
    expect(malformed.status === 'abstained' && malformed.warnings).toContain('invalid_model_json');
  });

  it('contains provider timeout and budget exhaustion with no retries', async () => {
    const provider = vi.fn(() => new Promise<string>(() => undefined));
    const timedOut = await runForgewingTableContinuation(input(), { config: { ...config, timeoutMs: 5 }, taskEnabled: true, provider });
    const budget = await runForgewingTableContinuation(input(), { config, taskEnabled: true, provider, budget: new ForgewingCallBudget(0) });
    expect(timedOut.status).toBe('abstained');
    expect(timedOut.status === 'abstained' && timedOut.warnings).toContain('provider_timeout');
    expect(budget.status).toBe('abstained');
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('caps the task output budget at 800 tokens even when the shared config is higher', async () => {
    const provider = vi.fn<ForgewingProvider>(async () => output());
    const result = await runForgewingTableContinuation(input(), { config: { ...config, maxOutputTokens: 2_000 }, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(provider.mock.calls[0]?.[0].maxOutputTokens).toBe(800);
    expect(result.status === 'applied' && result.metadata.maxOutputTokens).toBe(800);
  });

  it('reports deterministic truncation and never exceeds one provider call', async () => {
    const provider = vi.fn<ForgewingProvider>(async () => output());
    const extraSegments = [segment('later-prior', 3), segment('later-next', 4)];
    const value = input({
      segments: [segment('prior', 1, { text: 'x'.repeat(5_000) }), segment('next', 2), ...extraSegments],
      continuationLinks: [
        { linkId: 'link-a', fromSegmentId: 'prior', toSegmentId: 'next', decision: 'ambiguous' },
        { linkId: 'link-b', fromSegmentId: 'later-prior', toSegmentId: 'later-next', decision: 'ambiguous' },
      ],
    });
    const result = await runForgewingTableContinuation(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.warnings).toContain('input_truncated');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(JSON.parse(provider.mock.calls[0]![0].inputJson).priorSegment.observationId).toBe('prior');
  });

  it('enforces the 4,000-character cap independently for both segment sides', async () => {
    let sent: { priorSegment: { text: string }; nextSegment: { text: string }; priorBoundaryCells: Array<{ text: string }>; nextBoundaryCells: Array<{ text: string }> } | undefined;
    const provider: ForgewingProvider = async (request) => { sent = JSON.parse(request.inputJson); return output(); };
    const value = input({
      segments: [segment('prior', 1, { text: 'prior' }), segment('next', 2, { text: 'next' })],
      cells: [cell('prior-cell', 'prior', 1, 'p'.repeat(5_000)), cell('next-cell', 'next', 2, 'n'.repeat(5_000))],
    });
    const result = await runForgewingTableContinuation(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(sent).toBeDefined();
    const bounded = sent!;
    expect(bounded.priorSegment.text.length + bounded.priorBoundaryCells.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(4_000);
    expect(bounded.nextSegment.text.length + bounded.nextBoundaryCells.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(4_000);
    expect(bounded.priorBoundaryCells).toHaveLength(1);
    expect(bounded.nextBoundaryCells).toHaveLength(1);
  });

  it('retains an explicit ambiguous competitor when an endpoint has another linked edge', async () => {
    let sent: { priorSegment: { observationId: string }; nextSegment: { observationId: string } } | undefined;
    const provider: ForgewingProvider = async (request) => {
      sent = JSON.parse(request.inputJson);
      return JSON.stringify({ state: 'ambiguous', relation: 'ambiguous', evidenceIds: ['prior', 'competitor'], confidence: .5, rationaleCode: 'mixed_evidence' });
    };
    const value = input({
      segments: [segment('prior', 1), segment('winner', 2), segment('competitor', 2, { readingOrder: 1 })],
      continuationLinks: [
        { linkId: 'linked-winner', fromSegmentId: 'prior', toSegmentId: 'winner', decision: 'linked' },
        { linkId: 'ambiguous-competitor', fromSegmentId: 'prior', toSegmentId: 'competitor', decision: 'ambiguous' },
      ],
    });
    const result = await runForgewingTableContinuation(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(sent).toMatchObject({ priorSegment: { observationId: 'prior' }, nextSegment: { observationId: 'competitor' } });
  });

  it('does not deterministically force equivalence or separation from weak single signals', async () => {
    const provider = vi.fn(async () => output('ambiguous'));
    const value = input({ segments: [segment('prior', 1, { repeatedHeaderCount: 0 }), segment('next', 2, { repeatedHeaderCount: 0, physicalCoordinate: { ...segment('next', 2).physicalCoordinate!, sourceLayer: 'ocr' }, boundingBox: box(.12) })] });
    const result = await runForgewingTableContinuation(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]).toMatchObject({ state: 'ambiguous', relation: 'ambiguous' });
  });

  it('keeps pair hash and identity stable across unrelated input ordering', async () => {
    const hashes: string[] = [];
    const provider = vi.fn(async (request: { inputJson: string }) => { hashes.push(request.inputJson); return output(); });
    const unrelated = segment('unrelated', 8, { chainCompleteness: 'complete' });
    const first = await runForgewingTableContinuation(input({ segments: [unrelated, segment('next', 2), segment('prior', 1)] }), { config, taskEnabled: true, provider });
    const second = await runForgewingTableContinuation(input({ segments: [segment('prior', 1), unrelated, segment('next', 2)] }), { config, taskEnabled: true, provider });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    if (first.status === 'applied' && second.status === 'applied') {
      expect(first.bundle.run.inputSnapshotHash).toBe(second.bundle.run.inputSnapshotHash);
      expect(first.bundle.taskId).toBe(second.bundle.taskId);
      expect(hashes[0]).toBe(hashes[1]);
    }
  });
});
