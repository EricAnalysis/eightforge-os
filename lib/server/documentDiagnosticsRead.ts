import { DiagnosticCodeSchema, FailureDiagnosticSchema,
  type DiagnosticCode, type DiagnosticEvidenceRef, type FailureDiagnostic }
  from '@/lib/diagnostics/failureDiagnostic';
import { diagnosticId } from '@/lib/diagnostics/diagnosticIdentity';
import { getFailureRegistryEntry } from '@/lib/diagnostics/failureRegistry';
import type { DiagnosticVisualSourceEvidence, VisualSourceBox }
  from '@/lib/recovery/visualSourceEvidence';
import { readRecoveryReviewQueue, type RecoveryReviewCandidate }
  from '@/lib/server/forgewingRecoveryReviewRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const RECOVERY_GENERATION_OUTCOMES_TABLE = 'forgewing_recovery_generation_outcomes';
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
  | 'unbound' | 'blocked' | 'engineering_attention' | 'resolved';

export type DocumentDiagnostic = FailureDiagnostic & Readonly<{
  currentState: DiagnosticCurrentState;
  recoveryProposalId: string | null;
  visualEvidence: DiagnosticVisualSourceEvidence | null;
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

function boxes(refs: readonly DiagnosticSourceRef[]): VisualSourceBox[] {
  return refs.flatMap((ref, memberIndex) => ref.observation_id ? [{
    observationId: ref.observation_id,
    rawText: ref.text,
    role: 'diagnostic_evidence' as const,
    boundingBox: { xMin: ref.x_min, xMax: ref.x_max, yMin: ref.y_min, yMax: ref.y_max },
    sourceLayer: ref.source === 'ocr_fallback' ? 'ocr' as const : 'pdf_native_text' as const,
    memberIndex,
  }] : []);
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
  proposal?: RecoveryReviewCandidate | null;
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
    summary: input.summary?.trim() || registry.summary,
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
  const currentState: DiagnosticCurrentState = proposal?.sourceEvidenceBinding === 'unbound_identity_incomplete'
    ? 'unbound'
    : proposal?.reviewState === 'accepted_awaiting_reprocess'
      ? 'reprocess_required'
      : proposal?.reviewState === 'ambiguous_authority'
        ? 'blocked'
        : proposal?.reviewState === 'pending_review'
          ? 'human_review_required'
          : proposal?.reviewState === 'rejected' || proposal?.reviewState === 'deferred'
            ? 'blocked'
            : registry.recoverability === 'recoverable_after_human_review'
              ? proposal ? 'recovery_available' : 'human_review_required'
              : registry.recoverability === 'engineering_diagnostic'
                ? 'engineering_attention'
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
      boxes: [...input.visualBoxes],
    } : null;
  return { ...parsed.data, currentState, recoveryProposalId: proposal?.proposalId ?? null,
    visualEvidence };
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
      const diagnostic = buildDiagnostic({ code: parsedCode.data,
        organizationId: params.organizationId, sourceDocumentId: params.sourceDocumentId,
        sourceArtifactId, physicalPageNumber: page, pageRepresentationDigest: digest,
        summary: typeof raw.raw_text === 'string' ? raw.raw_text : undefined,
        evidenceRefs: refs, visualBoxes: boxes(sourceRefs),
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

export async function readDocumentDiagnostics(
  query: Readonly<{ organizationId: string; sourceDocumentId: string }>,
  dependencies: Readonly<{
    admin?: DiagnosticReadClient | null;
    readRecoveryQueue?: typeof readRecoveryReviewQueue;
  }> = {},
): Promise<DocumentDiagnosticsResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as DiagnosticReadClient | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const [documentRead, extractionRead, outcomeRead, reviewRead] = await Promise.all([
    admin.from('documents').select('id, processing_error, updated_at').eq('organization_id', query.organizationId)
      .eq('id', query.sourceDocumentId),
    admin.from('document_extractions').select('id, data, created_at').eq('organization_id', query.organizationId)
      .eq('document_id', query.sourceDocumentId).is('field_key', null),
    admin.from(RECOVERY_GENERATION_OUTCOMES_TABLE)
      .select('diagnostic_id, source_artifact_id, extraction_snapshot_id, physical_page_number, page_representation_digest, outcome_code, sanitized_reason, provider_invoked, candidate_ids, observed_at')
      .eq('organization_id', query.organizationId).eq('source_document_id', query.sourceDocumentId),
    (dependencies.readRecoveryQueue ?? readRecoveryReviewQueue)({ organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId }, { admin: admin as never }),
  ]);
  if (documentRead.error || extractionRead.error || outcomeRead.error || reviewRead.status === 'read_failed') {
    return { status: 'read_failed', reason: 'document_diagnostics_read_failed' };
  }
  if (reviewRead.status === 'not_configured') return { status: 'not_configured' };
  const document = records(documentRead.data)[0];
  if (!document) return { status: 'ok', diagnostics: [] };
  const extractionRows = records(extractionRead.data).sort((left, right) =>
    iso(right.created_at).localeCompare(iso(left.created_at)));
  const latest = extractionRows[0];
  const diagnostics = latest && record(latest.data)
    ? reconstructionDiagnostics({ organizationId: query.organizationId,
        sourceDocumentId: query.sourceDocumentId, extraction: record(latest.data)!,
        extractionSnapshotId: String(latest.id), occurredAt: iso(latest.created_at),
        proposals: reviewRead.candidates }) : [];
  if (typeof document.processing_error === 'string' && document.processing_error.trim()) {
    const item = buildDiagnostic({ code: 'document_processing_failed',
      organizationId: query.organizationId, sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: null, physicalPageNumber: null, pageRepresentationDigest: null,
      summary: document.processing_error, evidenceRefs: [], extractionSnapshotId: null,
      occurredAt: iso(document.updated_at) });
    if (item) diagnostics.push(item);
  }
  for (const row of records(outcomeRead.data)) {
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
    const item = buildDiagnostic({ code, organizationId: query.organizationId,
      sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId: typeof row.source_artifact_id === 'string' ? row.source_artifact_id : null,
      physicalPageNumber: Number.isInteger(page) && page > 0 ? page : null,
      pageRepresentationDigest: typeof row.page_representation_digest === 'string'
        ? row.page_representation_digest : null,
      summary: typeof row.sanitized_reason === 'string' ? row.sanitized_reason : undefined,
      evidenceRefs: refs,
      extractionSnapshotId: typeof row.extraction_snapshot_id === 'string'
        ? row.extraction_snapshot_id : null,
      occurredAt: iso(row.observed_at),
      proposal: null });
    if (item && item.diagnosticId === row.diagnostic_id) diagnostics.push(item);
  }
  const unique = [...new Map(diagnostics.map((entry) => [entry.diagnosticId, entry])).values()]
    .sort((left, right) => left.severity.localeCompare(right.severity)
      || left.occurredAt.localeCompare(right.occurredAt)
      || left.diagnosticId.localeCompare(right.diagnosticId));
  return { status: 'ok', diagnostics: unique };
}
