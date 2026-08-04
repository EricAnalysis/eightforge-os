import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  Step3InterpretationBridge,
  Step3InterpretationBridgePayload,
} from '@/lib/extraction/domain/step3InterpretationBridge';
import type {
  GridCellArtifact,
  TableChainArtifact,
  TableContinuationLink,
  TableSegmentArtifact,
} from '@/lib/extraction/domain/types';
import type { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';
import {
  SEMANTIC_COLUMN_INTERPRETER_MANIFEST,
  SEMANTIC_COLUMN_RULES,
  createSemanticColumnMapping,
} from '@/lib/interpretation/semanticColumnMapping';

function handlesByFragment(handles: readonly VerifiedFieldHandle[]) {
  const result = new Map<string, VerifiedFieldHandle[]>();
  for (const handle of handles) {
    for (const fragmentId of handle.field.source_fragment_ids) {
      result.set(fragmentId, [...(result.get(fragmentId) ?? []), handle]);
    }
  }
  return result;
}

function uniqueHandles(handles: readonly VerifiedFieldHandle[]): VerifiedFieldHandle[] {
  const seen = new Set<string>();
  return handles.filter((handle) => {
    if (seen.has(handle.field.id)) return false;
    seen.add(handle.field.id);
    return true;
  });
}

type GeometryPeer = {
  readonly segment: TableSegmentArtifact;
  readonly column: TableSegmentArtifact['column_hypotheses'][number];
  readonly center_distance: number;
};

type PeerHeaderScopeClassification =
  | 'target_segment'
  | 'same_table_chain'
  | 'explicit_linked_continuation'
  | 'outside_chain_and_linked_continuation_scope';

function columnReferenceId(
  segment: TableSegmentArtifact,
  column: TableSegmentArtifact['column_hypotheses'][number],
): string {
  return hashCanonical({
    table_segment_id: segment.id,
    column_index: column.index,
    x0: column.x0,
    x1: column.x1,
  });
}

function stableGeometryPeerForSegment(
  targetColumn: TableSegmentArtifact['column_hypotheses'][number],
  segment: TableSegmentArtifact,
): GeometryPeer | null {
  const tolerance =
    SEMANTIC_COLUMN_RULES['observed-column-evidence-v2']
      .crossPageColumnCenterTolerance;
  const center = (targetColumn.x0 + targetColumn.x1) / 2;
  const peer = segment.column_hypotheses
    .map((column) => ({
      column,
      center_distance: Math.abs(
        center - ((column.x0 + column.x1) / 2),
      ),
    }))
    .filter(({ center_distance }) => center_distance <= tolerance)
    .sort((left, right) =>
      left.center_distance - right.center_distance
      || left.column.x0 - right.column.x0
      || left.column.index - right.column.index)[0];
  return peer ? { segment, ...peer } : null;
}

export function stableColumnGeometryPeers(
  targetColumn: TableSegmentArtifact['column_hypotheses'][number],
  segments: readonly TableSegmentArtifact[],
): GeometryPeer[] {
  return segments
    .flatMap((segment) => {
      const peer = stableGeometryPeerForSegment(targetColumn, segment);
      return peer ? [peer] : [];
    })
    .sort((left, right) =>
    left.segment.page - right.segment.page
    || left.segment.bounding_box.y0 - right.segment.bounding_box.y0
    || left.segment.bounding_box.x0 - right.segment.bounding_box.x0
    || left.segment.reading_order - right.segment.reading_order
    || left.center_distance - right.center_distance);
}

function directContinuationLink(
  targetSegmentId: string,
  peerSegmentId: string,
  links: readonly TableContinuationLink[],
): TableContinuationLink | null {
  return links.find((link) =>
    (link.from_segment_id === targetSegmentId
      && link.to_segment_id === peerSegmentId)
    || (link.from_segment_id === peerSegmentId
      && link.to_segment_id === targetSegmentId)) ?? null;
}

function scopeClassification(input: {
  readonly targetSegment: TableSegmentArtifact;
  readonly targetChain: TableChainArtifact;
  readonly peerSegment: TableSegmentArtifact;
  readonly peerChainId: string | null;
  readonly continuationLink: TableContinuationLink | null;
}): PeerHeaderScopeClassification {
  if (input.peerSegment.id === input.targetSegment.id) return 'target_segment';
  if (input.peerChainId === input.targetChain.id) return 'same_table_chain';
  if (input.continuationLink?.decision === 'linked') {
    return 'explicit_linked_continuation';
  }
  return 'outside_chain_and_linked_continuation_scope';
}

function fieldSourceCell(
  handle: VerifiedFieldHandle,
  cells: readonly GridCellArtifact[],
): GridCellArtifact | null {
  return cells.find((cell) =>
    handle.field.source_fragment_ids.includes(cell.id)) ?? null;
}

function selectedOrLeadingRole(
  mapping: ReturnType<typeof createSemanticColumnMapping>,
) {
  return mapping.assessment.selected_role
    ?? mapping.assessment.candidate_roles[0]?.role
    ?? null;
}

function roleScore(
  mapping: ReturnType<typeof createSemanticColumnMapping>,
  role: string | null,
): number {
  return mapping.assessment.candidate_roles.find(
    (candidate) => candidate.role === role,
  )?.score ?? 0;
}

export const buildStep3SemanticInterpretation: Step3InterpretationBridge =
  async (input): Promise<Step3InterpretationBridgePayload> => {
    const byFragment = handlesByFragment(input.verified_field_handles);
    const chainIdBySegment = new Map<string, string>();
    for (const chain of input.chains) {
      for (const segmentId of chain.segment_ids) {
        const prior = chainIdBySegment.get(segmentId);
        if (prior != null && prior !== chain.id) {
          throw new Error('A table segment cannot belong to multiple table chains.');
        }
        chainIdBySegment.set(segmentId, chain.id);
      }
    }
    const interpretationManifestHash = hashCanonical({
      semantic_column_mapping: SEMANTIC_COLUMN_INTERPRETER_MANIFEST,
    });
    const interpretationSnapshotId = opaqueIds.interpretationSnapshot({
      extraction_snapshot_id: input.extraction_snapshot_id,
      interpreter_manifest_hash: interpretationManifestHash,
      entity_resolver_version: 'not-applicable-step3',
    });
    let mappings: {
      readonly mapping: ReturnType<typeof createSemanticColumnMapping>;
      readonly table_segment_id: string;
      readonly peer_header_evidence: readonly Readonly<Record<string, unknown>>[];
      readonly target_own_header_evidence:
        readonly Readonly<Record<string, unknown>>[];
      readonly peer_header_scope_rejections:
        readonly Readonly<Record<string, unknown>>[];
    }[];
    try {
      mappings = input.chains.flatMap((chain) =>
        chain.segment_ids.flatMap((segmentId) => {
          const segment = input.segments.find((candidate) => candidate.id === segmentId);
          if (!segment) {
            throw new Error('Table chain references a missing target segment.');
          }
          const chainSegments = chain.segment_ids.map((peerSegmentId) => {
            const peerSegment = input.segments.find(
              (candidate) => candidate.id === peerSegmentId,
            );
            if (!peerSegment) {
              throw new Error('Table chain references a missing peer segment.');
            }
            if (chainIdBySegment.get(peerSegment.id) !== chain.id) {
              throw new Error('Peer segment must belong to the target table chain.');
            }
            return peerSegment;
          });
          return segment.column_hypotheses.flatMap((column) => {
            const geometryPeers = stableColumnGeometryPeers(
              column,
              chainSegments,
            );
            const rejectedGeometryPeers = input.segments
              .filter((candidate) =>
                chainIdBySegment.get(candidate.id) !== chain.id)
              .flatMap((candidate) => {
                const peer = stableGeometryPeerForSegment(column, candidate);
                return peer ? [peer] : [];
              });
            const peerHeaders = geometryPeers.flatMap((peer) => {
              const peerChainId = chainIdBySegment.get(peer.segment.id) ?? null;
              const continuationLink = directContinuationLink(
                segment.id,
                peer.segment.id,
                input.continuation_links ?? [],
              );
              const scope = scopeClassification({
                targetSegment: segment,
                targetChain: chain,
                peerSegment: peer.segment,
                peerChainId,
                continuationLink,
              });
              return peer.column.header.fragment_ids.flatMap((fragmentId) =>
                (byFragment.get(fragmentId) ?? []).map((handle) => ({
                  ...peer,
                  handle,
                  peer_chain_id: peerChainId,
                  continuation_link: continuationLink,
                  scope_classification: scope,
                })));
            });
            const peerHeaderFields = peerHeaders.map(({ handle }) => handle);
            const headerFields = uniqueHandles(peerHeaderFields);
            const cellFields = uniqueHandles(
              column.value_kind_hypotheses.flatMap((hypothesis) =>
                hypothesis.measurement.basis_artifact_ids.flatMap(
                  (id) => byFragment.get(id) ?? [],
                )),
            );
            const firstCell = cellFields[0];
            if (!firstCell) return [];
            const evidenceFieldIds = new Set(
              [...headerFields, ...cellFields].flatMap(
                (handle) => handle.field.source_fragment_ids,
              ),
            );
            const sourceCells = input.cells.filter((cell) =>
              evidenceFieldIds.has(cell.id));
            const mappingInput = {
              interpretationSnapshotId,
              chain,
              segment,
              columnIndex: column.index,
              evidence: {
                headerFields,
                cellFields: [firstCell, ...cellFields.slice(1)],
                sourceCells,
              },
              ruleId: 'observed-column-evidence-v2',
            } as const;
            const mapping = createSemanticColumnMapping(mappingInput);
            const fullRole = selectedOrLeadingRole(mapping);
            const fullScore = roleScore(mapping, fullRole);
            const scopeDecisiveness = new Map<
              PeerHeaderScopeClassification,
              boolean
            >();
            for (const scope of new Set(
              peerHeaders.map(({ scope_classification }) => scope_classification),
            )) {
              const excludedFieldIds = new Set(
                peerHeaders
                  .filter((peer) => peer.scope_classification === scope)
                  .map(({ handle }) => handle.field.id),
              );
              const counterfactual = createSemanticColumnMapping({
                ...mappingInput,
                evidence: {
                  ...mappingInput.evidence,
                  headerFields: headerFields.filter(
                    (handle) => !excludedFieldIds.has(handle.field.id),
                  ),
                },
              });
              scopeDecisiveness.set(
                scope,
                counterfactual.status !== mapping.status
                || counterfactual.assessment.selected_role
                  !== mapping.assessment.selected_role,
              );
            }
            const peerHeaderEvidence = peerHeaders.map((peer) => {
              const counterfactual = createSemanticColumnMapping({
                ...mappingInput,
                evidence: {
                  ...mappingInput.evidence,
                  headerFields: headerFields.filter(
                    (handle) => handle.field.id !== peer.handle.field.id,
                  ),
                },
              });
              const sourceCell = fieldSourceCell(peer.handle, input.cells);
              const normalizedHeader = mapping.assessment.decision_evidence
                .observed_headers.find(({ verified_field_id }) =>
                  verified_field_id === peer.handle.field.id)?.normalized_text ?? '';
              return {
                target_mapping_id: mapping.id,
                target_column_id: columnReferenceId(segment, column),
                target_segment_id: segment.id,
                target_chain_id: chain.id,
                target_page: segment.page,
                target_column_geometry: { x0: column.x0, x1: column.x1 },
                target_column_ordinal: column.index,
                peer_column_id: columnReferenceId(peer.segment, peer.column),
                peer_segment_id: peer.segment.id,
                peer_chain_id: peer.peer_chain_id,
                continuation_link_id: peer.continuation_link?.id ?? null,
                continuation_link_decision:
                  peer.continuation_link?.decision ?? null,
                scope_classification: peer.scope_classification,
                geometric_distance: peer.center_distance,
                page_distance: Math.abs(peer.segment.page - segment.page),
                peer_column_geometry: {
                  x0: peer.column.x0,
                  x1: peer.column.x1,
                },
                peer_column_ordinal: peer.column.index,
                normalized_header_text: normalizedHeader,
                header_role_contribution: fullRole,
                score_contribution: Number(
                  (fullScore - roleScore(counterfactual, fullRole)).toFixed(6),
                ),
                decisive:
                  scopeDecisiveness.get(peer.scope_classification) ?? false,
                individually_decisive:
                  counterfactual.status !== mapping.status
                  || counterfactual.assessment.selected_role
                    !== mapping.assessment.selected_role,
                selected_role: mapping.assessment.selected_role,
                runner_up_role:
                  mapping.assessment.decision_evidence.runner_up_role,
                final_score: mapping.assessment.resolution_policy
                  .observed_top_score,
                final_margin: mapping.assessment.resolution_policy
                  .observed_margin,
                source_verified_field_ids: [peer.handle.field.id],
                page: sourceCell?.page ?? peer.segment.page,
                bounding_box: {
                  ...(sourceCell?.bounding_box ?? peer.segment.bounding_box),
                },
                raw_span: {
                  raw_text: peer.handle.field.raw_text,
                  source_fragment_ids: [
                    ...peer.handle.field.source_fragment_ids,
                  ],
                },
                dependency_hashes: [hashCanonical({
                  verified_field_id: peer.handle.field.id,
                  source_fragment_ids: peer.handle.field.source_fragment_ids,
                  raw_text: peer.handle.field.raw_text,
                  normalized_value: peer.handle.field.normalized_value,
                })],
              };
            });
            const scopeRejections = rejectedGeometryPeers
              .filter((peer) =>
                scopeClassification({
                  targetSegment: segment,
                  targetChain: chain,
                  peerSegment: peer.segment,
                  peerChainId:
                    chainIdBySegment.get(peer.segment.id) ?? null,
                  continuationLink: directContinuationLink(
                    segment.id,
                    peer.segment.id,
                    input.continuation_links ?? [],
                  ),
                }) === 'outside_chain_and_linked_continuation_scope')
              .map((peer) => {
                const link = directContinuationLink(
                  segment.id,
                  peer.segment.id,
                  input.continuation_links ?? [],
                );
                return {
                  target_mapping_id: mapping.id,
                  target_segment_id: segment.id,
                  target_chain_id: chain.id,
                  peer_segment_id: peer.segment.id,
                  peer_chain_id:
                    chainIdBySegment.get(peer.segment.id) ?? null,
                  peer_column_id: columnReferenceId(peer.segment, peer.column),
                  scope_classification:
                    'outside_chain_and_linked_continuation_scope' as const,
                  rejection_reason:
                    'different_chain_without_explicit_linked_continuation',
                  continuation_link_id: link?.id ?? null,
                  continuation_link_decision: link?.decision ?? null,
                  geometric_distance: peer.center_distance,
                  page_distance: Math.abs(peer.segment.page - segment.page),
                };
              });
            return [{
              mapping,
              table_segment_id: segment.id,
              peer_header_evidence: peerHeaderEvidence,
              target_own_header_evidence: peerHeaderEvidence.filter(
                ({ scope_classification }) =>
                  scope_classification === 'target_segment',
              ),
              peer_header_scope_rejections: scopeRejections,
            }];
          });
        }));
    } catch (error) {
      const record = {
        id: opaqueIds.semanticColumnMapping({
          kind: 'semantic_column_mapping_failure',
          extraction_snapshot_id: input.extraction_snapshot_id,
        }),
        record_type: 'ambiguity',
        semantic_column_mapping_id: null,
        record_data: {
          reason: 'semantic_column_mapping_failure',
          error_category: error instanceof Error ? error.name : 'UnknownError',
        },
        sequence: 1,
      };
      return {
        interpretation_snapshot: {
          id: interpretationSnapshotId,
          interpreter_manifest_hash: interpretationManifestHash,
          entity_resolver_version: 'not-applicable-step3',
          effective_truth_set_hash: hashCanonical([]),
          status: 'blocked',
          output_root_hash: hashCanonical({ interpretation_records: [record] }),
          published_at: input.published_at,
        },
        semantic_column_mappings: [],
        interpretation_records: [record],
      };
    }
    if (mappings.length === 0) {
      return {
        interpretation_snapshot: null,
        semantic_column_mappings: [],
        interpretation_records: [],
      };
    }
    const records = mappings.flatMap(({ mapping }, index) => {
      const mappingRecord = {
        id: opaqueIds.semanticColumnMapping({
          kind: 'interpretation_record',
          semantic_column_mapping_id: mapping.id,
        }),
        record_type: 'semantic_column_mapping',
        semantic_column_mapping_id: mapping.id,
        record_data: {
          status: mapping.status,
          rule: mapping.rule,
        },
        sequence: index * 2 + 1,
      };
      if (mapping.status === 'resolved') return [mappingRecord];
      return [
        mappingRecord,
        {
          id: opaqueIds.semanticColumnMapping({
            kind: 'ambiguity_record',
            semantic_column_mapping_id: mapping.id,
          }),
          record_type: 'ambiguity',
          semantic_column_mapping_id: null,
          record_data: {
            semantic_column_mapping_id: mapping.id,
            reason: 'semantic_column_ambiguity',
            assessment: mapping.assessment,
          },
          sequence: index * 2 + 2,
        },
      ];
    });
    const outputRootHash = hashCanonical({
      semantic_column_mappings: mappings,
      interpretation_records: records,
    });
    return {
      interpretation_snapshot: {
        id: interpretationSnapshotId,
        interpreter_manifest_hash: interpretationManifestHash,
        entity_resolver_version: 'not-applicable-step3',
        effective_truth_set_hash: hashCanonical([]),
        status: mappings.some(({ mapping }) => mapping.status === 'ambiguous')
          ? 'partial' : 'complete',
        output_root_hash: outputRootHash,
        published_at: input.published_at,
      },
      semantic_column_mappings: mappings.map((entry) => ({
        id: entry.mapping.id,
        table_chain_id: entry.mapping.table_chain_id,
        table_segment_id: entry.table_segment_id,
        column_index: entry.mapping.column_index,
        domain_role: entry.mapping.domain_role,
        assessment: entry.mapping.assessment,
        status: entry.mapping.status,
        interpretation_rule_id: entry.mapping.rule.id,
        interpretation_rule_version: entry.mapping.rule.version,
        header_verified_field_ids: entry.mapping.header_verified_field_ids,
        cell_verified_field_ids: entry.mapping.cell_verified_field_ids,
        peer_header_evidence: entry.peer_header_evidence,
        target_own_header_evidence: entry.target_own_header_evidence,
        peer_header_scope_rejections: entry.peer_header_scope_rejections,
      })),
      interpretation_records: records,
    };
  };
