import { describe, expect, it, vi } from 'vitest';

import { runForgewingPricingInterpretation, type ForgewingPricingInterpretationInput } from './pricingInterpretation';
import type { ForgewingProviderRequest } from '../runtime/client';

const config = { enabled: true, model: 'claude-test', timeoutMs: 100, maxCalls: 1, maxOutputTokens: 2_000 };
const input = (overrides: Partial<ForgewingPricingInterpretationInput> = {}): ForgewingPricingInterpretationInput => ({
  organizationId: 'org-1', sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1',
  extractionSnapshotId: 'snapshot-1',
  pricingScope: { scopeKind: 'authoritative', eligibility: 'canonical_eligible',
    eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'c'.repeat(64) },
  rowObservation: { observationId: 'row-1', rawText: 'Debris removal | CY | $12.50',
    deterministicState: 'unresolved', physicalPageNumber: 2,
    cells: [
      { observationId: 'cell-description', rawText: 'Debris removal', columnIndex: 0, readingOrder: 0 },
      { observationId: 'cell-unit', rawText: 'CY', columnIndex: 1, readingOrder: 1,
        semanticHints: ['unit_like_text'] },
      { observationId: 'cell-rate', rawText: '$12.50', columnIndex: 2, readingOrder: 2 },
    ] },
  ...overrides,
});
const output = (change: Record<string, unknown> = {}) => JSON.stringify({
  rowInterpretationState: 'observed', confidence: 0.9,
  interpretations: [{ sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount',
    sourceText: '$12.50', interpretationState: 'observed', confidence: 0.9,
    evidenceIds: ['cell-rate'], rationaleCodes: ['explicit_currency_marker'] }],
  ...change,
});

describe('runForgewingPricingInterpretation', () => {
  it('sends exact multi-primitive rate-cell context to the actual provider input', async () => {
    const grouped = input({ rowObservation: {
      ...input().rowObservation,
      rawText: '$\n1.00',
      cells: [
        { observationId: 'currency', rawText: '$', columnIndex: 3, readingOrder: 0 },
        { observationId: 'amount', rawText: '1.00', columnIndex: 3, readingOrder: 1 },
      ],
      sourceCellGroups: [{ sourceCellRole: 'rate',
        sourceObservationIds: ['currency', 'amount'], authoredRawText: '$ 1.00' }],
    } });
    let providerInput: Record<string, unknown> | null = null;
    const result = await runForgewingPricingInterpretation(grouped, { config, taskEnabled: true,
      provider: async (request) => {
        providerInput = JSON.parse(request.inputJson) as Record<string, unknown>;
        return output({ interpretations: [
          { sourceCellId: 'currency', semanticRole: 'rate_like_amount', sourceText: '$',
            interpretationState: 'observed', confidence: 0.9,
            evidenceIds: ['currency', 'amount'], rationaleCodes: ['explicit_currency_marker'] },
          { sourceCellId: 'amount', semanticRole: 'rate_like_amount', sourceText: '1.00',
            interpretationState: 'inferred', confidence: 0.8,
            evidenceIds: ['currency', 'amount'], rationaleCodes: ['numeric_structure'] },
        ] });
      } });
    expect(result.status, JSON.stringify(result)).toBe('applied');
    expect(providerInput).toMatchObject({ rowObservation: {
      cells: [
        { observationId: 'currency', rawText: '$' },
        { observationId: 'amount', rawText: '1.00' },
      ],
      sourceCellGroups: [{ sourceCellRole: 'rate',
        sourceObservationIds: ['currency', 'amount'], authoredRawText: '$ 1.00' }],
    } });
  });

  it.each(['1.00', '1,250.00', '25.00'])(
    'accepts numeric primitive %s as rate only with a cited currency sibling in the exact rate group',
    async (amount) => {
      const currency = amount === '25.00' ? 'USD' : '$';
      const grouped = input({ rowObservation: { ...input().rowObservation,
        cells: [
          { observationId: 'currency', rawText: currency, columnIndex: 2, readingOrder: 0 },
          { observationId: 'amount', rawText: amount, columnIndex: 2, readingOrder: 1 },
        ], sourceCellGroups: [{ sourceCellRole: 'rate',
          sourceObservationIds: ['currency', 'amount'], authoredRawText: `${currency} ${amount}` }] } });
      const result = await runForgewingPricingInterpretation(grouped, { config, taskEnabled: true,
        provider: async () => output({ interpretations: [{ sourceCellId: 'amount',
          semanticRole: 'rate_like_amount', sourceText: amount, interpretationState: 'inferred',
          confidence: 0.7, evidenceIds: ['amount', 'currency'], rationaleCodes: ['numeric_structure'] }] }) });
      expect(result.status).toBe('applied');
      const uncitedSibling = await runForgewingPricingInterpretation(grouped,
        { config, taskEnabled: true, provider: async () => output({ interpretations: [{
          sourceCellId: 'amount', semanticRole: 'rate_like_amount', sourceText: amount,
          interpretationState: 'inferred', confidence: 0.7, evidenceIds: ['amount'],
          rationaleCodes: ['numeric_structure'],
        }] }) });
      expect(uncitedSibling.status === 'abstained' && uncitedSibling.warnings)
        .toContain('unsupported_source_text');
    },
  );

  it('keeps rate, quantity, and unknown numeric support separated by exact source structure', async () => {
    const grouped = (sourceCellRole: 'rate' | 'quantity' | 'unknown') => input({ rowObservation: {
      ...input().rowObservation,
      cells: [{ observationId: 'number', rawText: '1.00', columnIndex: 0, readingOrder: 0 }],
      sourceCellGroups: [{ sourceCellRole, sourceObservationIds: ['number'], authoredRawText: '1.00' }],
    } });
    const interpretation = (semanticRole: 'rate_like_amount' | 'quantity_like_amount') =>
      output({ interpretations: [{ sourceCellId: 'number', semanticRole, sourceText: '1.00',
        interpretationState: 'inferred', confidence: 0.5, evidenceIds: ['number'],
        rationaleCodes: ['numeric_structure'] }] });
    const quantity = await runForgewingPricingInterpretation(grouped('quantity'),
      { config, taskEnabled: true, provider: async () => interpretation('quantity_like_amount') });
    expect(quantity.status).toBe('applied');
    for (const [cellRole, semantic] of [
      ['quantity', 'rate_like_amount'],
      ['rate', 'quantity_like_amount'],
      ['unknown', 'rate_like_amount'],
    ] as const) {
      const result = await runForgewingPricingInterpretation(grouped(cellRole),
        { config, taskEnabled: true, provider: async () => interpretation(semantic) });
      expect(result.status === 'abstained' && result.warnings).toContain('unsupported_source_text');
    }
  });

  it('does not coerce a grouped authored rate marker into a number', async () => {
    const marker = input({ rowObservation: { ...input().rowObservation,
      cells: [
        { observationId: 'currency', rawText: '$', columnIndex: 2, readingOrder: 0 },
        { observationId: 'dash', rawText: '-', columnIndex: 2, readingOrder: 1 },
      ], sourceCellGroups: [{ sourceCellRole: 'rate',
        sourceObservationIds: ['currency', 'dash'], authoredRawText: '$ -' }] } });
    const result = await runForgewingPricingInterpretation(marker, { config, taskEnabled: true,
      provider: async () => output({ rowInterpretationState: 'ambiguous', confidence: 0.4,
        interpretations: [
          { sourceCellId: 'currency', semanticRole: 'rate_like_amount', sourceText: '$',
            interpretationState: 'ambiguous', confidence: 0.4, evidenceIds: ['currency', 'dash'],
            rationaleCodes: ['explicit_currency_marker'] },
          { sourceCellId: 'dash', semanticRole: 'unknown', sourceText: '-',
            interpretationState: 'ambiguous', confidence: 0.4, evidenceIds: ['currency', 'dash'],
            rationaleCodes: ['missing_semantic_context'] },
        ] }) });
    expect(result.status).toBe('applied');
    expect(result.status === 'applied' && result.bundle.proposals[0]?.interpretations[1]?.sourceText)
      .toBe('-');
  });

  it('is hard-gated before parsing or provider work', async () => {
    const provider = vi.fn(async () => { throw new Error('called'); });
    await expect(runForgewingPricingInterpretation({} as never,
      { config: { ...config, enabled: false }, taskEnabled: true, provider }))
      .resolves.toEqual({ status: 'skipped', reason: 'forgewing_disabled' });
    await expect(runForgewingPricingInterpretation({} as never,
      { config, taskEnabled: false, provider }))
      .resolves.toEqual({ status: 'skipped', reason: 'pricing_interpretation_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('runs once for one eligible unresolved row and reconstructs exact evidence', async () => {
    const provider = vi.fn(async (request: ForgewingProviderRequest) => {
      expect(request.maxOutputTokens).toBe(2_000);
      return output();
    });
    const result = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true, provider });
    expect(provider).toHaveBeenCalledOnce();
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.bundle.authority).toBe('non_authoritative');
      expect(result.bundle.proposals[0]?.interpretations[0]?.sourceText).toBe('$12.50');
      expect(result.bundle.proposals[0]?.evidence[0]).toMatchObject({
        artifactId: 'cell-rate', sourceDocumentId: 'doc-1', sourceArtifactId: 'artifact-1',
        rawSpan: '$12.50',
      });
    }
  });

  it('can describe source-backed description, unit, and rate tokens without producing a price row', async () => {
    const result = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => output({ interpretations: [
        { sourceCellId: 'cell-description', semanticRole: 'description_like_text',
          sourceText: 'Debris removal', interpretationState: 'observed', confidence: 0.8,
          evidenceIds: ['cell-description'], rationaleCodes: ['textual_description_pattern'] },
        { sourceCellId: 'cell-unit', semanticRole: 'unit_like_text', sourceText: 'CY',
          interpretationState: 'inferred', confidence: 0.8, evidenceIds: ['cell-unit'],
          rationaleCodes: ['explicit_unit_token'] },
        { sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount', sourceText: '$12.50',
          interpretationState: 'observed', confidence: 0.9, evidenceIds: ['cell-rate'],
          rationaleCodes: ['explicit_currency_marker'] },
      ] }) });
    expect(result.status).toBe('applied');
    if (result.status === 'applied') {
      expect(result.bundle.proposals[0]?.interpretations.map((entry) => entry.semanticRole))
        .toEqual(['description_like_text', 'unit_like_text', 'rate_like_amount']);
      expect(result.bundle.proposals[0]).not.toHaveProperty('rate');
      expect(result.bundle.proposals[0]).not.toHaveProperty('unit');
    }
  });

  it.each([
    ['no scope', { scopeKind: 'no_scope', eligibility: 'diagnostic_only', eligibilityReason: 'scope_absent',
      scopeIdentity: 'd'.repeat(64) }],
    ['out of scope', { scopeKind: 'authoritative', eligibility: 'diagnostic_only',
      eligibilityReason: 'authoritative_scope_miss', scopeIdentity: 'd'.repeat(64) }],
  ])('does not call the provider for %s', async (_label, pricingScope) => {
    const provider = vi.fn(async () => output());
    const result = await runForgewingPricingInterpretation(input({ pricingScope } as never),
      { config, taskEnabled: true, provider });
    expect(result).toEqual({ status: 'skipped', reason: 'ineligible_source_scope' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('skips resolved rows and blank evidence without a call', async () => {
    const provider = vi.fn(async () => output());
    const resolved = input({ rowObservation: { ...input().rowObservation, deterministicState: 'resolved' } });
    expect(await runForgewingPricingInterpretation(resolved, { config, taskEnabled: true, provider }))
      .toEqual({ status: 'skipped', reason: 'no_candidate_rows' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('fails closed on foreign identity, unknown evidence, and unsupported source text', async () => {
    const foreign = input({ rowObservation: { ...input().rowObservation,
      cells: [{ ...input().rowObservation.cells[0]!, sourceArtifactId: 'foreign' }] } });
    expect((await runForgewingPricingInterpretation(foreign,
      { config, taskEnabled: true, provider: async () => output() })).status).toBe('failed');
    const unknown = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => output({ interpretations: [{ sourceCellId: 'unknown', semanticRole: 'rate_like_amount',
        sourceText: '$12.50', interpretationState: 'observed', confidence: 1,
        evidenceIds: ['unknown'], rationaleCodes: ['explicit_currency_marker'] }] }) });
    expect(unknown.status === 'abstained' && unknown.warnings).toContain('unknown_evidence_reference');
    const invented = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => output({ interpretations: [{ sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount',
        sourceText: '$125.00', interpretationState: 'observed', confidence: 1,
        evidenceIds: ['cell-rate'], rationaleCodes: ['explicit_currency_marker'] }] }) });
    expect(invented.status === 'abstained' && invented.warnings).toContain('unsupported_source_text');
  });

  it('does not promote a bare number to rate without deterministic semantic context', async () => {
    const bare = input({ rowObservation: { ...input().rowObservation,
      cells: [{ observationId: 'cell-rate', rawText: '12.50', columnIndex: 0, readingOrder: 0 }] } });
    const result = await runForgewingPricingInterpretation(bare, { config, taskEnabled: true,
      provider: async () => output({ interpretations: [{ sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount',
        sourceText: '12.50', interpretationState: 'inferred', confidence: 0.5,
        evidenceIds: ['cell-rate'], rationaleCodes: ['numeric_structure'] }] }) });
    expect(result.status === 'abstained' && result.warnings).toContain('unsupported_source_text');
  });

  it('rejects manufactured unit, quantity, blank, neighboring, and known-value interpretations', async () => {
    const manufactured = [
      { sourceCellId: 'cell-description', semanticRole: 'unit_like_text', sourceText: 'Debris removal' },
      { sourceCellId: 'cell-unit', semanticRole: 'quantity_like_amount', sourceText: 'CY' },
      { sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount', sourceText: '$999.99' },
    ] as const;
    for (const candidate of manufactured) {
      const result = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
        provider: async () => output({ interpretations: [{ ...candidate,
          interpretationState: 'inferred', confidence: 0.5,
          evidenceIds: [candidate.sourceCellId], rationaleCodes: ['source_text_only'] }] }) });
      expect(result.status === 'abstained' && result.warnings).toContain('unsupported_source_text');
    }
    const blank = input({ rowObservation: { ...input().rowObservation,
      cells: [{ observationId: 'blank', rawText: '   ', columnIndex: 0, readingOrder: 0 }] } });
    const provider = vi.fn(async () => output());
    expect(await runForgewingPricingInterpretation(blank, { config, taskEnabled: true, provider }))
      .toEqual({ status: 'skipped', reason: 'no_candidate_rows' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('preserves ambiguous, conflicting, and insufficient-evidence states', async () => {
    const ambiguous = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => output({ rowInterpretationState: 'ambiguous', confidence: 0.4,
        interpretations: [
          { sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount', sourceText: '$12.50',
            interpretationState: 'ambiguous', confidence: 0.4, evidenceIds: ['cell-rate'],
            rationaleCodes: ['multiple_plausible_roles'] },
          { sourceCellId: 'cell-rate', semanticRole: 'unknown', sourceText: '$12.50',
            interpretationState: 'ambiguous', confidence: 0.4, evidenceIds: ['cell-rate'],
            rationaleCodes: ['missing_semantic_context'] },
        ] }) });
    expect(ambiguous.status === 'applied' && ambiguous.bundle.proposals[0]?.state).toBe('ambiguous');

    const conflictingInput = input({ rowObservation: { ...input().rowObservation,
      deterministicState: 'conflict', cells: [...input().rowObservation.cells,
        { observationId: 'cell-rate-2', rawText: '$125.00', columnIndex: 3, readingOrder: 3 }] } });
    const conflicting = await runForgewingPricingInterpretation(conflictingInput,
      { config, taskEnabled: true, provider: async () => output({
        rowInterpretationState: 'conflicting', confidence: 0.5, interpretations: [
          { sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount', sourceText: '$12.50',
            interpretationState: 'conflicting', confidence: 0.5, evidenceIds: ['cell-rate'],
            rationaleCodes: ['incompatible_values'] },
          { sourceCellId: 'cell-rate-2', semanticRole: 'rate_like_amount', sourceText: '$125.00',
            interpretationState: 'conflicting', confidence: 0.5, evidenceIds: ['cell-rate-2'],
            rationaleCodes: ['incompatible_values'] },
        ] }) });
    expect(conflicting.status === 'applied' && conflicting.bundle.proposals[0]?.state)
      .toBe('conflicting');

    const insufficient = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => JSON.stringify({ rowInterpretationState: 'insufficient_evidence',
        confidence: null, interpretations: [], missingEvidence: ['missing_column_context'] }) });
    expect(insufficient.status === 'applied' && insufficient.bundle.proposals[0]?.state)
      .toBe('insufficient_evidence');
  });

  it('bounds one row to sixteen cells, 2,000 characters each, and 8,000 aggregate', async () => {
    const cells = Array.from({ length: 20 }, (_, index) => ({
      observationId: `cell-${index}`, rawText: `$${index}${'x'.repeat(2_100)}`,
      columnIndex: index, readingOrder: index,
    }));
    const captured: { value: Record<string, unknown> | null } = { value: null };
    const result = await runForgewingPricingInterpretation(input({ rowObservation: {
      ...input().rowObservation, rawText: 'r'.repeat(5_000), cells,
    } }), { config, taskEnabled: true, provider: async (request) => {
      captured.value = JSON.parse(request.inputJson) as Record<string, unknown>;
      return JSON.stringify({ rowInterpretationState: 'observed', confidence: 0.7,
        interpretations: [{ sourceCellId: 'cell-0', semanticRole: 'rate_like_amount',
          sourceText: '$0', interpretationState: 'observed', confidence: 0.7,
          evidenceIds: ['cell-0'], rationaleCodes: ['explicit_currency_marker'] }] });
    } });
    expect(result.status, JSON.stringify(result)).toBe('applied');
    expect(result.status === 'applied' && result.metadata.inputTruncated).toBe(true);
    const boundedRow = captured.value?.rowObservation as {
      rawText: string; cells: Array<{ rawText: string }>;
    };
    expect(boundedRow.rawText).toHaveLength(4_000);
    expect(boundedRow.cells.length).toBeLessThanOrEqual(16);
    expect(boundedRow.cells.every((cell) => cell.rawText.length <= 2_000)).toBe(true);
    expect(boundedRow.cells.reduce((sum, cell) => sum + cell.rawText.length, 0)).toBeLessThanOrEqual(8_000);
  });

  it('contains malformed output and timeout and hashes bounded input deterministically', async () => {
    const malformed = await runForgewingPricingInterpretation(input(),
      { config, taskEnabled: true, provider: async () => 'not-json' });
    expect(malformed.status === 'abstained' && malformed.warnings).toContain('invalid_model_json');
    const timeout = await runForgewingPricingInterpretation(input(),
      { config: { ...config, timeoutMs: 5 }, taskEnabled: true,
        provider: () => new Promise(() => undefined) });
    expect(timeout.status === 'abstained' && timeout.warnings).toContain('provider_timeout');
    const a = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true, provider: async () => output() });
    const b = await runForgewingPricingInterpretation(input({ rowObservation: { ...input().rowObservation,
      cells: [...input().rowObservation.cells].reverse() } }), { config, taskEnabled: true, provider: async () => output() });
    if (a.status === 'applied' && b.status === 'applied') {
      expect(a.bundle.run.inputSnapshotHash).toBe(b.bundle.run.inputSnapshotHash);
    }
  });

  it('classifies token-exhausted output separately from timeout and schema failure', async () => {
    const truncated = await runForgewingPricingInterpretation(input(), { config, taskEnabled: true,
      provider: async () => { throw new Error('provider_truncated_output'); } });
    expect(truncated.status).toBe('abstained');
    expect(truncated.status === 'abstained' && truncated.warnings).toContain('truncated_output');
    expect(truncated.status === 'abstained' && truncated.warnings).not.toContain('provider_timeout');
    expect(truncated.status === 'abstained' && truncated.warnings).not.toContain('model_schema_rejected');
  });
});
