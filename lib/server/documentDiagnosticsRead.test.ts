import { describe, expect, it } from 'vitest';

import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { readDocumentDiagnostics, type DiagnosticReadClient, type DiagnosticReadQuery }
  from '@/lib/server/documentDiagnosticsRead';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

function admin(tables: Record<string, unknown[]>): DiagnosticReadClient {
  return {
    from(table: string) {
      const result = { data: tables[table] ?? [], error: null };
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain, in: () => chain,
        order: () => chain, limit: () => chain,
        then: <R>(resolve: (value: typeof result) => R) => Promise.resolve(resolve(result)),
      };
      return chain as DiagnosticReadQuery;
    },
  };
}

const extraction = {
  id: 'extraction-snapshot-1',
  created_at: '2026-09-12T12:00:00.000Z',
  data: { extraction: {
    physical_page_provenance_v1: { source_artifact_id: ARTIFACT },
    content_layers_v1: { pdf: {
      layout_observations_v1: {
        source_artifact_id: ARTIFACT,
        observations: [{ physical_page_number: 7,
          metadata: { page_representation_digest: DIGEST } }],
      },
      priced_schedule_reconstruction_v1: {
        parser_version: 'priced_schedule_reconstruction_v1',
        pages: [{ physical_page_number: 7, rejected_spines: [], unassigned_lines: [{
          reason: 'ambiguous_row_assignment', raw_text: 'Continuation text',
          source_refs: [{ observation_id: 'obs-continuation', text: 'Continuation text',
            x_min: 10, x_max: 40, y_min: 100, y_max: 112, source: 'pdfjs' }],
        }] }],
      },
    } },
  } },
};

const proposal = {
  proposalId: 'forgewing-proposal-recovery-v2-' + 'b'.repeat(64),
  proposalDigestSha256: 'c'.repeat(64), proposalVersion: 2 as const,
  recoveryType: 'priced_schedule_continuation_attribution' as const, physicalPageNumber: 7,
  sourceDocumentId: DOC, sourceArtifactId: ARTIFACT, pageRepresentationDigest: DIGEST,
  recoveryReason: 'ambiguous_row_assignment', proposedValue: 'Continuation text',
  reasonCategory: 'deterministic_candidate_set', certainty: 0.8,
  selectableObservations: [], selectableCandidates: [], sourceEvidenceBinding: 'bound' as const,
  evidence: [{ observationId: 'obs-continuation', rawText: 'Continuation text',
    sourceLayer: 'pdf_native_text' as const,
    boundingBox: { xMin: 10, xMax: 40, yMin: 100, yMax: 112 }, proposed: true }],
  reviewState: 'pending_review' as const, latestReview: null,
  createdAt: '2026-09-12T12:00:00.000Z',
};

describe('document diagnostics read model', () => {
  it('derives source-bound reconstruction diagnostics and links only an existing proposal', async () => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [proposal] }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'ambiguous_row_assignment', summary: 'Continuation text',
      currentState: 'recovery_available',
      recoveryProposalId: 'forgewing-proposal-recovery-v2-' + 'b'.repeat(64),
      scope: { sourceArtifactId: ARTIFACT, physicalPageNumber: 7,
        pageRepresentationDigest: DIGEST },
      visualEvidence: { kind: 'diagnostic', boxes: [{ role: 'candidate_member' }] },
    });
  });

  it.each([
    ['rejected', 'resolved'],
    ['deferred', 'resolved'],
    ['accepted_awaiting_reprocess', 'reprocess_required'],
  ] as const)('maps a %s review to %s without mutating authority', async (reviewState, state) => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [{ ...proposal, reviewState }] }),
    });
    expect(result.status === 'ok' && result.diagnostics.find((entry) =>
      entry.code === 'ambiguous_row_assignment')?.currentState).toBe(state);
  });

  it('requires human review when recovery is possible but no proposal exists', async () => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics[0]?.currentState)
      .toBe('human_review_required');
  });

  it('projects ambiguous authority and incomplete evidence binding as durable diagnostics', async () => {
    const latestReview = { reviewId: '44444444-4444-4444-8444-444444444444', reviewVersion: 2,
      disposition: 'accepted', confirmedObservationId: null, confirmedCandidateId: null,
      createdAt: '2026-09-12T13:00:00.000Z' };
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [{ ...proposal,
        reviewState: 'ambiguous_authority', sourceEvidenceBinding: 'unbound_identity_incomplete',
        latestReview }] }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'ambiguous_recovery_authority', 'recovery_source_evidence_unbound',
    ]));
    expect(result.diagnostics.find((entry) => entry.code === 'ambiguous_recovery_authority'))
      .toMatchObject({ currentState: 'unbound', recoveryProposalId: proposal.proposalId });
  });

  it('keeps recovery queue read failure visible without hiding independent diagnostics', async () => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null,
        updated_at: '2026-09-12T13:00:00.000Z' }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'read_failed', reason: 'review_read_failed' }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'ambiguous_row_assignment', 'recovery_read_failed',
    ]));
  });

  it('projects incoherent confirmation output from the canonical resolver', async () => {
    const reviewId = '66666666-6666-4666-8666-666666666666';
    const candidate = { ...proposal, reviewState: 'accepted_awaiting_reprocess' as const,
      latestReview: { reviewId, reviewVersion: 1, disposition: 'accepted',
        confirmedObservationId: null, confirmedCandidateId: null,
        createdAt: '2026-09-12T13:00:00.000Z' } };
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [candidate] }),
      resolveRecoveryConfirmations: async () => ({ status: 'ok', confirmations: [], diagnostics: [{
        code: 'incoherent_recovery_confirmation', proposalId: proposal.proposalId,
        proposalDigestSha256: proposal.proposalDigestSha256, reviewId,
        sourceDocumentId: DOC, sourceArtifactId: ARTIFACT, physicalPageNumber: 7,
        expectedObservationId: null, recoveryApplied: false,
      }] }),
    });
    expect(result.status === 'ok' && result.diagnostics.find((entry) =>
      entry.code === 'incoherent_recovery_confirmation')).toMatchObject({
        currentState: 'engineering_attention', recoveryProposalId: proposal.proposalId,
        evidenceRefs: expect.arrayContaining([{ kind: 'recovery_review', reviewId, reviewVersion: 1 }]),
      });
  });

  it('does not invent a page diagnostic when page representation identity is absent', async () => {
    const withoutDigest = structuredClone(extraction);
    withoutDigest.data.extraction.content_layers_v1.pdf.layout_observations_v1.observations = [];
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [withoutDigest], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result).toEqual({ status: 'ok', diagnostics: [] });
  });

  it('classifies existing processing error text read-only without changing its write path', async () => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: 'Worker failed',
        updated_at: '2026-09-12T13:00:00Z' }], document_extractions: [],
        forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics[0]).toMatchObject({
      code: 'document_processing_failed', summary: 'Worker failed', currentState: 'blocked',
    });
  });

  it('classifies immutable failed job history and uses it instead of duplicating document error', async () => {
    const jobId = '55555555-5555-4555-8555-555555555555';
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: 'Worker failed',
        updated_at: '2026-09-12T13:00:00Z' }], document_extractions: [],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [{
          id: jobId, status: 'failed', error_message: 'Worker failed',
          completed_at: '2026-09-12T13:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ code: 'document_processing_failed',
      evidenceRefs: [{ kind: 'processing_job', jobId }],
      sourceIdentity: { processingRunId: jobId } });
  });

  it('maps durable producer outcome codes onto the closed diagnostic registry', async () => {
    const candidateId = `recovery-candidate-v2-${'d'.repeat(64)}`;
    const persistedId = diagnosticId({ code: 'recovery_provider_failed', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }], document_extractions: [],
        forgewing_recovery_generation_outcomes: [{ diagnostic_id: persistedId,
          source_artifact_id: ARTIFACT, extraction_snapshot_id: 'snapshot-outcome',
          physical_page_number: 7, page_representation_digest: DIGEST,
          outcome_code: 'provider_failed', sanitized_reason: 'provider_timeout',
          provider_invoked: true, candidate_ids: [candidateId],
          observed_at: '2026-09-12T12:00:00Z' }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics[0]).toMatchObject({
      diagnosticId: persistedId, code: 'recovery_provider_failed',
      summary: 'provider_timeout', currentState: 'detected',
    });
  });
});
