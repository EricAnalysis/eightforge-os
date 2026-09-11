import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { runRecoveryCandidateV2Recommendation } from '@/lib/forgewing/tasks/recoveryCandidateV2';

const candidate = buildRecoveryCandidateV2({
  recoveryType: 'priced_schedule_continuation_attribution',
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
  physicalPageNumber: 3, pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'page_priced_schedule:p3:r1',
  orderedObservationIds: ['obs:fragment'], rawTexts: ['Disposal'],
  composedRawText: 'Inert Debris Removal and Disposal',
  evidence: [{ observationId: 'obs:fragment', sourceLayer: 'pdf_native_text', rawText: 'Disposal',
    boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } }],
})!;
const input = { organizationId: '33333333-3333-4333-8333-333333333333',
  extractionSnapshotId: 'snapshot-1', candidates: [candidate] };
const config = { enabled: true, model: 'test-model', timeoutMs: 1000,
  maxCalls: 1, maxOutputTokens: 400 };

describe('Recovery V2 candidate recommendation', () => {
  it('selects one pre-built candidate with one provider call', async () => {
    const provider = vi.fn(async () => JSON.stringify({
      selectedCandidateId: candidate.candidateId, confidence: 0.8, rationaleCode: 'row_context',
    }));
    const result = await runRecoveryCandidateV2Recommendation(input,
      { config, enabled: true, provider });
    expect(result).toMatchObject({ status: 'requires_human_review',
      selectedCandidateId: candidate.candidateId, providerCalls: 1 });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider-created candidate id', async () => {
    const result = await runRecoveryCandidateV2Recommendation(input, {
      config, enabled: true,
      provider: async () => JSON.stringify({ selectedCandidateId: `recovery-candidate-v2-${'f'.repeat(64)}`,
        confidence: 0.9, rationaleCode: 'invented' }),
    });
    expect(result).toMatchObject({ status: 'evidence_binding_failed', reason: 'unknown_candidate' });
  });

  it('makes no provider call while disabled', async () => {
    const provider = vi.fn();
    await expect(runRecoveryCandidateV2Recommendation(input,
      { config, enabled: false, provider })).resolves.toMatchObject({ providerCalls: 0 });
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('Recovery V2 candidate generation fan-out', () => {
  it('caps a document at the shared call budget instead of one call per unit', async () => {
    // A real priced page can carry a dozen ambiguous continuations. Each is its
    // own evaluation unit, but they must share one document-level budget: units
    // past it abstain having called nothing, rather than multiplying provider
    // calls by however many fragments the page happens to contain.
    const provider = vi.fn(async () => JSON.stringify({
      selectedCandidateId: candidate.candidateId, confidence: 0.8, rationaleCode: 'row_context',
    }));
    const budget = new ForgewingCallBudget(2);
    const outcomes = [];
    for (let unit = 0; unit < 5; unit += 1) {
      outcomes.push(await runRecoveryCandidateV2Recommendation(input,
        { config, enabled: true, provider, budget }));
    }
    expect(provider).toHaveBeenCalledTimes(2);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'requires_human_review', 'requires_human_review',
      'eligible_not_executed', 'eligible_not_executed', 'eligible_not_executed',
    ]);
    expect(outcomes.slice(2).every((outcome) =>
      'reason' in outcome && outcome.reason === 'budget_exhausted'
      && outcome.providerCalls === 0)).toBe(true);
  });

  it('shares one budget across the whole document generation pass', () => {
    const shadow = readFileSync('lib/extraction/persistence/complianceShadow.ts', 'utf8');
    const dispatcher = shadow.slice(shadow.indexOf('export function scheduleRecoveryCandidateV2Shadow'));
    // The budget is constructed once, outside the per-unit loop.
    expect(dispatcher.indexOf('new ForgewingCallBudget'))
      .toBeLessThan(dispatcher.indexOf('for (const unitCandidates of groups.values())'));
    expect(dispatcher).toContain('{ budget }');
  });
});
