import { describe, expect, it, vi } from 'vitest';
import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { scheduleRecoveryCandidateV2Shadow } from '@/lib/extraction/persistence/complianceShadow';
import { recoveryEvaluationUnitIdentity } from '@/lib/extraction/recovery/recoveryEvaluationPlanner';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';

const candidate = () => buildRecoveryCandidateV2({
  recoveryType: 'priced_schedule_header_role_selection',
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
  physicalPageNumber: 3, pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'page_priced_schedule:p3:header',
  orderedObservationIds: ['header:description', 'header:unit', 'header:rate'],
  rawTexts: ['Equipment Description', 'Unit', 'Unit Price'],
  composedRawText: 'Equipment Description Unit Unit Price',
  evidence: ['Equipment Description', 'Unit', 'Unit Price'].map((rawText, index) => ({
    observationId: ['header:description', 'header:unit', 'header:rate'][index]!,
    sourceLayer: 'pdf_native_text' as const, rawText,
    boundingBox: { xMin: 10 + index * 100, xMax: 90 + index * 100, yMin: 700, yMax: 710 },
  })),
  headerRoleSelection: {
    parserVersion: 'priced_schedule_reconstruction_v2',
    headerInterpretationVersion: 'priced_schedule_header_interpretation_v1',
    optionId: `header-option-${'c'.repeat(64)}`,
    labels: [
      { text: 'Equipment Description', role: 'description', orderedObservationIds: ['header:description'] },
      { text: 'Unit', role: 'unit', orderedObservationIds: ['header:unit'] },
      { text: 'Unit Price', role: 'rate', orderedObservationIds: ['header:rate'] },
    ],
    structuralRowCount: 39,
  },
})!;

async function schedule(env: Record<string, string | undefined>, prior = false, fail = false) {
  const header = candidate();
  expect(header).not.toBeNull();
  const registered: (() => Promise<void>)[] = [];
  const run = vi.fn();
  const persistProposal = vi.fn(async () => fail
    ? { status: 'failed' as const, reason: 'write_failed' as const }
    : { status: 'persisted' as const, proposalRowId: 'row', proposalDigestSha256: 'd'.repeat(64), inserted: true });
  const persistOutcome = vi.fn(async () => ({ status: 'persisted' as const,
    outcomeRowId: 'outcome', diagnosticId: 'd'.repeat(64), inserted: true }));
  const budget = new ForgewingCallBudget(1);
  budget.tryConsume(); // Human review must still be available when the AI budget is spent.
  scheduleRecoveryCandidateV2Shadow({
    organizationId: '33333333-3333-4333-8333-333333333333',
    sourceDocumentId: header.sourceDocumentId, sourceArtifactId: header.sourceArtifactId,
    extractionSnapshotId: 'snapshot', pricingRows: [], sourceObservations: [],
    pricingSourceEligibility: null, recoveryCandidatesV2: [header], env,
  }, { register: task => registered.push(task), run, persistProposal, persistOutcome, budget,
    loadPriorState: async () => ({ status: 'ok', state: {
      proposedUnitIdentities: prior ? [recoveryEvaluationUnitIdentity({
        recoveryType: header.recoveryType, pageRepresentationDigest: header.pageRepresentationDigest,
        candidateIds: [header.candidateId],
      })] : [], confirmedCandidateIds: [], providerInvokedUnitIdentities: [],
    } }),
  });
  for (const task of registered) await task();
  return { run, persistProposal, persistOutcome, budget };
}

describe('preserved header singleton scheduling', () => {
  const enabled = { FORGEWING_SHADOW_ENABLED: '1', FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1' };
  it('creates an honest review envelope without Forgewing or an available AI budget', async () => {
    const result = await schedule(enabled);
    expect(result.run).not.toHaveBeenCalled();
    expect(result.persistProposal).toHaveBeenCalledWith(expect.objectContaining({
      recoveryType: 'priced_schedule_header_role_selection', certainty: 0,
      providerModel: 'deterministic_header_options', reasonCategory: 'preserved_single_header_option',
      requiresHumanReview: true, authority: 'non_authoritative',
    }));
    expect(result.budget.used).toBe(1);
  });
  it.each([{}, { FORGEWING_SHADOW_ENABLED: '1' }, { FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1' }])(
    'honors the existing kill switch and V2 gate: %j', async env => {
      const result = await schedule(env);
      expect(result.run).not.toHaveBeenCalled();
      expect(result.persistProposal).not.toHaveBeenCalled();
    });
  it('preserves exact prior proposals', async () => {
    const result = await schedule(enabled, true);
    expect(result.run).not.toHaveBeenCalled();
    expect(result.persistProposal).not.toHaveBeenCalled();
  });
  it('records failed deterministic persistence without claiming a provider call', async () => {
    const result = await schedule(enabled, false, true);
    expect(result.persistOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcomeCode: 'deterministic_validation_failed', sanitizedReason: 'write_failed', providerInvoked: false,
    }));
  });
});
