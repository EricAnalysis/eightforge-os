import { describe, expect, it, vi } from 'vitest';

import {
  persistForgewingRecoveryGenerationOutcome,
  recoveryGenerationDiagnosticId,
  sanitizeRecoveryGenerationReason,
  type RecoveryGenerationOutcome,
} from '@/lib/server/forgewingRecoveryGenerationOutcomePersistence';
import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';

const base: RecoveryGenerationOutcome = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  sourceDocumentId: '20000000-0000-4000-8000-000000000001',
  sourceArtifactId: '30000000-0000-4000-8000-000000000001',
  extractionSnapshotId: 'snapshot-1',
  physicalPageNumber: 3,
  pageRepresentationDigest: 'a'.repeat(64),
  recoveryType: 'priced_schedule_continuation_attribution',
  outcomeCode: 'provider_failed',
  sanitizedReason: 'provider_error',
  providerInvoked: true,
  candidateIds: [`recovery-candidate-v2-${'b'.repeat(64)}`],
};

describe('recovery generation outcome persistence', () => {
  it('builds the canonical source-bound diagnostic identity', () => {
    expect(recoveryGenerationDiagnosticId(base)).toBe(diagnosticId({
      code: 'recovery_provider_failed',
      scope: {
        organizationId: base.organizationId,
        sourceDocumentId: base.sourceDocumentId,
        sourceArtifactId: base.sourceArtifactId,
        physicalPageNumber: base.physicalPageNumber,
        pageRepresentationDigest: base.pageRepresentationDigest,
      },
      evidenceRefs: base.candidateIds.map((candidateId) => ({
        kind: 'recovery_candidate' as const, candidateId,
      })),
    }));
    expect(recoveryGenerationDiagnosticId(base)).toBe(recoveryGenerationDiagnosticId({ ...base }));
    expect(recoveryGenerationDiagnosticId({ ...base, candidateIds: [
      `recovery-candidate-v2-${'c'.repeat(64)}`, ...base.candidateIds,
    ] })).toBe(recoveryGenerationDiagnosticId({ ...base, candidateIds: [
      ...base.candidateIds, `recovery-candidate-v2-${'c'.repeat(64)}`,
    ] }));
  });

  it('maps arbitrary provider errors to closed sanitized reasons', () => {
    expect(sanitizeRecoveryGenerationReason('provider_failed',
      new Error('secret provider payload and credential details'))).toBe('provider_error');
    expect(sanitizeRecoveryGenerationReason('provider_failed',
      new Error('Request timed out'))).toBe('provider_timeout');
    expect(sanitizeRecoveryGenerationReason('structured_output_invalid',
      'unexpected parser internals')).toBe('invalid_json');
  });

  it('calls the RPC with deterministic identity and parses an inserted receipt', async () => {
    const rpc = vi.fn(async () => ({ data: [{
      outcome_row_id: '40000000-0000-4000-8000-000000000001', inserted: true,
    }], error: null }));
    const result = await persistForgewingRecoveryGenerationOutcome(base, { admin: { rpc } });
    expect(result).toMatchObject({ status: 'persisted', inserted: true,
      diagnosticId: recoveryGenerationDiagnosticId(base) });
    expect(rpc).toHaveBeenCalledWith('record_forgewing_recovery_generation_outcome',
      expect.objectContaining({
        p_diagnostic_id: recoveryGenerationDiagnosticId(base),
        p_sanitized_reason: 'provider_error',
        p_candidate_ids: base.candidateIds,
      }));
  });

  it('fails closed for malformed outcomes, unavailable configuration, and bad receipts', async () => {
    await expect(persistForgewingRecoveryGenerationOutcome({
      ...base, providerInvoked: false,
    })).resolves.toEqual({ status: 'failed', reason: 'invalid_outcome' });
    await expect(persistForgewingRecoveryGenerationOutcome(base, { admin: null }))
      .resolves.toEqual({ status: 'skipped', reason: 'not_configured' });
    await expect(persistForgewingRecoveryGenerationOutcome(base, { admin: {
      rpc: async () => ({ data: [], error: null }),
    } })).resolves.toEqual({ status: 'failed', reason: 'write_failed' });
  });
});
