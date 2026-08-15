import { describe, expect, it, vi } from 'vitest';

import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import type { ForgewingProvider, ForgewingProviderRequest } from '@/lib/forgewing/runtime/client';
import {
  runForgewingColumnMapping,
  type ForgewingColumnMappingInput,
} from '@/lib/forgewing/tasks/columnMapping';

const config = { enabled: true, model: 'test-model', timeoutMs: 25, maxCalls: 4, maxOutputTokens: 2_000 } as const;
const box = (x0 = .1, y0 = .1) => ({ coordinateSpace: 'page_normalized' as const, origin: 'top_left' as const, x0, y0, x1: Math.min(.99, x0 + .15), y1: Math.min(.99, y0 + .08), rotation: 0 as const });
const columns = (count = 4) => Array.from({ length: count }, (_, index) => ({
  index, x0: .05 + index * (.9 / count), x1: .05 + (index + 1) * (.9 / count),
  observedHeader: ['Category', 'Description', 'Unit', 'Rate', 'Value'][index] ?? `Column ${index}`,
  normalizedHeader: ['category', 'description', 'unit', 'rate', 'value'][index] ?? `column ${index}`,
  valueKinds: index === 3 ? ['currency'] : index === 2 ? ['unit_token'] : ['free_text'],
}));
function table(id = 'table-1', count = 4, page = 1) {
  return {
    observationId: id, kind: 'table' as const, organizationId: 'org-test',
    sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test',
    extractionSnapshotId: 'snapshot-test', pageArtifactId: `page-${page}`, page,
    boundingBox: { ...box(.05, .05), x1: .95, y1: .9 }, readingOrder: 0,
    physicalCoordinate: { mappingState: 'resolved_physical_page' as const,
      sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test',
      physicalPageNumber: page, artifactLocalIndex: page - 1, sourceLayer: 'table_artifact' as const },
    chainCompleteness: 'complete' as const, detectionKinds: ['x_alignment'], columns: columns(count),
  };
}
function cell(columnIndex: number, rowStart = 1, text = `value-${columnIndex}-${rowStart}`, tableId = 'table-1') {
  return {
    observationId: `${tableId}-cell-${columnIndex}-${rowStart}`, kind: 'cell' as const,
    organizationId: 'org-test', sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test',
    extractionSnapshotId: 'snapshot-test', pageArtifactId: 'page-1',
    boundingBox: box(.05 + columnIndex * .2, .15 + rowStart * .05), readingOrder: rowStart * 10 + columnIndex,
    physicalCoordinate: { mappingState: 'resolved_physical_page' as const,
      sourceDocumentId: 'document-test', sourceArtifactId: 'artifact-test', physicalPageNumber: 1,
      artifactLocalIndex: rowStart * 10_000 + columnIndex, sourceLayer: 'ocr' as const },
    tableSegmentId: tableId, text, rowStart, rowSpan: 1, columnStart: columnIndex,
    columnSpan: 1, structure: 'ordinary',
  };
}
function signal(columnIndex: number, reason: 'conflicting_cell_values' | 'multiple_exact_header_roles' | 'no_candidate' | 'below_minimum_score' | 'below_minimum_margin' = 'below_minimum_margin', tableId = 'table-1') {
  const role = (['category', 'description', 'unit', 'rate'] as const)[columnIndex] ?? 'identifier';
  return {
    mappingId: `${tableId}-mapping-${columnIndex}`, tableSegmentId: tableId, columnIndex,
    status: 'ambiguous' as const, ambiguityReason: reason,
    candidateRoles: [{ role, score: .6 }],
    observedTopScore: .6, observedMargin: .05, minimumScore: .7, minimumMargin: .2,
  };
}
function input(count = 4, overrides: Partial<ForgewingColumnMappingInput> = {}): ForgewingColumnMappingInput {
  return {
    organizationId: 'org-test', sourceDocumentId: 'document-test', extractionSnapshotId: 'snapshot-test',
    tables: [table('table-1', count)],
    cells: Array.from({ length: count }, (_, columnIndex) => cell(columnIndex)),
    mappingSignals: Array.from({ length: count }, (_, columnIndex) => signal(columnIndex)),
    ...overrides,
  };
}
type Bounded = { table: { observationId: string; columns: Array<{ columnId: string; index: number }> }; sampledCells: Array<{ observationId: string; columnStart: number; text: string }>; candidateColumnIndices: number[] };
function resolvedOutput(request: ForgewingProviderRequest, indices = [0, 1, 2, 3]) {
  const bounded = JSON.parse(request.inputJson) as Bounded;
  const roles = ['category', 'description', 'unit', 'rate'] as const;
  return JSON.stringify({ columnMappings: indices.map((columnIndex) => ({
    columnId: bounded.table.columns.find((column) => column.index === columnIndex)!.columnId,
    columnIndex, state: 'inferred', proposedRole: roles[columnIndex] ?? 'identifier', confidence: .75,
    rationaleCodes: ['header_semantics'],
    evidenceIds: [bounded.sampledCells.find((item) => item.columnStart === columnIndex)!.observationId],
  })) });
}

describe('runForgewingColumnMapping', () => {
  it('maps the repository roles for a bounded four-column table without changing authority', async () => {
    const provider = vi.fn<ForgewingProvider>(async (request) => resolvedOutput(request));
    const result = await runForgewingColumnMapping(input(), { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(provider).toHaveBeenCalledOnce();
    expect(result.metadata.maxOutputTokens).toBe(800);
    expect(result.bundle.authority).toBe('non_authoritative');
    expect(result.bundle.proposals[0]?.columnMappings.map((mapping) => 'proposedRole' in mapping ? mapping.proposedRole : null))
      .toEqual(['category', 'description', 'unit', 'rate']);
    expect(result.bundle.proposals[0]?.evidence.every((item) =>
      item.sourceDocumentId === 'document-test' && item.sourceArtifactId === 'artifact-test')).toBe(true);
  });

  it('accepts partial mappings and leaves omitted columns unresolved', async () => {
    const result = await runForgewingColumnMapping(input(5), {
      config, taskEnabled: true, provider: async (request) => resolvedOutput(request, [0, 2]),
    });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]).toMatchObject({
      mappingCompleteness: 'partial', columnMappings: [{ columnIndex: 0 }, { columnIndex: 2 }],
    });
  });

  it('preserves duplicate plausible roles on distinct columns as explicit ambiguity', async () => {
    const provider: ForgewingProvider = async (request) => {
      const bounded = JSON.parse(request.inputJson) as Bounded;
      return JSON.stringify({ columnMappings: [0, 1].map((columnIndex) => ({
        columnId: bounded.table.columns.find((column) => column.index === columnIndex)!.columnId,
        columnIndex, state: 'ambiguous', candidateRoles: ['rate', 'extension'], confidence: .45,
        rationaleCodes: ['mixed_evidence'], evidenceIds: [
          bounded.table.observationId,
          bounded.sampledCells.find((item) => item.columnStart === columnIndex)!.observationId,
        ],
      })) });
    };
    const result = await runForgewingColumnMapping(input(2), { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]).toMatchObject({ state: 'ambiguous' });
    expect(result.status === 'applied' && result.bundle.proposals[0]?.columnMappings).toHaveLength(2);
  });

  it('preserves insufficient evidence without inventing an unknown role', async () => {
    const provider: ForgewingProvider = async (request) => {
      const bounded = JSON.parse(request.inputJson) as Bounded;
      const column = bounded.table.columns[0]!;
      return JSON.stringify({ columnMappings: [{ columnId: column.columnId, columnIndex: column.index,
        state: 'insufficient_evidence', confidence: null, rationaleCodes: ['insufficient_structure'],
        evidenceIds: [], missingEvidence: ['missing_column_context'] }] });
    };
    const result = await runForgewingColumnMapping(input(1), { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]).toMatchObject({
      state: 'insufficient_evidence', evidence: [], mappingCompleteness: 'partial',
    });
  });

  it('does not force currency, numeric, long-text, or repeated-label signals into a mapping', async () => {
    const provider: ForgewingProvider = async (request) => {
      const bounded = JSON.parse(request.inputJson) as Bounded;
      return JSON.stringify({ columnMappings: [{
        columnId: bounded.table.columns[0]!.columnId, columnIndex: 0, state: 'ambiguous',
        candidateRoles: ['rate', 'quantity'], confidence: .4, rationaleCodes: ['mixed_evidence'],
        evidenceIds: [bounded.table.observationId, bounded.sampledCells[0]!.observationId],
      }] });
    };
    const value = input(1, { tables: [{ ...table('table-1', 1), columns: [{ ...columns(1)[0]!, observedHeader: 'Value', normalizedHeader: 'value', valueKinds: ['currency', 'integer', 'free_text'] }] }] });
    const result = await runForgewingColumnMapping(value, { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]?.state).toBe('ambiguous');
  });

  it('fails closed on unknown evidence, foreign identity, and unknown column identity', async () => {
    const unknownEvidence = await runForgewingColumnMapping(input(1), {
      config, taskEnabled: true, provider: async (request) => {
        const bounded = JSON.parse(request.inputJson) as Bounded;
        return JSON.stringify({ columnMappings: [{ columnId: bounded.table.columns[0]!.columnId,
          columnIndex: 0, state: 'inferred', proposedRole: 'rate', confidence: .7,
          rationaleCodes: ['currency_pattern'], evidenceIds: ['foreign-evidence'] }] });
      },
    });
    const foreign = await runForgewingColumnMapping(input(1, {
      cells: [{ ...cell(0), sourceArtifactId: 'foreign-artifact' }],
    }), { config, taskEnabled: true, provider: async () => { throw new Error('must not run'); } });
    const unknownColumn = await runForgewingColumnMapping(input(1), {
      config, taskEnabled: true, provider: async (request) => {
        const bounded = JSON.parse(request.inputJson) as Bounded;
        return JSON.stringify({ columnMappings: [{ columnId: bounded.table.columns[0]!.columnId,
          columnIndex: 99, state: 'inferred', proposedRole: 'rate', confidence: .7,
          rationaleCodes: ['currency_pattern'], evidenceIds: [bounded.table.observationId] }] });
      },
    });
    const tableOnlyEvidence = await runForgewingColumnMapping(input(1), {
      config, taskEnabled: true, provider: async (request) => {
        const bounded = JSON.parse(request.inputJson) as Bounded;
        return JSON.stringify({ columnMappings: [{ columnId: bounded.table.columns[0]!.columnId,
          columnIndex: 0, state: 'inferred', proposedRole: 'rate', confidence: .7,
          rationaleCodes: ['header_semantics'], evidenceIds: [bounded.table.observationId] }] });
      },
    });
    const wrongColumnEvidence = await runForgewingColumnMapping(input(2), {
      config, taskEnabled: true, provider: async (request) => {
        const bounded = JSON.parse(request.inputJson) as Bounded;
        return JSON.stringify({ columnMappings: [{ columnId: bounded.table.columns[0]!.columnId,
          columnIndex: 0, state: 'inferred', proposedRole: 'rate', confidence: .7,
          rationaleCodes: ['currency_pattern'], evidenceIds: [bounded.sampledCells.find(
            (item) => item.columnStart === 1)!.observationId] }] });
      },
    });
    expect(unknownEvidence.status === 'abstained' && unknownEvidence.warnings).toContain('unknown_evidence_reference');
    expect(foreign.status).toBe('failed');
    expect(unknownColumn.status === 'abstained' && unknownColumn.warnings).toContain('model_schema_rejected');
    expect(tableOnlyEvidence.status === 'abstained' && tableOnlyEvidence.warnings).toContain('model_schema_rejected');
    expect(wrongColumnEvidence.status === 'abstained' && wrongColumnEvidence.warnings).toContain('model_schema_rejected');
  });

  it('hard-gates disabled and no-candidate inputs before provider invocation', async () => {
    const provider = vi.fn(async () => { throw new Error('must not run'); });
    await expect(runForgewingColumnMapping({}, { config, taskEnabled: false, provider }))
      .resolves.toEqual({ status: 'skipped', reason: 'column_mapping_disabled' });
    await expect(runForgewingColumnMapping(input(1, { mappingSignals: [] }), { config, taskEnabled: true, provider }))
      .resolves.toEqual({ status: 'skipped', reason: 'no_candidate_tables' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('contains malformed JSON, timeout, and unavailable budget without retries', async () => {
    const malformed = await runForgewingColumnMapping(input(1), {
      config, taskEnabled: true, provider: async () => 'not-json',
    });
    const hanging = vi.fn(() => new Promise<string>(() => undefined));
    const timeout = await runForgewingColumnMapping(input(1), {
      config: { ...config, timeoutMs: 5 }, taskEnabled: true, provider: hanging,
    });
    const budget = await runForgewingColumnMapping(input(1), {
      config, taskEnabled: true, provider: hanging, budget: new ForgewingCallBudget(0),
    });
    expect(malformed.status === 'abstained' && malformed.warnings).toContain('invalid_model_json');
    expect(timeout.status === 'abstained' && timeout.warnings).toContain('provider_timeout');
    expect(budget.status === 'abstained' && budget.warnings).toContain('budget_exhausted');
    expect(hanging).toHaveBeenCalledOnce();
  });

  it('bounds columns, rows, cells, text, and provider calls deterministically', async () => {
    const manyCells = Array.from({ length: 20 }, (_, row) =>
      Array.from({ length: 14 }, (_, column) => ({
        ...cell(column, row + 1, 'x'.repeat(3_000)),
        boundingBox: box(.02 + column * .065, .05 + (row % 8) * .1),
      }))).flat();
    const signals = Array.from({ length: 14 }, (_, index) => signal(index));
    let bounded: (Bounded & { sampledRowIndices: number[]; truncated: boolean }) | undefined;
    const provider = vi.fn<ForgewingProvider>(async (request) => {
      bounded = JSON.parse(request.inputJson);
      return resolvedOutput(request, [0]);
    });
    const result = await runForgewingColumnMapping(input(14, {
      tables: [table('table-1', 14)], cells: manyCells, mappingSignals: signals,
    }), { config, taskEnabled: true, provider });
    expect(result.status).toBe('applied');
    expect(provider).toHaveBeenCalledOnce();
    expect(bounded?.table.columns).toHaveLength(12);
    expect(bounded?.sampledRowIndices.length).toBeLessThanOrEqual(8);
    expect(bounded?.sampledCells.length).toBeLessThanOrEqual(96);
    expect(bounded?.sampledCells.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(8_000);
    expect(result.status === 'applied' && result.warnings).toContain('input_truncated');
  });

  it('keeps bounded payload, hash, task identity, and candidate stable across unrelated ordering', async () => {
    const payloads: string[] = [];
    const provider: ForgewingProvider = async (request) => { payloads.push(request.inputJson); return resolvedOutput(request, [0]); };
    const unrelated = table('table-unrelated', 1, 2);
    const first = await runForgewingColumnMapping(input(1, { tables: [unrelated, table()], cells: [cell(0)] }), { config, taskEnabled: true, provider });
    const second = await runForgewingColumnMapping(input(1, { tables: [table(), unrelated], cells: [cell(0)] }), { config, taskEnabled: true, provider });
    expect(first.status).toBe('applied');
    expect(second.status).toBe('applied');
    if (first.status === 'applied' && second.status === 'applied') {
      expect(first.bundle.run.inputSnapshotHash).toBe(second.bundle.run.inputSnapshotHash);
      expect(first.bundle.taskId).toBe(second.bundle.taskId);
      expect(payloads[0]).toBe(payloads[1]);
    }
  });
});
