import { describe, expect, it } from 'vitest';

import { buildRecoveryCandidateV2 } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { recoveryEvaluationUnitIdentity }
  from '@/lib/extraction/recovery/recoveryEvaluationPlanner';
import { loadRecoveryEvaluationPriorState }
  from '@/lib/server/recoveryEvaluationPriorState';

const recoveryCandidate = buildRecoveryCandidateV2({
  recoveryType: 'priced_schedule_continuation_attribution',
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
  physicalPageNumber: 3,
  pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'row:1',
  orderedObservationIds: ['obs:1'],
  rawTexts: ['Continuation'],
  composedRawText: 'Continuation',
  evidence: [{ observationId: 'obs:1', sourceLayer: 'pdf_native_text',
    rawText: 'Continuation', boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } }],
})!;

function client(
  rows: Record<string, unknown[]>,
  errors: Record<string, string> = {},
  calls: Array<readonly [string, unknown]> = [],
) {
  return {
    from(table: string) {
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          calls.push([column, value]);
          return query;
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(resolve({
            data: rows[table] ?? [],
            error: errors[table] ? { message: errors[table] } : null,
          }));
        },
      };
      return query;
    },
  };
}

describe('recovery evaluation prior state', () => {
  it('derives proposal suppression and invoked retry state from existing rows', async () => {
    const calls: Array<readonly [string, unknown]> = [];
    const expected = recoveryEvaluationUnitIdentity({
      recoveryType: recoveryCandidate.recoveryType,
      pageRepresentationDigest: recoveryCandidate.pageRepresentationDigest,
      candidateIds: [recoveryCandidate.candidateId],
    });
    const result = await loadRecoveryEvaluationPriorState({
      organizationId: '33333333-3333-4333-8333-333333333333',
      sourceDocumentId: recoveryCandidate.sourceDocumentId,
      sourceArtifactId: recoveryCandidate.sourceArtifactId,
    }, { admin: client({
      forgewing_recovery_proposals: [{
        recovery_type: recoveryCandidate.recoveryType,
        page_representation_digest: recoveryCandidate.pageRepresentationDigest,
        recovery_candidates: [recoveryCandidate],
      }],
      forgewing_recovery_generation_outcomes: [{
        recovery_type: recoveryCandidate.recoveryType,
        page_representation_digest: recoveryCandidate.pageRepresentationDigest,
        provider_invoked: true,
        candidate_ids: [recoveryCandidate.candidateId],
      }],
    }, {}, calls) as never });
    expect(result).toEqual({ status: 'ok', state: {
      proposedUnitIdentities: [expected],
      confirmedCandidateIds: [],
      providerInvokedUnitIdentities: [expected],
    } });
    expect(calls).toEqual([
      ['organization_id', '33333333-3333-4333-8333-333333333333'],
      ['source_document_id', recoveryCandidate.sourceDocumentId],
      ['source_artifact_id', recoveryCandidate.sourceArtifactId],
      ['organization_id', '33333333-3333-4333-8333-333333333333'],
      ['source_document_id', recoveryCandidate.sourceDocumentId],
      ['source_artifact_id', recoveryCandidate.sourceArtifactId],
    ]);
  });

  it('fails closed when either durable-state read fails', async () => {
    const result = await loadRecoveryEvaluationPriorState({
      organizationId: '33333333-3333-4333-8333-333333333333',
      sourceDocumentId: recoveryCandidate.sourceDocumentId,
      sourceArtifactId: recoveryCandidate.sourceArtifactId,
    }, { admin: client({}, { forgewing_recovery_proposals: 'read failed' }) as never });
    expect(result).toEqual({ status: 'read_failed', reason: 'read failed' });
  });

  it('fails closed on malformed V2 proposal or outcome state', async () => {
    const query = {
      organizationId: '33333333-3333-4333-8333-333333333333',
      sourceDocumentId: recoveryCandidate.sourceDocumentId,
      sourceArtifactId: recoveryCandidate.sourceArtifactId,
    };
    await expect(loadRecoveryEvaluationPriorState(query, { admin: client({
      forgewing_recovery_proposals: [{
        recovery_type: recoveryCandidate.recoveryType,
        page_representation_digest: recoveryCandidate.pageRepresentationDigest,
        recovery_candidates: [{ malformed: true }],
      }],
    }) as never })).resolves.toEqual({ status: 'read_failed', reason: 'invalid_prior_state' });
    await expect(loadRecoveryEvaluationPriorState(query, { admin: client({
      forgewing_recovery_generation_outcomes: [{
        recovery_type: recoveryCandidate.recoveryType,
        page_representation_digest: recoveryCandidate.pageRepresentationDigest,
        provider_invoked: 'yes',
        candidate_ids: [recoveryCandidate.candidateId],
      }],
    }) as never })).resolves.toEqual({ status: 'read_failed', reason: 'invalid_prior_state' });
  });
});
