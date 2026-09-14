import { afterEach, describe, expect, it, vi } from 'vitest';

import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { DIAGNOSTIC_SEVERITY_RANK, readDocumentDiagnostics,
  type DiagnosticReadClient, type DiagnosticReadQuery }
  from '@/lib/server/documentDiagnosticsRead';

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ARTIFACT = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);

function admin(
  tables: Record<string, unknown[]>,
  onSelect?: (table: string, columns: string) => void,
): DiagnosticReadClient {
  return {
    from(table: string) {
      const result = { data: tables[table] ?? [], error: null };
      const chain = {
        select: (columns: string) => { onSelect?.(table, columns); return chain; },
        eq: () => chain, is: () => chain, in: () => chain,
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

const CANDIDATE_ID = `recovery-candidate-v2-${'d'.repeat(64)}`;
const selectableCandidate = {
  candidateId: CANDIDATE_ID,
  recoveryType: 'priced_schedule_continuation_attribution' as const,
  targetRowIdentity: 'target-row-1', composedRawText: 'Continuation text',
  observations: proposal.evidence, targetContext: [], sourceDocumentId: DOC,
  sourceArtifactId: ARTIFACT, physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
  proposed: true,
};

describe('document diagnostics read model', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('uses explicit blocking, warning, info severity order', () => {
    expect(DIAGNOSTIC_SEVERITY_RANK).toEqual({ blocking: 0, warning: 1, info: 2 });
  });

  it('projects page extraction coverage with registry-owned page-scoped diagnostics', async () => {
    const coverageExtraction = structuredClone(extraction);
    const pdf = coverageExtraction.data.extraction.content_layers_v1.pdf as unknown as Record<string, unknown>;
    pdf.page_extraction_coverage_v1 = {
      parser_version: 'page_extraction_coverage_v1',
      pages: [{
        page_number: 7, page_representation_digest: DIGEST,
        expected_evidence_types: ['pricing'], priority: true,
        native: { state: 'abstained' }, visual: { state: 'produced' },
        ocr: { state: 'not_attempted' }, final_state: 'ocr_required',
        reasons: ['operator_expected_pricing_evidence', 'native_text_absent'],
      }],
    };
    (pdf.priced_schedule_reconstruction_v1 as { pages: unknown[] }).pages = [];
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [coverageExtraction], forgewing_recovery_generation_outcomes: [],
        document_analysis_jobs: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'page_ocr_required', stage: 'extraction', severity: 'info',
      scope: { sourceArtifactId: ARTIFACT, physicalPageNumber: 7,
        pageRepresentationDigest: DIGEST },
      evidenceRefs: [], sourceIdentity: { extractionSnapshotId: 'extraction-snapshot-1' },
      visualEvidence: null, recoveryPolicy: null,
    });
  });

  it('distinguishes failed coverage from complete extraction that failed reconstruction', async () => {
    const coverageExtraction = structuredClone(extraction);
    const pdf = coverageExtraction.data.extraction.content_layers_v1.pdf as unknown as Record<string, unknown>;
    pdf.page_extraction_coverage_v1 = {
      parser_version: 'page_extraction_coverage_v1',
      pages: [{
        page_number: 7, page_representation_digest: DIGEST,
        expected_evidence_types: ['pricing'], priority: true,
        native: { state: 'produced' }, visual: { state: 'produced' },
        ocr: { state: 'produced' }, final_state: 'ocr_complete', reasons: [],
      }],
    };
    (pdf.priced_schedule_reconstruction_v1 as { pages: unknown[] }).pages = [{
      physical_page_number: 7, status: 'failed_closed', rejected_spines: [], unassigned_lines: [],
    }];
    const complete = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC }], document_extractions: [coverageExtraction],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(complete.status === 'ok' && complete.diagnostics.map((entry) => entry.code))
      .toEqual(['pricing_page_reconstruction_failed']);

    const coverageLayer = pdf.page_extraction_coverage_v1 as { pages: Array<Record<string, unknown>> };
    coverageLayer.pages[0] = {
      ...coverageLayer.pages[0],
      ocr: { state: 'failed' }, final_state: 'coverage_failed', reasons: ['ocr_failed'],
    };
    const failed = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC }], document_extractions: [coverageExtraction],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(failed.status === 'ok' && failed.diagnostics.map((entry) => entry.code))
      .toEqual(['page_ocr_failed']);
  });

  it('no-ops for absent or malformed coverage and fails closed on page digest conflict', async () => {
    for (const layer of [
      undefined,
      { parser_version: 'future_coverage', pages: [] },
      { parser_version: 'page_extraction_coverage_v1', pages: [{
        page_number: 7, page_representation_digest: 'b'.repeat(64),
        expected_evidence_types: ['pricing'], ocr: { state: 'failed' },
        final_state: 'coverage_failed', reasons: ['ocr_failed'],
      }] },
    ]) {
      const candidate = structuredClone(extraction);
      const pdf = candidate.data.extraction.content_layers_v1.pdf as unknown as Record<string, unknown>;
      (pdf.priced_schedule_reconstruction_v1 as { pages: unknown[] }).pages = [];
      if (layer !== undefined) {
        pdf.page_extraction_coverage_v1 = layer;
      }
      const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
        admin: admin({ documents: [{ id: DOC }], document_extractions: [candidate],
          forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [] }),
        readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
      });
      expect(result).toEqual({ status: 'ok', diagnostics: [] });
    }
  });

  it('orders returned diagnostics as blocking, warning, then info', async () => {
    const candidateId = CANDIDATE_ID;
    const persistedId = diagnosticId({ code: 'recovery_disabled', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [{
          diagnostic_id: persistedId, source_artifact_id: ARTIFACT,
          extraction_snapshot_id: 'snapshot-outcome', physical_page_number: 7,
          page_representation_digest: DIGEST,
          recovery_type: 'priced_schedule_continuation_attribution',
          outcome_code: 'recovery_disabled', sanitized_reason: 'recovery_disabled',
          provider_invoked: false, candidate_ids: [candidateId],
          observed_at: '2026-09-12T12:00:00Z',
        }], document_analysis_jobs: [{
          id: '55555555-5555-4555-8555-555555555555', status: 'failed',
          error_message: 'Worker failed', completed_at: '2026-09-12T13:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics.map((entry) => entry.severity))
      .toEqual(['blocking', 'warning', 'info']);
  });
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
      currentState: 'human_review_required',
      recoveryProposalId: 'forgewing-proposal-recovery-v2-' + 'b'.repeat(64),
      scope: { sourceArtifactId: ARTIFACT, physicalPageNumber: 7,
        pageRepresentationDigest: DIGEST },
      visualEvidence: { kind: 'diagnostic', boxes: [{ role: 'candidate_member' }] },
    });
  });

  it('projects exact OCR render dimensions only when page and representation bind', async () => {
    const ocrExtraction = structuredClone(extraction);
    const pdf = ocrExtraction.data.extraction.content_layers_v1.pdf;
    const observations = pdf.layout_observations_v1 as typeof pdf.layout_observations_v1 & {
      source_page_geometries: Array<Record<string, unknown>>;
    };
    observations.source_page_geometries = [{
      physical_page_number: 7,
      source_layer: 'ocr',
      page_representation_digest: DIGEST,
      pixel_width: 1224,
      pixel_height: 1584,
    }];
    pdf.priced_schedule_reconstruction_v1.pages[0]!.unassigned_lines[0]!
      .source_refs[0]!.source = 'ocr_fallback';
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC }], document_extractions: [ocrExtraction],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics[0]?.visualEvidence).toMatchObject({
      ocrPixelWidth: 1224,
      ocrPixelHeight: 1584,
      boxes: [{ sourceLayer: 'ocr' }],
    });

    observations.source_page_geometries[0]!.page_representation_digest = 'b'.repeat(64);
    const unbound = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC }], document_extractions: [ocrExtraction],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(unbound.status === 'ok' && unbound.diagnostics[0]?.visualEvidence)
      .not.toHaveProperty('ocrPixelWidth');
  });

  it.each([
    ['rejected', 'not_recovered'],
    ['deferred', 'deferred'],
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

  it.each(['rejected', 'deferred'] as const)(
    'does not let a %s review hide a current recovery closure blocker', async (reviewState) => {
      const withClosureFailure = structuredClone(extraction);
      Object.assign(withClosureFailure.data.extraction.content_layers_v1.pdf
        .priced_schedule_reconstruction_v1, { recovery_diagnostics: [{
          reason: 'recovery_closure_failed', physical_page_number: 7,
          observation_id: 'obs-continuation',
        }] });
      const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
        admin: admin({ documents: [{ id: DOC, processing_error: null }],
          document_extractions: [withClosureFailure], forgewing_recovery_generation_outcomes: [] }),
        readRecoveryQueue: async () => ({ status: 'ok', candidates: [{ ...proposal,
          recoveryReason: 'recovery_closure_failed', reviewState }] }),
      });
      expect(result.status === 'ok' && result.diagnostics.find((entry) =>
        entry.code === 'recovery_closure_failed')?.currentState).toBe('blocked');
    },
  );

  it('does not request human review when no recovery proposal can be active', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED', '1');
    vi.stubEnv('FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED', '1');
    const clusterExtraction = structuredClone(extraction);
    clusterExtraction.data.extraction.content_layers_v1.pdf
      .priced_schedule_reconstruction_v1.pages[0]!.unassigned_lines[0]!.reason =
        'ambiguous_rate_clusters';
    const clusterResult = await readDocumentDiagnostics(
      { organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [clusterExtraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(clusterResult.status === 'ok' && clusterResult.diagnostics[0]).toMatchObject({
      code: 'ambiguous_rate_clusters',
      currentState: 'detected',
      recoveryPolicy: {
        qualification: 'synthetic_qualified', activation: 'disabled', reviewRequired: true,
      },
    });

    const continuationResult = await readDocumentDiagnostics(
      { organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(continuationResult.status === 'ok' && continuationResult.diagnostics[0])
      .toMatchObject({
        code: 'ambiguous_row_assignment',
        currentState: 'recovery_available',
        recoveryPolicy: {
          qualification: 'corpus_qualified', activation: 'controlled', reviewRequired: true,
        },
      });
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
    const readFailure = result.diagnostics.find((entry) => entry.code === 'recovery_read_failed');
    expect(readFailure?.summary).not.toContain('review_read_failed');
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

  it.each([
    ['failed then completed', [
      { id: '55555555-5555-4555-8555-555555555551', status: 'failed',
        error_message: 'old failure', completed_at: '2026-09-12T11:00:00Z' },
      { id: '55555555-5555-4555-8555-555555555552', status: 'completed',
        error_message: null, completed_at: '2026-09-12T12:00:00Z' },
    ], null],
    ['failed then completed then failed', [
      { id: '55555555-5555-4555-8555-555555555553', status: 'failed',
        error_message: 'old failure', completed_at: '2026-09-12T10:00:00Z' },
      { id: '55555555-5555-4555-8555-555555555554', status: 'completed',
        error_message: null, completed_at: '2026-09-12T11:00:00Z' },
      { id: '55555555-5555-4555-8555-555555555555', status: 'failed',
        error_message: 'current failure', completed_at: '2026-09-12T12:00:00Z' },
    ], 'current failure'],
    ['multiple failures then completed', [
      { id: '55555555-5555-4555-8555-555555555556', status: 'failed',
        error_message: 'old failure one', completed_at: '2026-09-12T10:00:00Z' },
      { id: '55555555-5555-4555-8555-555555555557', status: 'failed',
        error_message: 'old failure two', completed_at: '2026-09-12T11:00:00Z' },
      { id: '55555555-5555-4555-8555-555555555558', status: 'completed',
        error_message: null, completed_at: '2026-09-12T12:00:00Z' },
    ], null],
  ] as const)('derives current processing state from %s', async (_name, jobs, summary) => {
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: 'stale document error' }],
        document_extractions: [], forgewing_recovery_generation_outcomes: [],
        document_analysis_jobs: [...jobs] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    const processingFailures = result.status === 'ok' ? result.diagnostics.filter((entry) =>
      entry.code === 'document_processing_failed') : [];
    expect(processingFailures.map((entry) => entry.summary)).toEqual(summary ? [summary] : []);
  });

  it('keeps a latest failed job blocking when its error text is absent', async () => {
    const jobId = '55555555-5555-4555-8555-555555555559';
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }], document_extractions: [],
        forgewing_recovery_generation_outcomes: [], document_analysis_jobs: [{
          id: jobId, status: 'failed', error_message: null,
          created_at: '2026-09-12T13:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status === 'ok' && result.diagnostics[0]).toMatchObject({
      code: 'document_processing_failed', currentState: 'blocked',
      evidenceRefs: [{ kind: 'processing_job', jobId }],
    });
  });

  it.each([1_200, 1_201, 100_000])(
    'keeps a blocking processing diagnostic when runtime text has %i characters', async (length) => {
      const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
        admin: admin({ documents: [{ id: DOC, processing_error: 'x'.repeat(length),
          updated_at: '2026-09-12T13:00:00Z' }], document_extractions: [],
          forgewing_recovery_generation_outcomes: [] }),
        readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.diagnostics[0]).toMatchObject({
        code: 'document_processing_failed', currentState: 'blocked',
      });
      expect(result.diagnostics[0]?.summary).toHaveLength(Math.min(length, 1_200));
    },
  );

  it('maps durable producer outcome codes onto the closed diagnostic registry', async () => {
    const candidateId = CANDIDATE_ID;
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
      summary: 'The recovery provider failed before producing a reviewable result.',
      currentState: 'detected',
    });
  });

  it('selects recovery type but does not attach an older proposal to a later outcome', async () => {
    const selectedColumns = new Map<string, string>();
    const linkedProposal = { ...proposal, selectableCandidates: [selectableCandidate],
      createdAt: '2026-09-12T11:00:00Z' };
    const persistedId = diagnosticId({ code: 'recovery_provider_failed', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId: CANDIDATE_ID }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [{
          diagnostic_id: persistedId, source_artifact_id: ARTIFACT,
          extraction_snapshot_id: 'snapshot-outcome', physical_page_number: 7,
          page_representation_digest: DIGEST,
          recovery_type: 'priced_schedule_continuation_attribution',
          outcome_code: 'provider_failed', sanitized_reason: 'provider_timeout',
          provider_invoked: true, candidate_ids: [CANDIDATE_ID],
          observed_at: '2026-09-12T12:00:00Z',
        }] }, (table, columns) => selectedColumns.set(table, columns)),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [linkedProposal] }),
    });
    expect(selectedColumns.get('forgewing_recovery_generation_outcomes')).toContain('recovery_type');
    expect(result.status === 'ok' && result.diagnostics.find((entry) =>
      entry.code === 'recovery_provider_failed')).toMatchObject({
        recoveryProposalId: null, currentState: 'detected',
      });
  });

  it('stops reporting a budget deferral as queued once a later run evaluated the unit', async () => {
    const scope = { organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST };
    const refs = [{ kind: 'recovery_candidate' as const, candidateId: CANDIDATE_ID }];
    const row = (code: string, invoked: boolean, observedAt: string) => ({
      diagnostic_id: diagnosticId({
        code: code === 'budget_exhausted' ? 'recovery_budget_exhausted' : 'recovery_provider_failed',
        scope, evidenceRefs: refs,
      }),
      source_artifact_id: ARTIFACT, extraction_snapshot_id: `snapshot-${observedAt}`,
      physical_page_number: 7, page_representation_digest: DIGEST,
      recovery_type: 'priced_schedule_continuation_attribution', outcome_code: code,
      sanitized_reason: code === 'budget_exhausted' ? 'budget_exhausted' : 'provider_timeout',
      provider_invoked: invoked, candidate_ids: [CANDIDATE_ID], observed_at: observedAt,
    });
    const read = (outcomes: Record<string, unknown>[]) => readDocumentDiagnostics(
      { organizationId: ORG, sourceDocumentId: DOC }, {
        admin: admin({ documents: [{ id: DOC, processing_error: null }],
          document_extractions: [extraction], forgewing_recovery_generation_outcomes: outcomes }),
        readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
      });
    const queued = row('budget_exhausted', false, '2026-09-12T12:00:00Z');

    const stillQueued = await read([queued]);
    expect(stillQueued.status === 'ok' && stillQueued.diagnostics.find((entry) =>
      entry.code === 'recovery_budget_exhausted')).toMatchObject({
        currentState: 'queued_for_later_processing', recommendedNextAction: 'none',
      });

    const evaluated = await read([queued, row('provider_failed', true, '2026-09-12T13:00:00Z')]);
    expect(evaluated.status === 'ok' && evaluated.diagnostics
      .filter((entry) => entry.stage === 'recovery_generation')
      .map((entry) => entry.code))
      .toEqual(['recovery_provider_failed']);
  });

  it('suppresses a historical outcome after a later exact proposal exists', async () => {
    const linkedProposal = { ...proposal, selectableCandidates: [selectableCandidate],
      createdAt: '2026-09-12T13:00:00Z' };
    const persistedId = diagnosticId({ code: 'recovery_disabled', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId: CANDIDATE_ID }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [{
          diagnostic_id: persistedId, source_artifact_id: ARTIFACT,
          extraction_snapshot_id: 'snapshot-outcome', physical_page_number: 7,
          page_representation_digest: DIGEST,
          recovery_type: 'priced_schedule_continuation_attribution', outcome_code: 'recovery_disabled',
          sanitized_reason: 'recovery_disabled', provider_invoked: false,
          candidate_ids: [CANDIDATE_ID], observed_at: '2026-09-12T12:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [linkedProposal] }),
    });
    expect(result.status === 'ok' && result.diagnostics.some((entry) =>
      entry.code === 'recovery_disabled')).toBe(false);
  });

  it('does not suppress a distinct candidate failure when a later proposal only overlaps it', async () => {
    const otherCandidateId = `recovery-candidate-v2-${'e'.repeat(64)}`;
    const overlappingProposal = { ...proposal,
      selectableCandidates: [selectableCandidate, { ...selectableCandidate,
        candidateId: otherCandidateId }], createdAt: '2026-09-12T13:00:00Z' };
    const persistedId = diagnosticId({ code: 'recovery_provider_failed', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: DIGEST,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId: CANDIDATE_ID }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [{
          diagnostic_id: persistedId, source_artifact_id: ARTIFACT,
          extraction_snapshot_id: 'snapshot-outcome', physical_page_number: 7,
          page_representation_digest: DIGEST,
          recovery_type: 'priced_schedule_continuation_attribution', outcome_code: 'provider_failed',
          sanitized_reason: 'provider_error', provider_invoked: true,
          candidate_ids: [CANDIDATE_ID], observed_at: '2026-09-12T12:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [overlappingProposal] }),
    });
    expect(result.status === 'ok' && result.diagnostics.some((entry) =>
      entry.code === 'recovery_provider_failed')).toBe(true);
  });

  it('suppresses an outcome from an older page representation without hiding current failures', async () => {
    const oldDigest = 'e'.repeat(64);
    const staleId = diagnosticId({ code: 'recovery_provider_failed', scope: {
      organizationId: ORG, sourceDocumentId: DOC, sourceArtifactId: ARTIFACT,
      physicalPageNumber: 7, pageRepresentationDigest: oldDigest,
    }, evidenceRefs: [{ kind: 'recovery_candidate', candidateId: CANDIDATE_ID }] });
    const result = await readDocumentDiagnostics({ organizationId: ORG, sourceDocumentId: DOC }, {
      admin: admin({ documents: [{ id: DOC, processing_error: null }],
        document_extractions: [extraction], forgewing_recovery_generation_outcomes: [{
          diagnostic_id: staleId, source_artifact_id: ARTIFACT,
          extraction_snapshot_id: 'old-snapshot', physical_page_number: 7,
          page_representation_digest: oldDigest,
          recovery_type: 'priced_schedule_continuation_attribution',
          outcome_code: 'provider_failed', sanitized_reason: 'provider_error', provider_invoked: true,
          candidate_ids: [CANDIDATE_ID], observed_at: '2026-09-12T11:00:00Z',
        }] }),
      readRecoveryQueue: async () => ({ status: 'ok', candidates: [] }),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.diagnostics.some((entry) => entry.code === 'recovery_provider_failed')).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === 'ambiguous_row_assignment')).toBe(true);
  });
});
