import {
  RECOVERY_PROPOSAL_TABLE,
  RECOVERY_REVIEW_TABLE,
  type RecoveryReadClient,
} from '@/lib/server/effectiveRecoveryConfirmations';
import { RecoveryCandidateV2Schema } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Read seam for the operator recovery review surface.
 *
 * Strictly read-only, and deliberately narrow: it returns what a reviewer needs
 * to decide -- the source page, why the row was withheld, the observations they
 * may choose between, and what Forgewing suggested -- and nothing else.
 *
 * Review state is derived from the rows, never stored. `reviewState` describes
 * where a proposal stands, and it is careful to distinguish "a human accepted
 * this" from "the recovery is in the data": only reprocessing can do the
 * second, so an accepted proposal reads as awaiting reprocess until an
 * extraction has actually consumed it.
 */

export type RecoveryReviewState =
  | 'pending_review'
  | 'accepted_awaiting_reprocess'
  | 'rejected'
  | 'deferred'
  /** Two approving reviews. Authority is ambiguous, so nothing is applied. */
  | 'ambiguous_authority';

export type RecoveryReviewCandidateObservation = Readonly<{
  observationId: string;
  rawText: string;
  sourceLayer: 'pdf_native_text' | 'ocr';
  boundingBox: Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  /** True for the observation Forgewing selected. */
  proposed: boolean;
}>;

export type RecoveryReviewCandidateSelection = Readonly<{
  candidateId: string;
  recoveryType: 'pricing_rate_multi_observation_cluster' | 'priced_schedule_continuation_attribution';
  targetRowIdentity: string;
  composedRawText: string;
  observations: readonly RecoveryReviewCandidateObservation[];
  /** Target-spine observations, kept separate from the fragment evidence. */
  targetContext: readonly RecoveryReviewCandidateObservation[];
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  pageRepresentationDigest: string;
  proposed: boolean;
}>;

/**
 * Whether the server could bind this proposal's candidates to source identity.
 *
 * Deliberately server-derived. There is no persisted current page
 * representation digest to compare against -- the only one that exists is the
 * proposal's own -- so a browser-side "is this still current?" check would be
 * comparing a value to itself. The honest question the server *can* answer is
 * whether the persisted candidates still close over their own identity, and
 * that is what this reports. A viewer showing `unbound` draws no highlight.
 */
export type RecoverySourceEvidenceBinding =
  /** Every persisted candidate validated and matched the proposal's source identity. */
  | 'bound'
  /**
   * At least one persisted candidate no longer closes over its source identity.
   *
   * Partial is treated as unbound on purpose. A dropped candidate silently
   * removes an alternate-target highlight, so a reviewer would be shown fewer
   * alternatives than the proposal actually offered -- an approximate picture
   * of the decision, which is the outcome this phase exists to refuse.
   */
  | 'unbound_identity_incomplete'
  /** A V1 proposal: single-observation evidence, no candidate closure to bind. */
  | 'not_applicable';

export type RecoveryReviewCandidate = Readonly<{
  proposalId: string;
  proposalDigestSha256: string;
  proposalVersion: 1 | 2;
  recoveryType: 'pricing_rate_single_observation'
    | 'pricing_rate_multi_observation_cluster'
    | 'priced_schedule_continuation_attribution';
  physicalPageNumber: number;
  sourceDocumentId: string;
  sourceArtifactId: string | null;
  pageRepresentationDigest: string | null;
  ocrPixelWidth?: number;
  ocrPixelHeight?: number;
  /** The deterministic reason the row was never emitted. */
  recoveryReason: string;
  proposedValue: string;
  reasonCategory: string;
  certainty: number;
  /** Only eligible monetary observations; a reviewer may select any of them. */
  selectableObservations: readonly RecoveryReviewCandidateObservation[];
  selectableCandidates: readonly RecoveryReviewCandidateSelection[];
  /** Server-derived: whether the visual layer may draw this proposal's evidence. */
  sourceEvidenceBinding: RecoverySourceEvidenceBinding;
  /** Every cited observation, including context tokens, for display. */
  evidence: readonly RecoveryReviewCandidateObservation[];
  reviewState: RecoveryReviewState;
  latestReview: Readonly<{
    reviewId: string;
    reviewVersion: number;
    disposition: string;
    confirmedObservationId: string | null;
    confirmedCandidateId: string | null;
    createdAt: string;
  }> | null;
  createdAt: string;
}>;

export type RecoveryReviewQueueResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; candidates: readonly RecoveryReviewCandidate[] }>;

type SelectResult = { data: unknown; error: { message?: string } | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function exactOcrPageGeometry(
  extractionData: unknown,
  scope: Readonly<{ sourceArtifactId: string; physicalPageNumber: number;
    pageRepresentationDigest: string }>,
): Readonly<{ width: number; height: number }> | null {
  const root = isRecord(extractionData) ? extractionData : null;
  const extraction = isRecord(root?.extraction) ? root.extraction : null;
  const layers = isRecord(extraction?.content_layers_v1) ? extraction.content_layers_v1 : null;
  const pdf = isRecord(layers?.pdf) ? layers.pdf : null;
  const observations = isRecord(pdf?.layout_observations_v1) ? pdf.layout_observations_v1 : null;
  if (observations?.source_artifact_id !== scope.sourceArtifactId) return null;
  const geometries = Array.isArray(observations.source_page_geometries)
    ? observations.source_page_geometries.filter(isRecord) : [];
  const matches = geometries.filter((entry) => entry.source_layer === 'ocr'
    && entry.physical_page_number === scope.physicalPageNumber
    && entry.page_representation_digest === scope.pageRepresentationDigest);
  if (matches.length !== 1) return null;
  const width = Number(matches[0]!.pixel_width);
  const height = Number(matches[0]!.pixel_height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : null;
}

function observations(
  evidence: unknown,
  selectedObservationId: string,
  eligibleOnly: boolean,
): RecoveryReviewCandidateObservation[] {
  return (Array.isArray(evidence) ? evidence : [])
    .filter(isRecord)
    .flatMap((entry) => {
      const observationId = entry.observationId;
      const rawText = entry.rawText;
      const box = entry.boundingBox;
      const eligible = entry.eligible === true;
      if (typeof observationId !== 'string' || typeof rawText !== 'string' || !isRecord(box)) return [];
      if (eligibleOnly && !eligible) return [];
      return [{
        observationId,
        rawText,
        sourceLayer: entry.sourceLayer === 'ocr' ? 'ocr' as const : 'pdf_native_text' as const,
        boundingBox: {
          xMin: Number(box.xMin), xMax: Number(box.xMax),
          yMin: Number(box.yMin), yMax: Number(box.yMax),
        },
        proposed: observationId === selectedObservationId,
      }];
    })
    .sort((left, right) => left.observationId.localeCompare(right.observationId, 'en-US'));
}

function orderedObservations(
  evidence: unknown,
  orderedObservationIds: unknown,
): RecoveryReviewCandidateObservation[] | null {
  if (!Array.isArray(orderedObservationIds) || orderedObservationIds.length === 0) return null;
  const byId = new Map<string, RecoveryReviewCandidateObservation>();
  for (const entry of observations(evidence, '', false)) byId.set(entry.observationId, entry);
  const ordered = orderedObservationIds.flatMap((id) =>
    typeof id === 'string' && byId.has(id) ? [byId.get(id)!] : []);
  return ordered.length === orderedObservationIds.length ? ordered : null;
}

/**
 * Projects a candidate's members in the candidate's own authored order.
 *
 * `orderedObservationIds` is load-bearing, not incidental: it is what the
 * candidate id is a digest over, and it is the order the composed text was
 * built in. Re-sorting here -- alphabetically or otherwise -- would show a
 * reviewer "8.75 $" for a candidate whose authored text is "$ 8.75", so the
 * ordered ids drive the projection and the evidence array is only a lookup.
 *
 * A candidate whose ordered ids do not fully resolve against its own evidence
 * is dropped rather than rendered short. A reviewer confirms a candidate whole;
 * being shown part of one is being shown a different candidate.
 */
function candidateSelections(
  value: unknown,
  selectedCandidateId: string,
  scope: Readonly<{
    sourceDocumentId: string;
    sourceArtifactId: string;
    physicalPageNumber: number;
    pageRepresentationDigest: string;
  }>,
): RecoveryReviewCandidateSelection[] {
  return (Array.isArray(value) ? value : []).flatMap((rawCandidate) => {
    const parsed = RecoveryCandidateV2Schema.safeParse(rawCandidate);
    if (!parsed.success) return [];
    const candidate = parsed.data;
    const orderedObservationIds = candidate.orderedObservationIds;
    if (candidate.sourceDocumentId !== scope.sourceDocumentId
      || candidate.sourceArtifactId !== scope.sourceArtifactId
      || candidate.physicalPageNumber !== scope.physicalPageNumber
      || candidate.pageRepresentationDigest !== scope.pageRepresentationDigest) return [];

    const members = orderedObservations(candidate.evidence, orderedObservationIds);
    if (!members) return [];

    let targetContext: RecoveryReviewCandidateObservation[] = [];
    if (candidate.targetContextEvidence !== undefined) {
      const projected = orderedObservations(
        candidate.targetContextEvidence.evidence,
        candidate.targetContextEvidence.orderedObservationIds,
      );
      if (!projected) return [];
      targetContext = projected;
    }

    return [{
      candidateId: candidate.candidateId,
      recoveryType: candidate.recoveryType as RecoveryReviewCandidateSelection['recoveryType'],
      targetRowIdentity: candidate.targetRowIdentity,
      composedRawText: candidate.composedRawText,
      observations: members,
      targetContext,
      sourceDocumentId: candidate.sourceDocumentId,
      sourceArtifactId: candidate.sourceArtifactId,
      physicalPageNumber: candidate.physicalPageNumber,
      pageRepresentationDigest: candidate.pageRepresentationDigest,
      proposed: candidate.candidateId === selectedCandidateId,
    }];
  }).sort((left, right) => left.candidateId.localeCompare(right.candidateId, 'en-US'));
}

export async function readRecoveryReviewQueue(
  query: Readonly<{ organizationId: string; sourceDocumentId: string }>,
  dependencies: Readonly<{ admin?: RecoveryReadClient | null }> = {},
): Promise<RecoveryReviewQueueResult> {
  const admin = dependencies.admin === undefined
    ? (getSupabaseAdmin() as unknown as RecoveryReadClient | null)
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const proposalRead: SelectResult = await admin
    .from(RECOVERY_PROPOSAL_TABLE)
    .select('id, proposal_id, proposal_digest_sha256, proposal_version, recovery_type, source_artifact_id, extraction_snapshot_id, physical_page_number, page_representation_digest, recovery_reason, selected_observation_id, selected_candidate_id, proposed_value, reason_category, certainty, evidence, recovery_candidates, created_at')
    .eq('organization_id', query.organizationId)
    .eq('source_document_id', query.sourceDocumentId);
  if (proposalRead.error) {
    return { status: 'read_failed', reason: proposalRead.error.message ?? 'proposal_read_failed' };
  }
  const proposals = (Array.isArray(proposalRead.data) ? proposalRead.data : []).filter(isRecord);
  if (proposals.length === 0) return { status: 'ok', candidates: [] };

  const extractionIds = [...new Set(proposals.flatMap((row) =>
    typeof row.extraction_snapshot_id === 'string' ? [row.extraction_snapshot_id] : []))];
  const extractionById = new Map<string, unknown>();
  if (extractionIds.length > 0) {
    const extractionRead: SelectResult = await admin.from('document_extractions')
      .select('id, data')
      .eq('organization_id', query.organizationId)
      .eq('document_id', query.sourceDocumentId)
      .in('id', extractionIds);
    if (!extractionRead.error) {
      for (const extractionRow of (Array.isArray(extractionRead.data)
        ? extractionRead.data : []).filter(isRecord)) {
        if (typeof extractionRow.id === 'string') extractionById.set(extractionRow.id, extractionRow.data);
      }
    }
  }

  const reviewRead: SelectResult = await admin
    .from(RECOVERY_REVIEW_TABLE)
    .select('id, proposal_row_id, review_version, disposition, confirmed_observation_id, confirmed_candidate_id, created_at')
    .eq('organization_id', query.organizationId)
    .in('proposal_row_id', proposals.map((row) => row.id));
  if (reviewRead.error) {
    return { status: 'read_failed', reason: reviewRead.error.message ?? 'review_read_failed' };
  }
  const reviewsByProposal = new Map<string, Record<string, unknown>[]>();
  for (const row of (Array.isArray(reviewRead.data) ? reviewRead.data : []).filter(isRecord)) {
    const key = row.proposal_row_id;
    if (typeof key !== 'string') continue;
    reviewsByProposal.set(key, [...(reviewsByProposal.get(key) ?? []), row]);
  }

  const candidates = proposals.flatMap((row): RecoveryReviewCandidate[] => {
    const proposalId = row.proposal_id;
    const digest = row.proposal_digest_sha256;
    const selectedObservationId = row.selected_observation_id;
    const selectedCandidateId = row.selected_candidate_id;
    const proposalVersion = row.proposal_version === 2 ? 2 as const : 1 as const;
    if (typeof row.id !== 'string' || typeof proposalId !== 'string'
      || typeof digest !== 'string'
      || (proposalVersion === 1 && typeof selectedObservationId !== 'string')
      || (proposalVersion === 2 && typeof selectedCandidateId !== 'string')) return [];

    const reviews = [...(reviewsByProposal.get(row.id) ?? [])]
      .sort((left, right) => Number(left.review_version) - Number(right.review_version));
    const approving = reviews.filter((entry) =>
      entry.disposition === 'accepted' || entry.disposition === 'modified');
    // Newest is shown for navigation; it is never what grants authority. The
    // confirmation resolver reads the rows itself and refuses ambiguity.
    const latest = reviews.at(-1) ?? null;
    const reviewState: RecoveryReviewState = approving.length > 1
      ? 'ambiguous_authority'
      : approving.length === 1
        ? 'accepted_awaiting_reprocess'
        : latest?.disposition === 'rejected'
          ? 'rejected'
          : latest?.disposition === 'deferred'
            ? 'deferred'
            : 'pending_review';

    // Resolved once. Two continuation candidates for the same withheld line
    // cite that line's own tokens, so the union is deduplicated by observation
    // identity: evidence is what the reviewer is shown, and showing one token
    // twice misrepresents how much source backs the decision.
    const sourceArtifactId = typeof row.source_artifact_id === 'string'
      ? row.source_artifact_id : null;
    const physicalPageNumber = Number(row.physical_page_number);
    const pageRepresentationDigest = typeof row.page_representation_digest === 'string'
      ? row.page_representation_digest : null;
    const extractionSnapshotId = typeof row.extraction_snapshot_id === 'string'
      ? row.extraction_snapshot_id : null;
    const ocrGeometry = sourceArtifactId && Number.isInteger(physicalPageNumber)
      && physicalPageNumber > 0 && pageRepresentationDigest && extractionSnapshotId
      ? exactOcrPageGeometry(extractionById.get(extractionSnapshotId), {
          sourceArtifactId, physicalPageNumber, pageRepresentationDigest,
        }) : null;
    const selectableCandidates = proposalVersion === 2
      && sourceArtifactId && Number.isInteger(physicalPageNumber) && physicalPageNumber > 0
      && pageRepresentationDigest
      ? candidateSelections(row.recovery_candidates, selectedCandidateId as string, {
          sourceDocumentId: query.sourceDocumentId,
          sourceArtifactId,
          physicalPageNumber,
          pageRepresentationDigest,
        })
      : [];
    const candidateEvidence = [...new Map(selectableCandidates
      .flatMap((candidate) => candidate.observations)
      .map((entry) => [entry.observationId, entry])).values()];
    // Compared against what was actually persisted, not against a self-derived
    // value: every persisted candidate must survive schema closure and the
    // source-identity scope check, or the visual layer draws nothing.
    const persistedCandidateCount = Array.isArray(row.recovery_candidates)
      ? row.recovery_candidates.length : 0;
    const sourceEvidenceBinding: RecoverySourceEvidenceBinding = proposalVersion !== 2
      ? 'not_applicable'
      : persistedCandidateCount > 0 && selectableCandidates.length === persistedCandidateCount
        ? 'bound'
        : 'unbound_identity_incomplete';

    return [{
      proposalId,
      proposalDigestSha256: digest,
      proposalVersion,
      recoveryType: proposalVersion === 2
        && (row.recovery_type === 'pricing_rate_multi_observation_cluster'
          || row.recovery_type === 'priced_schedule_continuation_attribution')
        ? row.recovery_type
        : 'pricing_rate_single_observation',
      physicalPageNumber,
      sourceDocumentId: query.sourceDocumentId,
      sourceArtifactId,
      pageRepresentationDigest,
      ...(ocrGeometry ? {
        ocrPixelWidth: ocrGeometry.width,
        ocrPixelHeight: ocrGeometry.height,
      } : {}),
      recoveryReason: typeof row.recovery_reason === 'string' ? row.recovery_reason : 'unknown',
      proposedValue: typeof row.proposed_value === 'string' ? row.proposed_value : '',
      reasonCategory: typeof row.reason_category === 'string' ? row.reason_category : 'unknown',
      certainty: Number(row.certainty),
      selectableObservations: proposalVersion === 1
        ? observations(row.evidence, selectedObservationId as string, true) : [],
      selectableCandidates,
      sourceEvidenceBinding,
      evidence: proposalVersion === 1
        ? observations(row.evidence, selectedObservationId as string, false)
        : candidateEvidence,
      reviewState,
      latestReview: latest && typeof latest.id === 'string' ? {
        reviewId: latest.id,
        reviewVersion: Number(latest.review_version),
        disposition: String(latest.disposition),
        confirmedObservationId: typeof latest.confirmed_observation_id === 'string'
          ? latest.confirmed_observation_id
          : null,
        confirmedCandidateId: typeof latest.confirmed_candidate_id === 'string'
          ? latest.confirmed_candidate_id
          : null,
        createdAt: String(latest.created_at),
      } : null,
      createdAt: String(row.created_at),
    }];
  });

  candidates.sort((left, right) =>
    left.physicalPageNumber - right.physicalPageNumber
    || left.proposalId.localeCompare(right.proposalId, 'en-US'));
  return { status: 'ok', candidates };
}
