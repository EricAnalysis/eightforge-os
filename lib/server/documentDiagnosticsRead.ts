import { DiagnosticCodeSchema, DiagnosticRecoveryTypeSchema, FailureDiagnosticSchema,
  type DiagnosticCode, type DiagnosticEvidenceRef, type DiagnosticRecoveryType,
  type FailureDiagnostic }
  from '@/lib/diagnostics/failureDiagnostic';
import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { getFailureRegistryEntry } from '@/lib/diagnostics/failureRegistry';
import { resolveCanonicalObservationBoxes } from '@/lib/extraction/pdf/layoutObservationEvidence';
import type { DiagnosticVisualSourceEvidence, VisualSourceBox }
  from '@/lib/recovery/visualSourceEvidence';
import { readRecoveryReviewQueue, type RecoveryReviewCandidate }
  from '@/lib/server/forgewingRecoveryReviewRead';
import { resolveEffectiveRecoveryConfirmations }
  from '@/lib/server/effectiveRecoveryConfirmations';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  recoveryOperationalState,
  type RecoveryActivation,
  type RecoveryQualification,
} from '@/lib/extraction/recovery/recoveryOperationalPolicy';

export const RECOVERY_GENERATION_OUTCOMES_TABLE = 'forgewing_recovery_generation_outcomes';
export const DIAGNOSTIC_SEVERITY_RANK = Object.freeze({
  blocking: 0,
  warning: 1,
  info: 2,
} as const);
const RECOVERY_OUTCOME_DIAGNOSTIC_CODE = Object.freeze({
  provider_failed: 'recovery_provider_failed',
  structured_output_invalid: 'recovery_structured_output_invalid',
  evidence_binding_failed: 'recovery_evidence_binding_failed',
  deterministic_validation_failed: 'recovery_deterministic_validation_failed',
  proposal_persist_failed: 'recovery_proposal_persist_failed',
  budget_exhausted: 'recovery_budget_exhausted',
  recovery_disabled: 'recovery_disabled',
} as const satisfies Record<string, DiagnosticCode>);

export type DiagnosticCurrentState =
  | 'detected' | 'recovery_available' | 'human_review_required' | 'reprocess_required'
  | 'unbound' | 'blocked' | 'engineering_attention' | 'deferred' | 'not_recovered'
  | 'queued_for_later_processing' | 'resolved';

const FAILURE_DIAGNOSTIC_SUMMARY_MAX_LENGTH = 1_200;

export type DocumentDiagnostic = FailureDiagnostic & Readonly<{
  currentState: DiagnosticCurrentState;
  recoveryProposalId: string | null;
  visualEvidence: DiagnosticVisualSourceEvidence | null;
  recoveryPolicy: Readonly<{
    qualification: RecoveryQualification;
    activation: RecoveryActivation;
    reviewRequired: boolean;
  }> | null;
}>;

export type DocumentDiagnosticsResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; diagnostics: readonly DocumentDiagnostic[] }>;

type QueryResult = { data: unknown; error: { message?: string } | null };
export type DiagnosticReadQuery = PromiseLike<QueryResult> & {
  select(columns: string): DiagnosticReadQuery;
  eq(column: string, value: unknown): DiagnosticReadQuery;
  is(column: string, value: null): DiagnosticReadQuery;
  in(column: string, values: readonly unknown[]): DiagnosticReadQuery;
  order(column: string, options: { ascending: boolean }): DiagnosticReadQuery;
  limit(count: number): DiagnosticReadQuery;
};
export type DiagnosticReadClient = Readonly<{
  from(table: string): DiagnosticReadQuery;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    const row = record(entry); return row ? [row] : [];
  });
}

function iso(value: unknown): string {
  try { return new Date(typeof value === 'string' ? value : 0).toISOString(); }
  catch { return new Date(0).toISOString(); }
}

type DiagnosticSourceRef = Readonly<{ observation_id?: string; text: string;
  x_min: number; x_max: number; y_min: number; y_max: number;
  source?: 'pdfjs' | 'ocr_fallback' }>;

function evidenceRefs(refs: readonly DiagnosticSourceRef[]): DiagnosticEvidenceRef[] {
  return refs.flatMap((ref) => ref.observation_id
    ? [{ kind: 'observation' as const, observationId: ref.observation_id }] : []);
}

function boxes(
  refs: readonly DiagnosticSourceRef[],
  page: number,
  canonicalSidecar?: unknown,
): VisualSourceBox[] {
  const drawn = refs.flatMap((ref, memberIndex) => ref.observation_id ? [{
    observationId: ref.observation_id,
    rawText: ref.text,
    role: 'candidate_member' as const,
    boundingBox: { xMin: ref.x_min, xMax: ref.x_max, yMin: ref.y_min, yMax: ref.y_max },
    sourceLayer: ref.source === 'ocr_fallback' ? 'ocr' as const : 'pdf_native_text' as const,
    sourceCoordinateSpace: ref.source === 'ocr_fallback'
      ? 'ocr_render_px' as const : 'pdf_user_unrotated' as const,
    memberIndex,
  }] : []);
  // Canonical geometry is adopted only for a ref whose source box still
  // matches the one the sidecar was derived from.
  const canonical = resolveCanonicalObservationBoxes(canonicalSidecar, drawn.map((box) => ({
    observationId: box.observationId, physicalPageNumber: page, boundingBox: box.boundingBox,
  })));
  return drawn.map((box) => {
    const canonicalBoundingBox = canonical.get(box.observationId);
    return canonicalBoundingBox ? { ...box, canonicalBoundingBox } : box;
  });
}

function buildDiagnostic(input: Readonly<{
  code: DiagnosticCode;
  organizationId: string;
  sourceDocumentId: string;
  sourceArtifactId: string | null;
  physicalPageNumber: number | null;
  pageRepresentationDigest: string | null;
  summary?: string;
  evidenceRefs: readonly DiagnosticEvidenceRef[];
  extractionSnapshotId: string | null;
  processingRunId?: string | null;
  occurredAt: string;
  visualBoxes?: readonly VisualSourceBox[];
  ocrPixelWidth?: number;
  ocrPixelHeight?: number;
  proposal?: RecoveryReviewCandidate | null;
  recoveryType?: DiagnosticRecoveryType | null;
}>): DocumentDiagnostic | null {
  const registry = getFailureRegistryEntry(input.code);
  const scope = {
    organizationId: input.organizationId,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId,
    physicalPageNumber: input.physicalPageNumber,
    pageRepresentationDigest: input.pageRepresentationDigest,
  };
  let id: string;
  try { id = diagnosticId({ code: input.code, scope, evidenceRefs: input.evidenceRefs }); }
  catch { return null; }
  const candidate = {
    diagnosticId: id,
    code: input.code,
    ...registry,
    scope,
    summary: (input.summary?.trim() || registry.summary)
      .slice(0, FAILURE_DIAGNOSTIC_SUMMARY_MAX_LENGTH),
    evidenceRefs: [...input.evidenceRefs],
    sourceIdentity: {
      extractionSnapshotId: input.extractionSnapshotId,
      processingRunId: input.processingRunId ?? null,
    },
    occurredAt: input.occurredAt,
  };
  const parsed = FailureDiagnosticSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const proposal = input.proposal ?? null;
  const operationalType = input.recoveryType ?? registry.recoveryType ?? proposal?.recoveryType ?? null;
  const recoveryPolicy = operationalType ? (() => {
    const policy = recoveryOperationalState(operationalType);
    return {
      qualification: policy.qualification,
      activation: policy.activation,
      reviewRequired: policy.reviewRequired,
    };
  })() : null;
  const currentState: DiagnosticCurrentState = input.code === 'confirmed_recovery_unbound'
    || input.code === 'recovery_source_evidence_unbound'
    || proposal?.sourceEvidenceBinding === 'unbound_identity_incomplete'
    ? 'unbound'
    : input.code === 'ambiguous_recovery_confirmation'
        || input.code === 'recovery_closure_failed'
        || proposal?.reviewState === 'ambiguous_authority'
        ? 'blocked'
      : proposal?.reviewState === 'deferred'
        ? 'deferred'
        : proposal?.reviewState === 'rejected'
          ? 'not_recovered'
        : registry.recoverability === 'engineering_diagnostic'
          ? 'engineering_attention'
          : input.code === 'recovery_budget_exhausted'
            ? 'queued_for_later_processing'
          : proposal?.reviewState === 'accepted_awaiting_reprocess'
            ? 'reprocess_required'
            : proposal?.reviewState === 'pending_review'
              ? 'human_review_required'
              : registry.recoverability === 'recoverable_after_human_review'
                ? recoveryPolicy?.activation !== 'disabled'
                  ? 'recovery_available' : 'detected'
                : registry.severity === 'blocking' ? 'blocked' : 'detected';
  const visualEvidence = input.sourceArtifactId && input.physicalPageNumber
    && input.pageRepresentationDigest && input.visualBoxes?.length ? {
      kind: 'diagnostic' as const,
      diagnosticId: id,
      summary: parsed.data.summary,
      sourceArtifactId: input.sourceArtifactId,
      sourceDocumentId: input.sourceDocumentId,
      physicalPageNumber: input.physicalPageNumber,
      pageRepresentationDigest: input.pageRepresentationDigest,
      ...(input.ocrPixelWidth && input.ocrPixelHeight ? {
        ocrPixelWidth: input.ocrPixelWidth,
        ocrPixelHeight: input.ocrPixelHeight,
      } : {}),
      boxes: [...input.visualBoxes],
    } : null;
  return { ...parsed.data, currentState, recoveryProposalId: proposal?.proposalId ?? null,
    visualEvidence, recoveryPolicy };
}

function matchingProposal(
  code: DiagnosticCode,
  page: number,
  refs: readonly DiagnosticEvidenceRef[],
  proposals: readonly RecoveryReviewCandidate[],
): RecoveryReviewCandidate | null {
  const observationIds = new Set(refs.flatMap((ref) =>
    ref.kind === 'observation' ? [ref.observationId] : []));
  return proposals.find((proposal) => proposal.physicalPageNumber === page
    && proposal.recoveryReason === code
    && proposal.evidence.some((entry) => observationIds.has(entry.observationId))) ?? null;
}

function exactOcrPageGeometry(
  observationsLayer: Record<string, unknown> | null,
  page: number,
  pageRepresentationDigest: string,
): Readonly<{ width: number; height: number }> | null {
  const matches = records(observationsLayer?.source_page_geometries).filter((entry) =>
    entry.source_layer === 'ocr'
    && entry.physical_page_number === page
    && entry.page_representation_digest === pageRepresentationDigest);
  if (matches.length !== 1) return null;
  const width = Number(matches[0]!.pixel_width);
  const height = Number(matches[0]!.pixel_height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : null;
}

function reconstructionDiagnostics(params: Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  extraction: Record<string, unknown>;
  extractionSnapshotId: string;
  occurredAt: string;
  proposals: readonly RecoveryReviewCandidate[];
}>): DocumentDiagnostic[] {
  const extractionRoot = record(params.extraction.extraction);
  const provenance = record(extractionRoot?.physical_page_provenance_v1);
  const layers = record(extractionRoot?.content_layers_v1);
  const pdf = record(layers?.pdf);
  const reconstruction = record(pdf?.priced_schedule_reconstruction_v1);
  const observationsLayer = record(pdf?.layout_observations_v1);
  if (reconstruction?.parser_version !== 'priced_schedule_reconstruction_v1'
    || !Array.isArray(reconstruction.pages)) return [];
  const sourceArtifactId = typeof observationsLayer?.source_artifact_id === 'string'
    ? observationsLayer.source_artifact_id
    : typeof provenance?.source_artifact_id === 'string' ? provenance.source_artifact_id : null;
  const pageDigest = new Map<number, string>();
  for (const observation of records(observationsLayer?.observations)) {
    const metadata = record(observation.metadata);
    const page = Number(observation.physical_page_number);
    if (Number.isInteger(page) && typeof metadata?.page_representation_digest === 'string') {
      pageDigest.set(page, metadata.page_representation_digest);
    }
  }
  const output: DocumentDiagnostic[] = [];
  for (const rawPage of records(reconstruction.pages)) {
    const page = Number(rawPage.physical_page_number);
    const digest = pageDigest.get(page) ?? null;
    if (!Number.isInteger(page) || page < 1 || !digest) continue;
    for (const raw of [...records(rawPage.rejected_spines), ...records(rawPage.unassigned_lines)]) {
      const parsedCode = DiagnosticCodeSchema.safeParse(raw.reason);
      if (!parsedCode.success) continue;
      const sourceRefs = records(raw.source_refs).map((ref) => ({
        observation_id: typeof ref.observation_id === 'string' ? ref.observation_id : undefined,
        text: String(ref.text ?? ''), x_min: Number(ref.x_min), x_max: Number(ref.x_max),
        y_min: Number(ref.y_min), y_max: Number(ref.y_max),
        source: ref.source === 'ocr_fallback' ? 'ocr_fallback' as const : 'pdfjs' as const,
      }));
      const refs = evidenceRefs(sourceRefs);
      const ocrGeometry = exactOcrPageGeometry(observationsLayer, page, digest);
      const diagnostic = buildDiagnostic({ code: parsedCode.data,
        organizationId: params.organizationId, sourceDocumentId: params.sourceDocumentId,
        sourceArtifactId, physicalPageNumber: page, pageRepresentationDigest: digest,
        summary: typeof raw.raw_text === 'string' ? raw.raw_text : undefined,
        evidenceRefs: refs,
        visualBoxes: boxes(sourceRefs, page, observationsLayer?.canonical_geometry_v1),
        ocrPixelWidth: ocrGeometry?.width, ocrPixelHeight: ocrGeometry?.height,
        extractionSnapshotId: params.extractionSnapshotId, occurredAt: params.occurredAt,
        proposal: matchingProposal(parsedCode.data, page, refs, params.proposals) });
      if (diagnostic) output.push(diagnostic);
    }
  }
  for (const raw of records(reconstruction.recovery_diagnostics)) {
    const parsedCode = DiagnosticCodeSchema.safeParse(raw.reason);
    const page = Number(raw.physical_page_number);
    if (!parsedCode.success || !Number.isInteger(page) || page < 1 || !pageDigest.has(page)) continue;
    const refs: DiagnosticEvidenceRef[] = typeof raw.observation_id === 'string'
      ? [{ kind: 'observation', observationId: raw.observation_id }] : [];
    if (typeof raw.candidate_id === 'string') {
      refs.push({ kind: 'recovery_candidate', candidateId: raw.candidate_id });
    }
    const diagnostic = buildDiagnostic({ code: parsedCode.data,
      organizationId: params.organizationId, sourceDocumentId: params.sourceDocumentId,
      sourceArtifactId, physicalPageNumber: page, pageRepresentationDigest: pageDigest.get(page)!,
      evidenceRefs: refs, extractionSnapshotId: params.extractionSnapshotId,
      occurredAt: params.occurredAt, proposal: matchingProposal(parsedCode.data, page, refs, params.proposals) });
    if (diagnostic) output.push(diagnostic);
  }
  return output;
}

const PAGE_COVERAGE_FINAL_STATES = new Set([
  'native_complete', 'ocr_required', 'mixed_ocr_required', 'ocr_complete',
  'empty_page', 'uncertain', 'coverage_failed',
]);
const PAGE_COVERAGE_OCR_STATES = new Set([
  'produced', 'abstained', 'not_eligible', 'not_attempted', 'failed',
]);

/**
 * Projects the extraction-owned coverage record without making it authoritative.
 * The layer is optional for pre-coverage extractions, and every page-scoped item
 * fails closed unless it binds to one unambiguous current page representation.
 */
function extractionCoverageDiagnostics(params: Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  extraction: Record<string, unknown>;
  extractionSnapshotId: string;
  occurredAt: string;
}>): DocumentDiagnostic[] {
  const extractionRoot = record(params.extraction.extraction);
  const pdf = record(record(extractionRoot?.content_layers_v1)?.pdf);
  const coverage = record(pdf?.page_extraction_coverage_v1);
  if (coverage?.parser_version !== 'page_extraction_coverage_v1'
    || !Array.isArray(coverage.pages)) return [];

  const sourceArtifactId = trustedCurrentSourceArtifactId(params.extraction);
  if (!sourceArtifactId) return [];
  const observationDigests = extractionPageRepresentationDigests(params.extraction);
  const failedReconstructionPages = new Set(records(
    record(pdf?.priced_schedule_reconstruction_v1)?.pages,
  ).flatMap((page) => {
    const pageNumber = Number(page.physical_page_number);
    return page.status === 'failed_closed' && Number.isInteger(pageNumber) && pageNumber > 0
      ? [pageNumber] : [];
  }));
  const output: DocumentDiagnostic[] = [];

  for (const page of records(coverage.pages)) {
    const pageNumber = Number(page.page_number);
    const finalState = page.final_state;
    const ocrState = record(page.ocr)?.state;
    if (!Number.isInteger(pageNumber) || pageNumber < 1
      || typeof finalState !== 'string' || !PAGE_COVERAGE_FINAL_STATES.has(finalState)
      || typeof ocrState !== 'string' || !PAGE_COVERAGE_OCR_STATES.has(ocrState)) continue;

    const explicitDigest = page.page_representation_digest;
    if (explicitDigest !== undefined
      && (typeof explicitDigest !== 'string' || !/^[a-f0-9]{64}$/.test(explicitDigest))) continue;
    const observedDigest = observationDigests.get(pageNumber);
    if (typeof explicitDigest === 'string' && observedDigest && explicitDigest !== observedDigest) continue;
    const pageRepresentationDigest = typeof explicitDigest === 'string'
      ? explicitDigest : observedDigest;
    if (!pageRepresentationDigest) continue;

    const expectedPricing = Array.isArray(page.expected_evidence_types)
      && page.expected_evidence_types.includes('pricing');
    const reasons = Array.isArray(page.reasons)
      ? page.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
    const codes: DiagnosticCode[] = [];
    if (reasons.includes('page_skipped_due_evidence_limit')) {
      codes.push('page_skipped_due_evidence_limit');
    } else if (reasons.includes('image_decode_failed') || reasons.includes('image_decode_unverifiable')) {
      codes.push('page_image_decode_failed');
    } else if (ocrState === 'failed') {
      codes.push('page_ocr_failed');
    } else if (ocrState === 'abstained' && finalState === 'coverage_failed') {
      codes.push('page_ocr_abstained');
    } else if ((finalState === 'ocr_required' || finalState === 'mixed_ocr_required')
      && ocrState === 'not_attempted') {
      codes.push('page_ocr_required');
    } else if (finalState === 'uncertain' || finalState === 'coverage_failed') {
      // Selective OCR is intentional: a document type that is not eligible for
      // OCR is recorded as uncertain coverage, not surfaced as a failure,
      // unless the operator said this page should carry pricing.
      if (expectedPricing) codes.push('expected_pricing_page_no_usable_evidence');
      else if (!reasons.includes('ocr_not_eligible_for_document')) {
        codes.push('page_extraction_coverage_incomplete');
      }
    }
    if (expectedPricing
      && (finalState === 'native_complete' || finalState === 'ocr_complete')
      && failedReconstructionPages.has(pageNumber)) {
      codes.push('pricing_page_reconstruction_failed');
    }

    for (const code of codes) {
      const diagnostic = buildDiagnostic({ code,
        organizationId: params.organizationId, sourceDocumentId: params.sourceDocumentId,
        sourceArtifactId, physicalPageNumber: pageNumber, pageRepresentationDigest,
        evidenceRefs: [], extractionSnapshotId: params.extractionSnapshotId,
        occurredAt: params.occurredAt });
      if (diagnostic) output.push(diagnostic);
    }
  }
  return output;
}

function extractionSourceArtifactId(extraction: Record<string, unknown>): string | null {
  const extractionRoot = record(extraction.extraction);
  const provenance = record(extractionRoot?.physical_page_provenance_v1);
  const layers = record(extractionRoot?.content_layers_v1);
  const observations = record(record(layers?.pdf)?.layout_observations_v1);
  return typeof observations?.source_artifact_id === 'string'
    ? observations.source_artifact_id
    : typeof provenance?.source_artifact_id === 'string' ? provenance.source_artifact_id : null;
}

function trustedCurrentSourceArtifactId(extraction: Record<string, unknown>): string | null {
  const extractionRoot = record(extraction.extraction);
  const provenance = record(extractionRoot?.physical_page_provenance_v1);
  const layers = record(extractionRoot?.content_layers_v1);
  const observations = record(record(layers?.pdf)?.layout_observations_v1);
  const observationArtifact = typeof observations?.source_artifact_id === 'string'
    ? observations.source_artifact_id : null;
  const provenanceArtifact = typeof provenance?.source_artifact_id === 'string'
    ? provenance.source_artifact_id : null;
  if (observationArtifact && provenanceArtifact && observationArtifact !== provenanceArtifact) return null;
  return observationArtifact ?? provenanceArtifact;
}

function extractionPageRepresentationDigests(extraction: Record<string, unknown>): Map<number, string> {
  const extractionRoot = record(extraction.extraction);
  const layers = record(extractionRoot?.content_layers_v1);
  const observations = record(record(layers?.pdf)?.layout_observations_v1);
  const digests = new Map<number, string>();
  const untrustworthyPages = new Set<number>();
  for (const observation of records(observations?.observations)) {
    const page = Number(observation.physical_page_number);
    const metadata = record(observation.metadata);
    if (!Number.isInteger(page) || page < 1 || untrustworthyPages.has(page)) continue;
    const digest = metadata?.page_representation_digest;
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
      || (digests.has(page) && digests.get(page) !== digest)) {
      digests.delete(page);
      untrustworthyPages.add(page);
      continue;
    }
    digests.set(page, digest);
  }
  // A reconciled native+OCR page legitimately carries two observation digests.
  // It binds only through the extraction-owned effective representation for a
  // page where both extractors produced evidence; anything else stays unbound.
  const coverage = record(record(layers?.pdf)?.page_extraction_coverage_v1);
  if (coverage?.parser_version === 'page_extraction_coverage_v1') {
    for (const entry of records(coverage.pages)) {
      const page = Number(entry.page_number);
      const digest = entry.page_representation_digest;
      if (!untrustworthyPages.has(page) || typeof digest !== 'string'
        || !/^[a-f0-9]{64}$/.test(digest)
        || record(entry.native)?.state !== 'produced'
        || record(entry.ocr)?.state !== 'produced') continue;
      digests.set(page, digest);
    }
  }
  return digests;
}

function outcomeProposalFor(params: Readonly<{
  row: Record<string, unknown>;
  page: number;
  candidateIds: readonly string[];
  proposals: readonly RecoveryReviewCandidate[];
}>): RecoveryReviewCandidate | null {
  return params.proposals.find((proposal) =>
    proposal.sourceArtifactId === params.row.source_artifact_id
    && proposal.physicalPageNumber === params.page
    && proposal.pageRepresentationDigest === params.row.page_representation_digest
    && proposal.recoveryType === params.row.recovery_type
    && (() => {
      const outcomeIds = [...params.candidateIds].sort((left, right) =>
        left.localeCompare(right, 'en-US'));
      const proposalIds = proposal.selectableCandidates.map((candidate) => candidate.candidateId)
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      return outcomeIds.length === proposalIds.length
        && outcomeIds.every((candidateId, index) => candidateId === proposalIds[index]);
    })()) ?? null;
}

function proposalAuthorityDiagnostics(params: Readonly<{
  organizationId: string;
  sourceDocumentId: string;
  extractionSnapshotId: string | null;
  proposals: readonly RecoveryReviewCandidate[];
}>): DocumentDiagnostic[] {
  return params.proposals.flatMap((proposal) => {
    const codes: DiagnosticCode[] = [
      ...(proposal.reviewState === 'ambiguous_authority'
        ? ['ambiguous_recovery_authority' as const] : []),
      ...(proposal.sourceEvidenceBinding === 'unbound_identity_incomplete'
        ? ['recovery_source_evidence_unbound' as const] : []),
    ];
    if (!proposal.sourceArtifactId || !proposal.pageRepresentationDigest) return [];
    const refs: DiagnosticEvidenceRef[] = [
      { kind: 'recovery_proposal', proposalId: proposal.proposalId,
        proposalDigestSha256: proposal.proposalDigestSha256 },
      ...(proposal.latestReview
        ? [{ kind: 'recovery_review' as const, reviewId: proposal.latestReview.reviewId,
            reviewVersion: proposal.latestReview.reviewVersion }]
        : []),
    ];
    return codes.flatMap((code) => {
      const diagnostic = buildDiagnostic({ code, organizationId: params.organizationId,
        sourceDocumentId: params.sourceDocumentId, sourceArtifactId: proposal.sourceArtifactId,
        physicalPageNumber: proposal.physicalPageNumber,
        pageRepresentationDigest: proposal.pageRepresentationDigest,
        evidenceRefs: refs, extractionSnapshotId: params.extractionSnapshotId,
        occurredAt: proposal.latestReview?.createdAt ?? proposal.createdAt, proposal });
      return diagnostic ? [diagnostic] : [];
    });
  });
}

export async function readDocumentDiagnostics(
  query: Readonly<{ organizationId: string; sourceDocumentId: string }>,
  dependencies: Readonly<{
    admin?: DiagnosticReadClient | null;
    readRecoveryQueue?: typeof readRecoveryReviewQueue;
    resolveRecoveryConfirmations?: typeof resolveEffectiveRecoveryConfirmations;
  }> = {},
): Promise<DocumentDiagnosticsResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as DiagnosticReadClient | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const [documentRead, extractionRead, outcomeRead, jobRead, reviewRead] = await Promise.all([
    admin.from('documents').select('id, processing_error, updated_at').eq('organization_id', query.organizationId)
      .eq('id', query.sourceDocumentId),
    admin.from('document_extractions').select('id, data, created_at').eq('organization_id', query.organizationId)
      .eq('document_id', query.sourceDocumentId).is('field_key', null),
    admin.from(RECOVERY_GENERATION_OUTCOMES_TABLE)
      .select('diagnostic_id, source_artifact_id, extraction_snapshot_id, physical_page_number, page_representation_digest, recovery_type, outcome_code, sanitized_reason, provider_invoked, candidate_ids, observed_at')
      .eq('organization_id', query.organizationId).eq('source_document_id', query.sourceDocumentId),
    admin.from('document_analysis_jobs')
      .select('id, status, error_message, completed_at, created_at')
      .eq('organization_id', query.organizationId).eq('document_id', query.sourceDocumentId),
    (dependencies.readRecoveryQueue ?? readRecoveryReviewQueue)({ organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId }, { admin: admin as never }),
  ]);
  if (documentRead.error || extractionRead.error || outcomeRead.error || jobRead.error) {
    return { status: 'read_failed', reason: 'document_diagnostics_read_failed' };
  }
  if (reviewRead.status === 'not_configured') return { status: 'not_configured' };
  const document = records(documentRead.data)[0];
  if (!document) return { status: 'ok', diagnostics: [] };
  const extractionRows = records(extractionRead.data).sort((left, right) =>
    iso(right.created_at).localeCompare(iso(left.created_at))
    || String(right.id).localeCompare(String(left.id), 'en-US'));
  const latest = extractionRows[0];
  const latestData = latest ? record(latest.data) : null;
  const proposals = reviewRead.status === 'ok' ? reviewRead.candidates : [];
  const diagnostics = latest && latestData
    ? reconstructionDiagnostics({ organizationId: query.organizationId,
        sourceDocumentId: query.sourceDocumentId, extraction: latestData,
        extractionSnapshotId: String(latest.id), occurredAt: iso(latest.created_at),
        proposals }) : [];
  if (latest && latestData) {
    diagnostics.push(...extractionCoverageDiagnostics({ organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId, extraction: latestData,
      extractionSnapshotId: String(latest.id), occurredAt: iso(latest.created_at) }));
  }
  diagnostics.push(...proposalAuthorityDiagnostics({ organizationId: query.organizationId,
    sourceDocumentId: query.sourceDocumentId,
    extractionSnapshotId: latest ? String(latest.id) : null, proposals }));
  if (reviewRead.status === 'read_failed') {
    const item = buildDiagnostic({ code: 'recovery_read_failed',
      organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: null, physicalPageNumber: null, pageRepresentationDigest: null,
      evidenceRefs: [],
      extractionSnapshotId: latest ? String(latest.id) : null,
      occurredAt: iso(document.updated_at ?? latest?.created_at) });
    if (item) diagnostics.push(item);
  }
  const sourceArtifactId = latestData ? extractionSourceArtifactId(latestData) : null;
  if (reviewRead.status === 'ok' && sourceArtifactId) {
    const confirmationRead = await (dependencies.resolveRecoveryConfirmations
      ?? resolveEffectiveRecoveryConfirmations)({ organizationId: query.organizationId,
        sourceDocumentId: query.sourceDocumentId, sourceArtifactId },
      { admin: admin as never });
    if (confirmationRead.status === 'read_failed') {
      const item = buildDiagnostic({ code: 'recovery_read_failed',
        organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
        sourceArtifactId: null, physicalPageNumber: null, pageRepresentationDigest: null,
        evidenceRefs: [],
        extractionSnapshotId: latest ? String(latest.id) : null,
        occurredAt: iso(document.updated_at ?? latest?.created_at) });
      if (item) diagnostics.push(item);
    } else if (confirmationRead.status === 'ok') {
      for (const authority of confirmationRead.diagnostics) {
        if (authority.code === 'ambiguous_recovery_authority') continue;
        const proposal = proposals.find((entry) => entry.proposalId === authority.proposalId);
        if (!proposal?.sourceArtifactId || !proposal.pageRepresentationDigest) continue;
        const refs: DiagnosticEvidenceRef[] = [
          { kind: 'recovery_proposal', proposalId: authority.proposalId,
            proposalDigestSha256: authority.proposalDigestSha256 },
          ...(authority.reviewId && proposal.latestReview?.reviewId === authority.reviewId
            ? [{ kind: 'recovery_review' as const, reviewId: authority.reviewId,
                reviewVersion: proposal.latestReview.reviewVersion }] : []),
        ];
        const item = buildDiagnostic({ code: authority.code,
          organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
          sourceArtifactId: proposal.sourceArtifactId,
          physicalPageNumber: proposal.physicalPageNumber,
          pageRepresentationDigest: proposal.pageRepresentationDigest,
          evidenceRefs: refs, extractionSnapshotId: latest ? String(latest.id) : null,
          occurredAt: proposal.latestReview?.createdAt ?? proposal.createdAt, proposal });
        if (item) diagnostics.push(item);
      }
    }
  }
  const terminalJobs = records(jobRead.data).filter((row) =>
    (row.status === 'failed' || row.status === 'completed') && typeof row.id === 'string')
    .sort((left, right) => iso(right.completed_at ?? right.created_at)
      .localeCompare(iso(left.completed_at ?? left.created_at))
      || iso(right.created_at).localeCompare(iso(left.created_at))
      || (right.status === 'failed' ? 1 : 0) - (left.status === 'failed' ? 1 : 0)
      || String(right.id).localeCompare(String(left.id), 'en-US'));
  const latestTerminalJob = terminalJobs[0];
  const failedJobs = latestTerminalJob?.status === 'failed' ? [latestTerminalJob] : [];
  for (const job of failedJobs) {
    const item = buildDiagnostic({ code: 'document_processing_failed',
      organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: null, physicalPageNumber: null, pageRepresentationDigest: null,
      summary: typeof job.error_message === 'string' && job.error_message.trim()
        ? job.error_message : undefined,
      evidenceRefs: [{ kind: 'processing_job', jobId: String(job.id) }],
      extractionSnapshotId: null, processingRunId: String(job.id),
      occurredAt: iso(job.completed_at ?? job.created_at) });
    if (item) diagnostics.push(item);
  }
  if (terminalJobs.length === 0 && typeof document.processing_error === 'string'
    && document.processing_error.trim()) {
    const item = buildDiagnostic({ code: 'document_processing_failed',
      organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: null, physicalPageNumber: null, pageRepresentationDigest: null,
      summary: document.processing_error, evidenceRefs: [], extractionSnapshotId: null,
      occurredAt: iso(document.updated_at) });
    if (item) diagnostics.push(item);
  }
  const currentPageDigests = latestData ? extractionPageRepresentationDigests(latestData) : new Map();
  const currentOutcomeSourceArtifactId = latestData
    ? trustedCurrentSourceArtifactId(latestData) : null;
  // "Queued for a later run" is only true until a later run actually evaluates
  // the unit. Outcome rows are immutable, so a budget deferral is superseded at
  // read time by a later provider-invoked outcome for the same exact unit.
  const outcomeUnitKey = (row: Record<string, unknown>) => JSON.stringify([
    row.source_artifact_id, row.recovery_type, row.page_representation_digest,
    (Array.isArray(row.candidate_ids) ? row.candidate_ids : [])
      .filter((id): id is string => typeof id === 'string').sort(),
  ]);
  const latestProviderInvokedAt = new Map<string, string>();
  for (const row of records(outcomeRead.data)) {
    if (row.provider_invoked !== true) continue;
    const key = outcomeUnitKey(row);
    const observedAt = iso(row.observed_at);
    if ((latestProviderInvokedAt.get(key) ?? '') < observedAt) {
      latestProviderInvokedAt.set(key, observedAt);
    }
  }
  for (const row of records(outcomeRead.data)) {
    if (row.outcome_code === 'budget_exhausted'
      && (latestProviderInvokedAt.get(outcomeUnitKey(row)) ?? '') > iso(row.observed_at)) continue;
    const code = typeof row.outcome_code === 'string'
      ? RECOVERY_OUTCOME_DIAGNOSTIC_CODE[
          row.outcome_code as keyof typeof RECOVERY_OUTCOME_DIAGNOSTIC_CODE]
      : undefined;
    if (!code) continue;
    const candidateIds = Array.isArray(row.candidate_ids)
      ? row.candidate_ids.filter((id): id is string => typeof id === 'string') : [];
    const refs: DiagnosticEvidenceRef[] = candidateIds.map((candidateId) =>
      ({ kind: 'recovery_candidate', candidateId }));
    const page = Number(row.physical_page_number);
    if (currentOutcomeSourceArtifactId
      && row.source_artifact_id !== currentOutcomeSourceArtifactId) continue;
    const currentPageDigest = currentPageDigests.get(page);
    if (currentPageDigest && row.page_representation_digest !== currentPageDigest) continue;
    const supersedingProposal = outcomeProposalFor({ row, page, candidateIds, proposals });
    if (supersedingProposal
      && iso(supersedingProposal.createdAt) > iso(row.observed_at)) continue;
    const item = buildDiagnostic({ code, organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: typeof row.source_artifact_id === 'string' ? row.source_artifact_id : null,
      physicalPageNumber: Number.isInteger(page) && page > 0 ? page : null,
      pageRepresentationDigest: typeof row.page_representation_digest === 'string'
        ? row.page_representation_digest : null,
      recoveryType: DiagnosticRecoveryTypeSchema.safeParse(row.recovery_type).data ?? null,
      evidenceRefs: refs,
      extractionSnapshotId: typeof row.extraction_snapshot_id === 'string'
        ? row.extraction_snapshot_id : null,
      occurredAt: iso(row.observed_at) });
    if (item && item.diagnosticId === row.diagnostic_id) diagnostics.push(item);
  }
  const unique = [...new Map(diagnostics.map((entry) => [entry.diagnosticId, entry])).values()]
    .sort((left, right) => DIAGNOSTIC_SEVERITY_RANK[left.severity]
      - DIAGNOSTIC_SEVERITY_RANK[right.severity]
      || left.occurredAt.localeCompare(right.occurredAt)
      || left.diagnosticId.localeCompare(right.diagnosticId));
  return { status: 'ok', diagnostics: unique };
}
