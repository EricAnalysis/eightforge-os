import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { ForgewingLabelLinkageReviewPacket } from
  '@/lib/evaluation/forgewing/labelledPricingLinkageReview';

export const A3_LINKAGE_WORKSPACE_STATE_VERSION =
  'forgewing-a3-linkage-workspace-state-v1' as const;
export const A3_LINKAGE_WORKSPACE_STORAGE_KEY = 'eightforge:a3-linkage-review:v1' as const;

export type A3WorkspaceDecision = '' | 'linked' | 'not_linkable' | 'needs_follow_up';

export type A3WorkspaceReviewRecord = Readonly<{
  labelObservationId: string;
  candidateRowId: string;
  decision: A3WorkspaceDecision;
  selectedObservationIds: readonly string[];
  notes: string;
}>;

export type A3WorkspaceFreezeIdentity = Readonly<{
  sourceSha256: string;
  extractionSnapshotId: string;
  candidateSetDigest: string;
  layoutObservationDigest: string;
  labelPackageDigest: string;
  reviewPacketDigest: string;
}>;

export type A3WorkspaceDraft = Readonly<{
  stateVersion: typeof A3_LINKAGE_WORKSPACE_STATE_VERSION;
  freezeIdentity: A3WorkspaceFreezeIdentity;
  activeLabelObservationId: string;
  records: readonly A3WorkspaceReviewRecord[];
}>;

export type A3WorkspaceProgress = Readonly<{
  total: number;
  reviewed: number;
  linked: number;
  notLinkable: number;
  needsFollowUp: number;
  unreviewed: number;
}>;

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function buildA3WorkspaceFreezeIdentity(
  packet: ForgewingLabelLinkageReviewPacket,
): A3WorkspaceFreezeIdentity {
  const layoutObservations = packet.labels.flatMap((label) =>
    label.modern_pdf_layout_token_observations.map((observation) => ({
      observation_id: observation.observation_id,
      candidate_row_id: observation.candidate_row_id,
      source_document_id: observation.source_document_id,
      source_artifact_id: observation.source_artifact_id,
      extraction_snapshot_id: observation.extraction_snapshot_id,
      physical_page: observation.physical_page,
      raw_text: observation.raw_text,
      bbox: observation.bbox,
    })))
    .sort((left, right) => left.observation_id.localeCompare(right.observation_id, 'en-US'));
  return {
    sourceSha256: packet.source.source_pdf_sha256,
    extractionSnapshotId: packet.source.extraction_snapshot_id,
    candidateSetDigest: hashCanonical(packet.review_scope.candidate_row_ids),
    layoutObservationDigest: hashCanonical(layoutObservations),
    labelPackageDigest: packet.label_package.ledger_sha256,
    reviewPacketDigest: packet.packet_digest_sha256,
  };
}

export function createBlankA3WorkspaceDraft(
  packet: ForgewingLabelLinkageReviewPacket,
): A3WorkspaceDraft {
  return {
    stateVersion: A3_LINKAGE_WORKSPACE_STATE_VERSION,
    freezeIdentity: buildA3WorkspaceFreezeIdentity(packet),
    activeLabelObservationId: packet.labels[0]?.label_observation_id ?? '',
    records: packet.labels.map((label) => ({
      labelObservationId: label.label_observation_id,
      candidateRowId: label.candidate_row_id,
      decision: '',
      selectedObservationIds: [],
      notes: '',
    })),
  };
}

export function a3WorkspaceFreezeIdentityMatches(
  expected: A3WorkspaceFreezeIdentity,
  supplied: A3WorkspaceFreezeIdentity,
): boolean {
  return Object.keys(expected).every((key) =>
    expected[key as keyof A3WorkspaceFreezeIdentity]
      === supplied[key as keyof A3WorkspaceFreezeIdentity]);
}

function validRecord(value: unknown): value is A3WorkspaceReviewRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.labelObservationId === 'string'
    && typeof record.candidateRowId === 'string'
    && (record.decision === '' || record.decision === 'linked'
      || record.decision === 'not_linkable' || record.decision === 'needs_follow_up')
    && Array.isArray(record.selectedObservationIds)
    && record.selectedObservationIds.every((id) => typeof id === 'string')
    && typeof record.notes === 'string';
}

export function restoreA3WorkspaceDraft(params: {
  saved: unknown;
  packet: ForgewingLabelLinkageReviewPacket;
}): Readonly<{ status: 'restored' | 'invalid'; draft: A3WorkspaceDraft }> {
  const blank = createBlankA3WorkspaceDraft(params.packet);
  if (!params.saved || typeof params.saved !== 'object') return { status: 'invalid', draft: blank };
  const saved = params.saved as Partial<A3WorkspaceDraft>;
  if (saved.stateVersion !== A3_LINKAGE_WORKSPACE_STATE_VERSION
    || !saved.freezeIdentity
    || !a3WorkspaceFreezeIdentityMatches(blank.freezeIdentity, saved.freezeIdentity)
    || !Array.isArray(saved.records)
    || saved.records.length !== blank.records.length
    || !saved.records.every(validRecord)) {
    return { status: 'invalid', draft: blank };
  }
  const labels = new Map(params.packet.labels.map((label) => [label.label_observation_id, label]));
  const suppliedIds = new Set(saved.records.map((record) => record.labelObservationId));
  if (suppliedIds.size !== labels.size || [...suppliedIds].some((id) => !labels.has(id))) {
    return { status: 'invalid', draft: blank };
  }
  for (const record of saved.records) {
    const label = labels.get(record.labelObservationId)!;
    const available = new Set(label.modern_pdf_layout_token_observations
      .map((observation) => observation.observation_id));
    if (record.candidateRowId !== label.candidate_row_id
      || record.selectedObservationIds.some((id) => !available.has(id))) {
      return { status: 'invalid', draft: blank };
    }
  }
  const active = labels.has(saved.activeLabelObservationId ?? '')
    ? saved.activeLabelObservationId! : blank.activeLabelObservationId;
  return {
    status: 'restored',
    draft: {
      ...blank,
      activeLabelObservationId: active,
      records: saved.records.map((record) => ({
        ...record,
        selectedObservationIds: sortedUnique(record.selectedObservationIds),
      })),
    },
  };
}

function updateRecord(
  draft: A3WorkspaceDraft,
  labelObservationId: string,
  update: (record: A3WorkspaceReviewRecord) => A3WorkspaceReviewRecord,
): A3WorkspaceDraft {
  return {
    ...draft,
    records: draft.records.map((record) =>
      record.labelObservationId === labelObservationId ? update(record) : record),
  };
}

export function toggleA3WorkspaceObservation(params: {
  draft: A3WorkspaceDraft;
  labelObservationId: string;
  observationId: string;
}): A3WorkspaceDraft {
  return updateRecord(params.draft, params.labelObservationId, (record) => {
    const selected = new Set(record.selectedObservationIds);
    if (selected.has(params.observationId)) selected.delete(params.observationId);
    else selected.add(params.observationId);
    return { ...record, selectedObservationIds: sortedUnique([...selected]) };
  });
}

export function setA3WorkspaceNotes(
  draft: A3WorkspaceDraft,
  labelObservationId: string,
  notes: string,
): A3WorkspaceDraft {
  return updateRecord(draft, labelObservationId, (record) => ({ ...record, notes }));
}

export function selectA3WorkspaceLabel(
  draft: A3WorkspaceDraft,
  packet: ForgewingLabelLinkageReviewPacket,
  labelObservationId: string,
): A3WorkspaceDraft {
  return packet.labels.some((label) => label.label_observation_id === labelObservationId)
    ? { ...draft, activeLabelObservationId: labelObservationId } : draft;
}

export function moveA3WorkspaceLabel(
  draft: A3WorkspaceDraft,
  packet: ForgewingLabelLinkageReviewPacket,
  offset: number,
): A3WorkspaceDraft {
  const current = Math.max(0, packet.labels.findIndex((label) =>
    label.label_observation_id === draft.activeLabelObservationId));
  const next = Math.min(Math.max(0, current + offset), packet.labels.length - 1);
  const target = packet.labels[next];
  return target ? { ...draft, activeLabelObservationId: target.label_observation_id } : draft;
}

export function setA3WorkspaceDecision(params: {
  draft: A3WorkspaceDraft;
  labelObservationId: string;
  decision: Exclude<A3WorkspaceDecision, ''>;
  clearSelectedEvidence?: boolean;
}): Readonly<{ draft: A3WorkspaceDraft; error: string | null; confirmationRequired: boolean }> {
  const record = params.draft.records.find((item) =>
    item.labelObservationId === params.labelObservationId);
  if (!record) {
    return { draft: params.draft, error: 'The requested label is not in this review session.', confirmationRequired: false };
  }
  if (params.decision === 'linked' && record.selectedObservationIds.length === 0) {
    return {
      draft: params.draft,
      error: 'Select at least one source observation supporting this label.',
      confirmationRequired: false,
    };
  }
  if (params.decision === 'not_linkable' && record.selectedObservationIds.length > 0
    && !params.clearSelectedEvidence) {
    return {
      draft: params.draft,
      error: 'Clear selected evidence before marking this label Not Linkable.',
      confirmationRequired: true,
    };
  }
  return {
    draft: updateRecord(params.draft, params.labelObservationId, (item) => ({
      ...item,
      decision: params.decision,
      selectedObservationIds: params.decision === 'not_linkable'
        ? [] : item.selectedObservationIds,
    })),
    error: null,
    confirmationRequired: false,
  };
}

export function a3WorkspaceProgress(draft: A3WorkspaceDraft): A3WorkspaceProgress {
  const linked = draft.records.filter((record) => record.decision === 'linked').length;
  const notLinkable = draft.records.filter((record) => record.decision === 'not_linkable').length;
  const needsFollowUp = draft.records.filter((record) => record.decision === 'needs_follow_up').length;
  const reviewed = linked + notLinkable + needsFollowUp;
  return {
    total: draft.records.length,
    reviewed,
    linked,
    notLinkable,
    needsFollowUp,
    unreviewed: draft.records.length - reviewed,
  };
}

export function a3WorkspaceDomainReviewInput(draft: A3WorkspaceDraft) {
  return {
    review_input_version: 'forgewing-label-linkage-review-input-v1',
    authority: 'evaluation_ground_truth_only',
    review_packet_digest_sha256: draft.freezeIdentity.reviewPacketDigest,
    records: draft.records.map((record) => ({
      label_observation_id: record.labelObservationId,
      candidate_row_id: record.candidateRowId,
      reviewer_decision: record.decision,
      selected_observation_ids: record.decision === 'linked'
        ? sortedUnique(record.selectedObservationIds) : [],
      notes: record.notes,
    })),
  };
}
