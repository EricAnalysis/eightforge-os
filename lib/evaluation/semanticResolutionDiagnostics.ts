import { hashCanonical } from '@/lib/extraction/domain/hash';
import type {
  GridCellArtifact,
  LogicalTableRow,
  TableChainArtifact,
  TableSectionArtifact,
  TableSegmentArtifact,
  TableValueKind,
} from '@/lib/extraction/domain/types';
import {
  SEMANTIC_COLUMN_RULES,
  type SemanticColumnRole,
} from '@/lib/interpretation/semanticColumnMapping';
import type {
  GenericComparedField,
  GenericShadowRun,
  ParityRecord,
} from '@/lib/evaluation/tdotPhase1Harness';

type PrimaryCause =
  | 'no_semantic_mapping_exists'
  | 'mapping_exists_but_no_header_evidence_was_retained'
  | 'header_row_was_not_detected'
  | 'header_cell_did_not_become_a_verified_field'
  | 'header_text_was_recovered_but_normalized_incorrectly'
  | 'normalized_header_matched_no_role_evidence'
  | 'header_evidence_matched_multiple_roles'
  | 'body_value_kind_was_incompatible_with_the_leading_role'
  | 'conflicting_body_value_kinds_prevented_resolution'
  | 'cross_page_or_repeated_header_evidence_disagreed'
  | 'mapping_resolved_generically_but_the_evaluator_rejected_it'
  | 'evaluator_role_contract_differs_from_the_generic_role'
  | 'underlying_reconstruction_remains_non_exact'
  | 'genuinely_ambiguous_evidence'
  | 'another_measured_cause';

type AuditClass =
  | 'generic_mapping_selected_correct_role_but_evaluator_rejected_it'
  | 'generic_mapping_selected_incorrect_role'
  | 'generic_mapping_remained_ambiguous_despite_sufficient_evidence'
  | 'evidence_is_genuinely_insufficient'
  | 'role_mapping_is_not_the_actual_blocking_stage'
  | 'underlying_reconstruction_is_non_exact';

type MappingRecord = {
  readonly id: string;
  readonly table_chain_id: string;
  readonly column_index: number;
  readonly domain_role: SemanticColumnRole;
  readonly status: 'resolved' | 'ambiguous';
  readonly header_verified_field_ids: readonly string[];
  readonly cell_verified_field_ids: readonly string[];
  readonly assessment: {
    readonly selected_role: SemanticColumnRole | null;
    readonly candidate_roles: readonly {
      readonly role: Exclude<SemanticColumnRole, 'other'>;
      readonly score: number;
      readonly evidence: readonly string[];
      readonly verified_field_ids: readonly string[];
      readonly dependency_hashes: readonly string[];
    }[];
    readonly resolution_policy: {
      readonly minimum_score: number;
      readonly minimum_margin: number;
      readonly observed_top_score: number;
      readonly observed_margin: number;
    };
    readonly source_evidence: readonly {
      readonly verified_field_id: string;
      readonly raw_text: string;
      readonly source_fragment_ids: readonly string[];
      readonly page: number;
      readonly bounding_box: unknown;
      readonly dependency_hash: string;
    }[];
    readonly source_region: {
      readonly page: number;
      readonly bounding_box: unknown;
    };
  };
  readonly interpretation_rule_id: string;
  readonly interpretation_rule_version: string;
  readonly table_segment_id?: string | null;
  readonly peer_header_evidence?: readonly {
    readonly target_mapping_id: string;
    readonly target_segment_id: string;
    readonly target_chain_id: string;
    readonly peer_segment_id: string;
    readonly peer_chain_id: string | null;
    readonly scope_classification:
      | 'target_segment'
      | 'same_table_chain'
      | 'explicit_linked_continuation'
      | 'outside_chain_and_linked_continuation_scope';
    readonly decisive: boolean;
    readonly [key: string]: unknown;
  }[];
  readonly target_own_header_evidence?: readonly Readonly<Record<string, unknown>>[];
  readonly peer_header_scope_rejections?:
    readonly Readonly<Record<string, unknown>>[];
};

const rule = SEMANTIC_COLUMN_RULES['observed-column-evidence-v2'];

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/[/_&-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mappingRecords(run: GenericShadowRun): MappingRecord[] {
  return run.interpretation.semantic_column_mappings as unknown as MappingRecord[];
}

function sameBox(left: unknown, right: unknown): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

function countBy<T extends string>(values: readonly T[]): Record<T, number> {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {} as Record<T, number>);
}

function fieldKinds(
  mapping: MappingRecord,
  segment: TableSegmentArtifact | null,
): readonly TableValueKind[] {
  return segment?.column_hypotheses
    .find(({ index }) => index === mapping.column_index)
    ?.value_kind_hypotheses.map(({ kind }) => kind) ?? [];
}

function hasConflictingCellValues(
  mapping: MappingRecord,
  run: GenericShadowRun,
): boolean {
  const fields = new Map<string, (typeof run.graph.verifiedFields)[number]>(
    run.graph.verifiedFields.map((field) => [field.id, field]),
  );
  const byFragment = new Map<string, string>();
  for (const fieldId of mapping.cell_verified_field_ids) {
    const field = fields.get(fieldId);
    if (!field) continue;
    const value = hashCanonical(field.normalized_value);
    for (const fragmentId of field.source_fragment_ids) {
      const prior = byFragment.get(fragmentId);
      if (prior != null && prior !== value) return true;
      byFragment.set(fragmentId, value);
    }
  }
  return false;
}

function acceptedRoles(record: ParityRecord): readonly SemanticColumnRole[] {
  return record.semantic_role_comparison?.acceptable_roles ?? [];
}

function stableRecordKey(record: ParityRecord): string {
  return record.ledger?.field_identifier
    ?? record.legacy_row?.row_id
    ?? record.id;
}

function traceMapping(
  mapping: MappingRecord,
  run: GenericShadowRun,
  segments: ReadonlyMap<string, TableSegmentArtifact>,
  chains: ReadonlyMap<string, TableChainArtifact>,
  rows: ReadonlyMap<string, LogicalTableRow>,
  sections: readonly TableSectionArtifact[],
) {
  const chain = chains.get(mapping.table_chain_id) ?? null;
  const segment = chain?.segment_ids
    .map((id) => segments.get(id))
    .find((candidate) =>
      candidate?.page === mapping.assessment.source_region.page
      && sameBox(candidate.bounding_box, mapping.assessment.source_region.bounding_box))
    ?? null;
  const column = segment?.column_hypotheses
    .find(({ index }) => index === mapping.column_index) ?? null;
  const header = column?.header ?? null;
  const normalizedHeader = header?.observed_text == null
    ? null : normalizeHeader(header.observed_text);
  const kinds = fieldKinds(mapping, segment);
  const top = mapping.assessment.candidate_roles[0] ?? null;
  const exactHeaderRoles = mapping.assessment.candidate_roles.filter((candidate) =>
    candidate.evidence.some((item) => item.startsWith('header_exact_alias:')));
  const headerEvidenceRoles = mapping.assessment.candidate_roles.filter((candidate) =>
    candidate.evidence.some((item) => item.startsWith('header_')));
  const conflictingCellValues = hasConflictingCellValues(mapping, run);
  const kindCompatible = top == null ? false
    : kinds.some((kind) =>
      (rule.compatibleKinds[top.role] as readonly TableValueKind[]).includes(kind));
  const conjuncts = {
    no_conflicting_cell_values: !conflictingCellValues,
    no_multiple_exact_header_roles: exactHeaderRoles.length <= 1,
    leading_candidate_exists: top != null,
    minimum_score_met:
      (top?.score ?? 0) >= mapping.assessment.resolution_policy.minimum_score,
    minimum_margin_met:
      mapping.assessment.resolution_policy.observed_margin
        >= mapping.assessment.resolution_policy.minimum_margin,
    supported_header_role_is_unique: headerEvidenceRoles.length === 1,
    leading_role_kind_compatible: kindCompatible,
  };
  const actualPredicateKeys = [
    'no_conflicting_cell_values',
    'no_multiple_exact_header_roles',
    'leading_candidate_exists',
    'minimum_score_met',
    'minimum_margin_met',
  ] as const;
  const actualConjuncts = actualPredicateKeys.map((name) => ({
    name,
    passed: conjuncts[name],
    why: name === 'no_conflicting_cell_values'
      ? (conflictingCellValues
          ? 'one source fragment supports conflicting normalized cell values'
          : 'no source fragment supports conflicting normalized cell values')
      : name === 'no_multiple_exact_header_roles'
        ? `${exactHeaderRoles.length} exact header-supported roles`
        : name === 'leading_candidate_exists'
          ? (top ? `leading candidate is ${top.role}` : 'no candidate received evidence')
          : name === 'minimum_score_met'
            ? `${top?.score ?? 0} versus ${mapping.assessment.resolution_policy.minimum_score}`
            : `${mapping.assessment.resolution_policy.observed_margin} versus ${mapping.assessment.resolution_policy.minimum_margin}`,
    would_resolve_if_only_this_conjunct_changed:
      !conjuncts[name]
      && actualPredicateKeys.every((other) => other === name || conjuncts[other]),
  }));
  const headerRows = segment?.row_ids
    .map((id) => rows.get(id))
    .filter((row) => row?.row_kind === 'header')
    .map((row) => row?.id) ?? [];
  const cells = new Map(
    run.graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const headerSourceCells = (header?.fragment_ids ?? [])
    .map((id) => cells.get(id))
    .filter((cell): cell is GridCellArtifact => cell != null)
    .map((cell) => ({
      id: cell.id,
      raw_text: cell.raw_text,
      page: cell.page,
      bounding_box: cell.bounding_box,
      content_token_ids: cell.content_token_ids,
      row_start: cell.row_start,
      column_start: cell.column_start,
    }));
  const currentCenter = column ? (column.x0 + column.x1) / 2 : null;
  const peerColumnHeaders = currentCenter == null ? [] : (chain?.segment_ids ?? [])
    .map((id) => segments.get(id))
    .filter((peer): peer is TableSegmentArtifact => peer != null)
    .map((peer) => {
      const peerColumn = peer.column_hypotheses
        .map((candidate) => ({
          candidate,
          distance: Math.abs(
            currentCenter - ((candidate.x0 + candidate.x1) / 2),
          ),
        }))
        .filter(({ distance }) =>
          distance <= rule.crossPageColumnCenterTolerance)
        .sort((left, right) =>
          left.distance - right.distance
          || left.candidate.index - right.candidate.index)[0] ?? null;
      return {
        segment_id: peer.id,
        page: peer.page,
        matched_column: peerColumn?.candidate.index ?? null,
        column_center_distance: peerColumn?.distance ?? null,
        observed_header_text: peerColumn?.candidate.header.observed_text ?? null,
        normalized_header_text:
          peerColumn?.candidate.header.observed_text == null
            ? null : normalizeHeader(peerColumn.candidate.header.observed_text),
        header_fragment_ids: peerColumn?.candidate.header.fragment_ids ?? [],
      };
    });
  const sectionIds = sections.filter((section) =>
    section.table_chain_id === mapping.table_chain_id).map(({ id }) => id);
  return {
    semantic_column_mapping_id: mapping.id,
    table_chain_id: mapping.table_chain_id,
    table_segment_id: segment?.id ?? null,
    section_ids: sectionIds,
    observed_column: mapping.column_index,
    observed_header_text: header?.observed_text ?? null,
    normalized_header_text: normalizedHeader,
    header_fragment_ids: header?.fragment_ids ?? [],
    header_source_cells: headerSourceCells,
    header_verified_field_ids: mapping.header_verified_field_ids,
    detected_header_row_ids: headerRows,
    chain_segment_ids: chain?.segment_ids ?? [],
    peer_column_headers: peerColumnHeaders,
    candidate_roles: mapping.assessment.candidate_roles,
    observed_body_value_kinds: kinds,
    kind_compatibility: {
      leading_role: top?.role ?? null,
      compatible: kindCompatible,
      compatible_kinds: top
        ? rule.compatibleKinds[top.role] as readonly TableValueKind[] : [],
    },
    conflicting_cell_values: conflictingCellValues,
    selected_role: mapping.assessment.selected_role,
    runner_up_role: mapping.assessment.candidate_roles[1]?.role ?? null,
    resolution_margin: mapping.assessment.resolution_policy.observed_margin,
    final_mapping_status: mapping.status,
    resolution_conjuncts: actualConjuncts,
    diagnostic_conjuncts: {
      supported_header_role_is_unique: conjuncts.supported_header_role_is_unique,
      leading_role_kind_compatible: conjuncts.leading_role_kind_compatible,
    },
    contributing_verified_field_ids: [
      ...mapping.header_verified_field_ids,
      ...mapping.cell_verified_field_ids,
    ],
    source_evidence: mapping.assessment.source_evidence,
    dependency_hashes: mapping.assessment.candidate_roles.flatMap(
      ({ dependency_hashes }) => dependency_hashes),
    interpretation_rule_id: mapping.interpretation_rule_id,
    interpretation_rule_version: mapping.interpretation_rule_version,
  };
}

function classifyRecord(
  record: ParityRecord,
  mappingTrace: ReturnType<typeof traceMapping> | null,
): { readonly primary_cause: PrimaryCause; readonly cause_detail: string; readonly audit_class: AuditClass } {
  if (record.reconstruction_comparison?.exact_equal === false) {
    return {
      primary_cause: 'underlying_reconstruction_remains_non_exact',
      cause_detail: record.explanation,
      audit_class: 'underlying_reconstruction_is_non_exact',
    };
  }
  if (record.generic_fields.length > 1) {
    return {
      primary_cause: 'another_measured_cause',
      cause_detail: 'logical source cell is split across multiple verified cells or logical rows',
      audit_class: 'role_mapping_is_not_the_actual_blocking_stage',
    };
  }
  if (!mappingTrace) {
    return {
      primary_cause: 'no_semantic_mapping_exists',
      cause_detail: 'no SemanticColumnMapping is attached to the compared verified field',
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  const selected = mappingTrace.selected_role;
  const accepted = acceptedRoles(record);
  if (mappingTrace.final_mapping_status === 'resolved') {
    if (selected != null && accepted.includes(selected)) {
      return {
        primary_cause: 'mapping_resolved_generically_but_the_evaluator_rejected_it',
        cause_detail: record.explanation,
        audit_class: 'generic_mapping_selected_correct_role_but_evaluator_rejected_it',
      };
    }
    return {
      primary_cause: 'evaluator_role_contract_differs_from_the_generic_role',
      cause_detail: `selected ${selected ?? 'none'}; evaluator accepts ${accepted.join(',') || 'no role'}`,
      audit_class: 'generic_mapping_selected_incorrect_role',
    };
  }
  if (mappingTrace.conflicting_cell_values) {
    return {
      primary_cause: 'conflicting_body_value_kinds_prevented_resolution',
      cause_detail: 'conflicting normalized values share at least one source fragment',
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  if (mappingTrace.observed_header_text == null) {
    if (mappingTrace.detected_header_row_ids.length === 0) {
      return {
        primary_cause: 'header_row_was_not_detected',
        cause_detail: 'the mapped segment has no logical row classified as a header',
        audit_class: 'evidence_is_genuinely_insufficient',
      };
    }
    return {
      primary_cause: 'header_cell_did_not_become_a_verified_field',
      cause_detail: 'a header row exists but this column retained no observed header field',
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  if (mappingTrace.header_verified_field_ids.length === 0) {
    return {
      primary_cause: 'mapping_exists_but_no_header_evidence_was_retained',
      cause_detail: 'observed header text exists structurally but no header VerifiedField reached the mapping',
      audit_class: 'generic_mapping_remained_ambiguous_despite_sufficient_evidence',
    };
  }
  const headerCandidates = mappingTrace.candidate_roles.filter(({ evidence }) =>
    evidence.some((item) => item.startsWith('header_')));
  if (headerCandidates.length === 0) {
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      mappingTrace.observed_header_text,
    )) {
      return {
        primary_cause: 'another_measured_cause',
        cause_detail:
          'a UUID-shaped source field was selected as the structural header; normalization is not the earliest divergence',
        audit_class: 'evidence_is_genuinely_insufficient',
      };
    }
    return {
      primary_cause: 'normalized_header_matched_no_role_evidence',
      cause_detail: `normalized header "${mappingTrace.normalized_header_text}" matched no rule evidence`,
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  if (headerCandidates.length > 1) {
    return {
      primary_cause: 'header_evidence_matched_multiple_roles',
      cause_detail: `${headerCandidates.length} roles retain header evidence`,
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  if (!mappingTrace.kind_compatibility.compatible) {
    return {
      primary_cause: 'body_value_kind_was_incompatible_with_the_leading_role',
      cause_detail: `leading role ${mappingTrace.kind_compatibility.leading_role} is incompatible with retained body kinds`,
      audit_class: 'evidence_is_genuinely_insufficient',
    };
  }
  return {
    primary_cause: 'genuinely_ambiguous_evidence',
    cause_detail: 'retained generic evidence does not satisfy the unchanged score and margin predicate',
    audit_class: 'evidence_is_genuinely_insufficient',
  };
}

function fieldPath(
  field: GenericComparedField,
  cells: ReadonlyMap<string, GridCellArtifact>,
  rows: ReadonlyMap<string, LogicalTableRow>,
  segments: ReadonlyMap<string, TableSegmentArtifact>,
  chainsBySegment: ReadonlyMap<string, TableChainArtifact>,
  sections: readonly TableSectionArtifact[],
) {
  const cell = cells.get(field.table_cell_id) ?? null;
  const row = field.table_row_id ? rows.get(field.table_row_id) ?? null : null;
  const segment = segments.get(field.table_segment_id) ?? null;
  const chain = chainsBySegment.get(field.table_segment_id) ?? null;
  const section = sections.find((candidate) =>
    candidate.table_chain_id === chain?.id
    && (row == null || candidate.member_row_ids.includes(row.id))) ?? null;
  return {
    verified_field_id: field.verified_field_id,
    reconstructed_value: field.raw_text,
    source_page: field.source_page,
    source_bounding_box: field.source_bbox,
    raw_span: field.raw_text,
    candidate_id: field.candidate_id,
    dependency_hash: field.dependency_hash,
    source_fragment_ids: field.source_fragment_ids,
    cell_id: cell?.id ?? field.table_cell_id,
    logical_row_id: row?.id ?? field.table_row_id,
    segment_id: segment?.id ?? field.table_segment_id,
    chain_id: chain?.id ?? null,
    section_id: section?.id ?? null,
  };
}

type SourceHeaderClass = 'A' | 'B' | 'C' | 'D' | 'E';

function overlapRatio(
  left: { readonly x0: number; readonly x1: number },
  right: { readonly x0: number; readonly x1: number },
): number {
  const overlap = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0));
  const denominator = Math.min(left.x1 - left.x0, right.x1 - right.x0);
  return denominator <= 0 ? 0 : overlap / denominator;
}

function sourceHeaderExistenceAudit(input: {
  readonly run: GenericShadowRun;
  readonly records: readonly ParityRecord[];
  readonly mappings: readonly MappingRecord[];
}) {
  const fragments = new Map(
    input.run.graph.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const cells = new Map(
    input.run.graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const rows = new Map(input.run.graph.tableRows.map((row) => [row.id, row]));
  const segments = new Map(
    input.run.graph.tableSegments.map((segment) => [segment.id, segment]),
  );
  const chainsBySegment = new Map(input.run.graph.tableChains.flatMap((chain) =>
    chain.segment_ids.map((segmentId) => [segmentId, chain] as const)));
  const mappings = new Map(input.mappings.map((mapping) => [mapping.id, mapping]));
  const verifiedFieldsByFragment = new Map<string, string[]>();
  for (const field of input.run.graph.verifiedFields) {
    for (const fragmentId of field.source_fragment_ids) {
      const values = verifiedFieldsByFragment.get(fragmentId) ?? [];
      values.push(field.id);
      verifiedFieldsByFragment.set(fragmentId, values);
    }
  }
  const physicalRowTokens = new Set(
    (input.run.graph.tableReconstructionDiagnostics?.row_anchor_assignments ?? []).flatMap(
      (assignment) => assignment.apparent_cell_fragment_ids.flat(),
    ),
  );

  const records = input.records
    .filter((record) =>
      record.material && record.resolution === 'requires_semantic_review')
    .map((record) => {
      const field = record.generic_fields[0] ?? null;
      const mappingId = field?.semantic_mapping_evidence?.mapping_id ?? null;
      const mapping = mappingId ? mappings.get(mappingId) ?? null : null;
      const segment = field
        ? segments.get(field.table_segment_id as TableSegmentArtifact['id']) ?? null
        : null;
      const chain = segment ? chainsBySegment.get(segment.id) ?? null : null;
      const targetColumn = mapping && segment
        ? segment.column_hypotheses.find(({ index }) =>
            index === mapping.column_index) ?? null
        : null;
      const targetPosition = targetColumn && segment
        ? segment.column_hypotheses.indexOf(targetColumn)
        : -1;

      const externalCandidates = mapping && segment && targetColumn
        ? input.run.graph.tableSegments.flatMap((candidateSegment) => {
            if (candidateSegment.id === segment.id) return [];
            const pageDistance = segment.page - candidateSegment.page;
            const legitimateDirection = pageDistance === 1
              || (
                pageDistance === 0
                && candidateSegment.bounding_box.y1 <= segment.bounding_box.y0
              );
            if (!legitimateDirection) return [];
            return candidateSegment.column_hypotheses.flatMap(
              (candidateColumn, candidatePosition) => {
                if (candidateColumn.header.observed_text == null) return [];
                const bandOverlap = overlapRatio(targetColumn, candidateColumn);
                const centerDistance = Math.abs(
                  ((targetColumn.x0 + targetColumn.x1) / 2)
                  - ((candidateColumn.x0 + candidateColumn.x1) / 2),
                );
                const structuralSignals = [
                  candidatePosition === targetPosition
                    ? 'same_relative_column_ordinal' : null,
                  bandOverlap >= 0.5 ? 'horizontal_band_overlap' : null,
                  centerDistance <= 0.08 ? 'consistent_column_centres' : null,
                  pageDistance === 1
                    ? 'adjacent_page_continuation' : 'candidate_above_segment',
                  Math.abs(
                    candidateSegment.column_hypotheses.length
                    - segment.column_hypotheses.length,
                  ) <= 1 ? 'compatible_column_count' : null,
                ].filter((value): value is string => value != null);
                if (
                  structuralSignals.length < 3
                  || bandOverlap < 0.25
                  || centerDistance > 0.1
                ) return [];
                return [{
                  segment: candidateSegment,
                  column: candidateColumn,
                  position: candidatePosition,
                  bandOverlap,
                  centerDistance,
                  structuralSignals,
                  score: structuralSignals.length + bandOverlap - centerDistance,
                }];
              },
            );
          }).sort((left, right) =>
            right.score - left.score
            || right.segment.page - left.segment.page
            || left.position - right.position)
        : [];
      const external = externalCandidates[0] ?? null;
      const ownHeader = targetColumn?.header.observed_text == null
        ? null
        : {
            segment,
            column: targetColumn,
            position: targetPosition,
            bandOverlap: 1,
            centerDistance: 0,
            structuralSignals: ['inside_target_segment'],
            score: 1,
          };
      const selected = external ?? ownHeader;
      const headerFragmentIds = selected?.column.header.fragment_ids ?? [];
      const headerFragmentIdSet = new Set<string>(headerFragmentIds);
      const headerCells = headerFragmentIds.flatMap((id) => {
        const cell = cells.get(id);
        return cell ? [cell] : [];
      });
      const sourceTokenIds = [
        ...new Set(headerFragmentIds.flatMap((id) =>
          cells.get(id)?.content_token_ids ?? [id])),
      ];
      const nativeTokenIds = sourceTokenIds.filter((id) =>
        fragments.get(id)?.parser.stage === 'native_text');
      const ocrObservationIds = sourceTokenIds.filter((id) =>
        fragments.get(id)?.parser.stage === 'ocr');
      const headerRow = selected
        ? selected.segment.row_ids
            .map((id) => rows.get(id))
            .find((row) =>
              row?.cell_ids.some((id) => headerFragmentIdSet.has(id))) ?? null
        : null;
      const verifiedFieldIds = [
        ...new Set(headerFragmentIds.flatMap((id) =>
          verifiedFieldsByFragment.get(id) ?? [])),
      ];
      const reachedBridge = mapping != null
        && verifiedFieldIds.some((id) =>
          mapping.header_verified_field_ids.includes(id));
      const pageHasMachineEvidence = segment != null
        && input.run.graph.fragments.some((fragment) =>
          fragment.page === segment.page
          && (
            fragment.parser.stage === 'native_text'
            || fragment.parser.stage === 'ocr'
          ));

      let primaryClassification: SourceHeaderClass;
      let subCause: string;
      let earliestStage: string;
      if (!mapping || !segment || !targetColumn || !pageHasMachineEvidence) {
        primaryClassification = 'E';
        subCause = 'machine_evidence_or_target_relationship_incomplete';
        earliestStage = 'source_evidence_coverage';
      } else if (external) {
        primaryClassification = 'A';
        subCause = chainsBySegment.get(external.segment.id)?.id !== chain?.id
          ? 'split_into_a_separate_segment'
          : 'excluded_above_segment_start';
        earliestStage = 'table_continuation_chain_construction';
      } else if (headerRow && headerRow.row_kind !== 'header') {
        primaryClassification = 'B';
        subCause = 'inside_segment_row_not_classified_as_header';
        earliestStage = 'header_row_classification';
      } else if (ownHeader && (!headerRow || verifiedFieldIds.length === 0 || !reachedBridge)) {
        primaryClassification = 'C';
        subCause = !headerRow
          ? 'header_fragments_not_assigned_to_cells'
          : verifiedFieldIds.length === 0
            ? 'header_fields_not_verified'
            : 'header_evidence_lost_in_segment_to_chain_bridge';
        earliestStage = !headerRow
          ? 'logical_row_or_cell_reconstruction'
          : verifiedFieldIds.length === 0
            ? 'verified_field_publication'
            : 'interpretation_bridge';
      } else if (!selected) {
        primaryClassification = 'D';
        subCause = 'no_machine_usable_header_in_legitimate_table_continuation';
        earliestStage = 'source_contains_no_usable_header';
      } else {
        primaryClassification = 'C';
        subCause = 'header_evidence_retained_but_semantically_non_decisive';
        earliestStage = 'semantic_mapping';
      }

      return {
        material_record_id: record.id,
        mapping_id: mappingId,
        chain_id: chain?.id ?? null,
        segment_id: segment?.id ?? null,
        column_id: mapping && segment
          ? `${segment.id}:column:${mapping.column_index}` : null,
        source_page: segment?.page ?? field?.source_page ?? null,
        segment_bounds: segment?.bounding_box ?? null,
        candidate_header_row_bounds: headerRow?.bounding_box ?? null,
        native_token_ids: nativeTokenIds,
        ocr_observation_ids: ocrObservationIds,
        raw_header_text: selected?.column.header.observed_text ?? null,
        normalized_header_text:
          selected?.column.header.normalized_label ?? null,
        source_bounding_boxes: sourceTokenIds.flatMap((id) => {
          const fragment = fragments.get(id);
          return fragment ? [fragment.bounding_box] : [];
        }),
        row_ordinal: headerRow && selected
          ? selected.segment.row_ids.indexOf(headerRow.id) : null,
        column_band_intersection: selected?.bandOverlap ?? null,
        candidate_lies_inside_segment:
          selected?.segment.id === segment?.id,
        became_physical_row:
          sourceTokenIds.length > 0
          && sourceTokenIds.every((id) => physicalRowTokens.has(id)),
        became_logical_row: headerRow != null,
        became_cell: headerCells.length > 0,
        became_verified_field: verifiedFieldIds.length > 0,
        reached_interpretation_bridge: reachedBridge,
        candidate_header_segment_id: selected?.segment.id ?? null,
        candidate_header_chain_id: selected
          ? chainsBySegment.get(selected.segment.id)?.id ?? null : null,
        candidate_rule_version: 'source-header-existence-v1',
        association_evidence: selected?.structuralSignals ?? [],
        rejected_candidate_count: Math.max(0, externalCandidates.length - 1),
        earliest_stage_where_evidence_was_excluded: earliestStage,
        primary_classification: primaryClassification,
        sub_cause: subCause,
      };
    });

  const byMapping = new Map<string, typeof records>();
  for (const record of records) {
    if (!record.mapping_id) continue;
    const values = byMapping.get(record.mapping_id) ?? [];
    values.push(record);
    byMapping.set(record.mapping_id, values);
  }
  const mappingAggregates = [...byMapping.entries()].map(([mappingId, values]) => {
    const mapping = mappings.get(mappingId)!;
    const classifications = [...new Set(values.map((value) =>
      value.primary_classification))];
    return {
      mapping_id: mappingId,
      dependent_material_record_count: values.length,
      dependent_material_record_ids: values.map((value) =>
        value.material_record_id),
      source_header_classification:
        classifications.length === 1 ? classifications[0] : 'E',
      current_candidate_roles: mapping.assessment.candidate_roles.map(({ role }) => role),
      ambiguity_reason: mapping.status === 'ambiguous'
        ? 'strict_header_resolution_predicate_not_satisfied'
        : null,
      likely_repair_layer: classifications.length !== 1
        ? 'source_evidence_review'
        : classifications[0] === 'A'
          ? 'segment_or_continuation_header_association'
          : classifications[0] === 'B'
            ? 'header_row_classification'
            : classifications[0] === 'C'
              ? 'verified_header_publication_or_bridge'
              : classifications[0] === 'D'
                ? 'headerless_interpretation_eligibility'
                : 'source_evidence_review',
    };
  });

  return {
    policy_version: 'source-header-existence-v1',
    material_record_count: records.length,
    distinct_mapping_count: mappingAggregates.length,
    classification_distribution: countBy(records.map((record) =>
      record.primary_classification)),
    sub_cause_distribution: countBy(records.map((record) => record.sub_cause)),
    earliest_stage_distribution: countBy(records.map((record) =>
      record.earliest_stage_where_evidence_was_excluded)),
    records,
    mappings: mappingAggregates,
  };
}

function reconstructionDefectDiagnostics(
  run: GenericShadowRun,
  records: readonly ParityRecord[],
) {
  const diagnostics = run.graph.tableReconstructionDiagnostics;
  const cells = run.graph.fragments
    .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell');
  return records.filter((record) =>
    record.material
    && record.ledger != null
    && record.reconstruction_comparison?.exact_equal === false)
    .map((record) => {
      const ledger = record.ledger!;
      const ledgerBox = {
        x0: ledger.bbox_x0 / ledger.page_width_points,
        y0: ledger.bbox_y0 / ledger.page_height_points,
        x1: ledger.bbox_x1 / ledger.page_width_points,
        y1: ledger.bbox_y1 / ledger.page_height_points,
      };
      const intersects = (box: GridCellArtifact['bounding_box']) =>
        Math.min(box.x1, ledgerBox.x1) > Math.max(box.x0, ledgerBox.x0)
        && Math.min(box.y1, ledgerBox.y1) > Math.max(box.y0, ledgerBox.y0);
      const physicalFragments = run.graph.fragments
        .filter((fragment) =>
          fragment.kind === 'token'
          && fragment.page === ledger.source_page
          && intersects(fragment.bounding_box))
        .map((fragment) => ({
          fragment_id: fragment.id,
          raw_text: fragment.raw_text,
          bounding_box: fragment.bounding_box,
          reading_order: fragment.reading_order,
          dependency_owners: run.graph.fragmentDependencies
            .filter((dependency) =>
              dependency.dependency_fragment_ids.includes(fragment.id))
            .map(({ fragment_artifact_id }) => fragment_artifact_id),
          undisposed:
            diagnostics.undisposed_fragment_ids.includes(fragment.id),
        }));
      const fragmentIds = new Set(physicalFragments.map(({ fragment_id }) => fragment_id));
      const candidateCells = cells.filter((cell) =>
        cell.page === ledger.source_page
        && (
          intersects(cell.bounding_box)
          || cell.content_token_ids.some((id) => fragmentIds.has(id))
        ));
      const rowAssignments = diagnostics.row_anchor_assignments.filter((assignment) =>
        assignment.page === ledger.source_page
        && assignment.apparent_cell_fragment_ids.some((ids) =>
          ids.some((id) => fragmentIds.has(id))));
      const overflows = diagnostics.column_overflows.filter((overflow) =>
        overflow.page === ledger.source_page
        && overflow.fragment_ids.some((id) => fragmentIds.has(id)));
      const sparse = diagnostics.sparse_row_dispositions.filter((disposition) =>
        disposition.page === ledger.source_page
        && disposition.fragment_ids.some((id) => fragmentIds.has(id)));
      const scopeExclusions = (
        diagnostics.physical_row_scope_exclusions ?? []
      ).filter((exclusion) =>
        exclusion.page === ledger.source_page
        && exclusion.fragment_ids.some((id) => fragmentIds.has(id)));
      const selectedRows = record.generic_fields
        .map(({ table_row_id }) => table_row_id)
        .filter((id): id is string => id != null);
      return {
        material_record_id: record.id,
        field_identifier: ledger.field_identifier,
        ledger_role: ledger.interpreted_field_or_role,
        expected_text: ledger.exact_raw_text,
        reconstructed_text:
          record.reconstruction_comparison?.reconstructed_raw_text ?? null,
        source_page: ledger.source_page,
        source_bounding_box: ledgerBox,
        physical_source_fragments: physicalFragments,
        expected_logical_row: ledger.row_identity,
        selected_logical_row_ids: selectedRows,
        candidate_rows: rowAssignments,
        candidate_cells: candidateCells.map((cell) => ({
          cell_id: cell.id,
          raw_text: cell.raw_text,
          bounding_box: cell.bounding_box,
          row_start: cell.row_start,
          column_start: cell.column_start,
          content_token_ids: cell.content_token_ids,
          structure: cell.structure,
        })),
        candidate_scores: rowAssignments.flatMap(({ selected_assignments }) =>
          selected_assignments),
        row_bands: sparse.flatMap(({ primary_row_bands }) => primary_row_bands),
        column_bands: rowAssignments.flatMap(({ candidate_matrix }) =>
          candidate_matrix.flatMap((candidates) =>
            candidates.map(({ column_index }) => column_index))),
        continuation_state: sparse,
        physical_row_scope_exclusions: scopeExclusions,
        collision_state: overflows,
        spacing_thresholds: {
          sparse: sparse.map(({ spacing_evidence }) => spacing_evidence),
          page_calibration: diagnostics.calibrations.filter((calibration) =>
            calibration.page === ledger.source_page),
        },
        earliest_divergence: scopeExclusions.length > 0
          ? 'physical_row_scope_exclusion'
          : overflows.length > 0
            ? 'apparent_cell_global_column_assignment'
            : 'physical_row_to_logical_row_association',
        primary_mechanism: overflows.length > 0
          ? 'same_row_same_column_overflow_prevents_later_coalescing'
          : scopeExclusions.length > 0
            ? 'multiline_fragments_excluded_before_row_association'
            : 'multiline_cell_fragments_lack_complete_row_association_trace',
      };
    });
}

export function buildSemanticResolutionDiagnostic(input: {
  readonly run: GenericShadowRun;
  readonly records: readonly ParityRecord[];
  readonly baselineRecords?: readonly ParityRecord[];
  readonly baselineReportVersion: string;
  readonly checkpoint?: string;
}) {
  const cells = new Map(
    input.run.graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const rows = new Map(input.run.graph.tableRows.map((row) => [row.id, row]));
  const segments = new Map(input.run.graph.tableSegments.map((segment) => [segment.id, segment]));
  const chains = new Map(input.run.graph.tableChains.map((chain) => [chain.id, chain]));
  const chainsBySegment = new Map(input.run.graph.tableChains.flatMap((chain) =>
    chain.segment_ids.map((id) => [id, chain] as const)));
  const mappings = mappingRecords(input.run);
  const sourceHeaderAudit = sourceHeaderExistenceAudit({
    run: input.run,
    records: input.records,
    mappings,
  });
  const mappingTraces = mappings.map((mapping) =>
    traceMapping(
      mapping,
      input.run,
      segments,
      chains,
      rows,
      input.run.graph.tableSections,
    ));
  const mappingTraceById = new Map(
    mappingTraces.map((trace) => [trace.semantic_column_mapping_id, trace]),
  );
  const nonResolved = input.records.filter((record) =>
    record.material && record.resolution !== 'resolved');
  const baselineById = new Map(
    (input.baselineRecords ?? []).map((record) => [stableRecordKey(record), record]),
  );
  const traces = nonResolved.map((record) => {
    const mappingId = record.generic_fields
      .map((field) => field.semantic_mapping_evidence?.mapping_id)
      .find((id): id is string => id != null) ?? null;
    const mappingTrace = mappingId ? mappingTraceById.get(mappingId) ?? null : null;
    const classification = classifyRecord(record, mappingTrace);
    return {
      material_record_id: record.id,
      ledger_role: record.ledger?.interpreted_field_or_role ?? null,
      expected_text: record.ledger?.exact_raw_text ?? null,
      reconstructed_value:
        record.reconstruction_comparison?.reconstructed_raw_text ?? null,
      exact_reconstruction:
        record.reconstruction_comparison?.exact_equal ?? false,
      source_page: record.ledger?.source_page
        ?? record.generic_fields[0]?.source_page ?? null,
      source_bounding_box: record.ledger ? {
        x0: record.ledger.bbox_x0,
        y0: record.ledger.bbox_y0,
        x1: record.ledger.bbox_x1,
        y1: record.ledger.bbox_y1,
        coordinate_space: 'page_points',
      } : null,
      raw_span: record.ledger?.exact_raw_text ?? null,
      verified_field_ids: record.generic_fields.map(({ verified_field_id }) =>
        verified_field_id),
      cell_ids: record.generic_fields.map(({ table_cell_id }) => table_cell_id),
      logical_row_ids: record.generic_fields.map(({ table_row_id }) => table_row_id),
      segment_ids: record.generic_fields.map(({ table_segment_id }) => table_segment_id),
      field_paths: record.generic_fields.map((field) =>
        fieldPath(field, cells, rows, segments, chainsBySegment, input.run.graph.tableSections)),
      semantic_column_mapping_id: mappingId,
      semantic_mapping: mappingTrace,
      evaluator_classification: record.classification,
      evaluator_resolution: record.resolution,
      evaluator_role_contract: record.semantic_role_comparison,
      earliest_stage_preventing_resolution: classification.primary_cause,
      cause_detail: classification.cause_detail,
      correct_role_ambiguity_audit_class: classification.audit_class,
    };
  });
  const ambiguousMappings = mappingTraces.filter(({ final_mapping_status }) =>
    final_mapping_status === 'ambiguous');
  const conjunctFailures = ambiguousMappings.flatMap((mapping) =>
    mapping.resolution_conjuncts
      .filter(({ passed }) => !passed)
      .map(({ name }) => name));
  const affectedCounts = countBy(traces.map(({ earliest_stage_preventing_resolution }) =>
    earliest_stage_preventing_resolution));
  const transitions = input.records.flatMap((record) => {
    if (!record.material) return [];
    const prior = baselineById.get(stableRecordKey(record));
    if (!prior || (
      prior.resolution === record.resolution
      && prior.classification === record.classification
      && prior.reconstruction_comparison?.exact_equal
        === record.reconstruction_comparison?.exact_equal
    )) return [];
    const selectedRoles = record.generic_fields.map((field) => ({
      verified_field_id: field.verified_field_id,
      selected_role: field.semantic_mapping_evidence?.selected_role ?? null,
      mapping_status: field.semantic_status,
      mapping_id: field.semantic_mapping_evidence?.mapping_id ?? null,
      resolution_basis:
        field.semantic_mapping_evidence?.selected_role == null
          ? 'ambiguous' : 'header',
      top_score:
        field.semantic_mapping_evidence?.assessment.candidate_roles[0]?.score
          ?? null,
      runner_up_role:
        field.semantic_mapping_evidence?.assessment.candidate_roles[1]?.role
          ?? null,
      runner_up_score:
        field.semantic_mapping_evidence?.assessment.candidate_roles[1]?.score
          ?? null,
      margin:
        field.semantic_mapping_evidence?.assessment.resolution_policy
          .observed_margin ?? null,
      decisive_evidence:
        field.semantic_mapping_evidence?.assessment.candidate_roles[0]?.evidence ?? [],
      source_evidence:
        field.semantic_mapping_evidence?.assessment.source_evidence ?? [],
    }));
    const acceptableRoles = acceptedRoles(record);
    const correct = record.resolution !== 'resolved'
      || (
        selectedRoles.length === 1
        && selectedRoles[0]?.mapping_status === 'resolved'
        && selectedRoles[0].selected_role != null
        && acceptableRoles.includes(selectedRoles[0].selected_role)
      );
    return [{
      material_record_id: record.id,
      stable_record_key: stableRecordKey(record),
      baseline_material_record_id: prior.id,
      ledger_role: record.ledger?.interpreted_field_or_role ?? null,
      old_state: prior.resolution,
      new_state: record.resolution,
      old_classification: prior.classification,
      new_classification: record.classification,
      old_exact: prior.reconstruction_comparison?.exact_equal ?? null,
      new_exact: record.reconstruction_comparison?.exact_equal ?? null,
      selected_roles: selectedRoles,
      acceptable_roles: acceptableRoles,
      correct,
    }];
  });
  const checkpoint = input.checkpoint ?? 'part-a';
  const interpretationChanged = checkpoint.startsWith('part-c')
    || checkpoint === 'final';
  const extractionChanged = checkpoint.startsWith('part-b')
    || checkpoint.startsWith('part-d')
    || checkpoint === 'final';
  const resolvedMappings = mappings.filter(({ status }) => status === 'resolved');
  const peerEvidence = mappings.flatMap((mapping) =>
    mapping.peer_header_evidence ?? []);
  const rejectedPeerCandidates = mappings.flatMap((mapping) =>
    mapping.peer_header_scope_rejections ?? []);
  const resolvedWith = (
    predicate: (
      evidence: NonNullable<MappingRecord['peer_header_evidence']>[number],
    ) => boolean,
  ) => resolvedMappings.filter((mapping) =>
    (mapping.peer_header_evidence ?? []).some(predicate)).length;
  const resolvedOwnOnly = resolvedMappings.filter((mapping) => {
    const evidence = mapping.peer_header_evidence ?? [];
    return evidence.length > 0
      && evidence.every(({ scope_classification }) =>
        scope_classification === 'target_segment');
  }).length;
  return {
    checkpoint_version: `phase1-v1.14.0-${checkpoint}`,
    checkpoint_kind: checkpoint === 'part-a'
      ? 'source_header_existence_diagnosis_only'
      : checkpoint.startsWith('part-b')
        ? 'header_recovery_measurement'
        : checkpoint.startsWith('part-c')
          ? 'headerless_interpretation_measurement'
          : 'reconstruction_measurement',
    shadow_only: true,
    baseline_report_version: input.baselineReportVersion,
    source_sha256: input.run.source_sha256,
    implementation_build: input.run.implementation_build,
    parser_manifest_hash: input.run.graph.snapshot.parser_manifest_hash,
    interpretation_manifest_hash:
      input.run.fields[0]?.interpretation_manifest_hash ?? null,
    invariant_boundaries: {
      interpretation_results_changed: interpretationChanged,
      evaluator_contract_changed: false,
      extraction_results_changed: extractionChanged,
    },
    source_header_existence: sourceHeaderAudit,
    metrics: {
      exact_reconstruction: input.records.filter((record) =>
        record.material && record.reconstruction_comparison?.exact_equal).length,
      non_exact_single_field: input.records.filter((record) =>
        record.material
        && record.reconstruction_comparison?.exact_equal === false
        && record.generic_fields.length === 1).length,
      non_exact_split_merge: input.records.filter((record) =>
        record.material
        && record.reconstruction_comparison?.exact_equal === false
        && record.generic_fields.length !== 1).length,
      missing_dependencies: input.records.filter((record) =>
        record.material
        && record.ledger != null
        && record.generic_fields.length === 0).length,
      resolved: input.records.filter((record) =>
        record.material && record.resolution === 'resolved').length,
      unresolved: input.records.filter((record) =>
        record.material && record.resolution === 'unresolved').length,
      semantic_review: input.records.filter((record) =>
        record.material && record.resolution === 'requires_semantic_review').length,
    },
    transition_composition: {
      changed_record_ids: transitions.map(({ material_record_id }) => material_record_id),
      unchanged_record_count:
        input.records.filter((record) => record.material).length - transitions.length,
      records: transitions,
      counts: countBy(transitions.map((transition) =>
        `${transition.old_state}_to_${transition.new_state}`)),
    },
    false_positive_audit: {
      true_resolutions: transitions.filter((transition) =>
        transition.new_state === 'resolved' && transition.correct).length,
      false_resolutions: transitions.filter((transition) =>
        transition.new_state === 'resolved' && !transition.correct).length,
      role_changes: transitions.filter((transition) =>
        transition.old_state === 'resolved'
        && transition.new_state === 'resolved').length,
      newly_ambiguous: transitions.filter((transition) =>
        transition.old_state === 'resolved'
        && transition.new_state === 'requires_semantic_review').length,
      unchanged_ambiguities:
        input.records.filter((record) =>
          record.material
          && record.resolution === 'requires_semantic_review'
          && baselineById.get(stableRecordKey(record))?.resolution
            === 'requires_semantic_review').length,
    },
    peer_header_scope_audit: {
      mappings_resolved_using_only_own_header: resolvedOwnOnly,
      mappings_resolved_using_same_chain_peer_header: resolvedWith((evidence) =>
        evidence.scope_classification === 'same_table_chain'
        && evidence.decisive),
      mappings_resolved_using_explicit_linked_continuation_peer:
        resolvedWith((evidence) =>
          evidence.scope_classification === 'explicit_linked_continuation'
          && evidence.decisive),
      mappings_resolved_using_peer_outside_chain_and_linked_scope:
        resolvedWith((evidence) =>
          evidence.scope_classification
            === 'outside_chain_and_linked_continuation_scope'),
      mappings_for_which_out_of_chain_peer_was_decisive:
        resolvedWith((evidence) =>
          evidence.scope_classification
            === 'outside_chain_and_linked_continuation_scope'
          && evidence.decisive),
      mappings_for_which_out_of_chain_peer_was_retained_but_not_decisive:
        resolvedWith((evidence) =>
          evidence.scope_classification
            === 'outside_chain_and_linked_continuation_scope'
          && !evidence.decisive),
      evidence_item_count: peerEvidence.length,
      scope_rejection_count: rejectedPeerCandidates.length,
      evidence_items: peerEvidence,
      scope_rejections: rejectedPeerCandidates,
    },
    segment_semantic_inventory: input.run.graph.tableSegments.map((segment) => ({
      segment_id: segment.id,
      page: segment.page,
      source_bounding_box: segment.bounding_box,
      chain_id: chainsBySegment.get(segment.id)?.id ?? null,
      columns: [...segment.column_hypotheses]
        .sort((left, right) =>
          left.x0 - right.x0 || left.x1 - right.x1 || left.index - right.index)
        .map((column, position) => ({
          position,
          column_index: column.index,
          x0: column.x0,
          x1: column.x1,
          center: (column.x0 + column.x1) / 2,
          observed_header_text: column.header.observed_text,
          normalized_header_text: column.header.observed_text == null
            ? null : normalizeHeader(column.header.observed_text),
          header_fragment_ids: column.header.fragment_ids,
          body_value_kinds: column.value_kind_hypotheses.map((hypothesis) => ({
            kind: hypothesis.kind,
            support: hypothesis.measurement.value,
          })),
        })),
    })),
    remaining_reconstruction_diagnostics:
      reconstructionDefectDiagnostics(input.run, input.records),
    non_resolved_record_count: traces.length,
    non_resolved_record_traces: traces,
    ambiguous_semantic_mapping_count: ambiguousMappings.length,
    ambiguous_semantic_mappings: ambiguousMappings,
    cause_distribution: affectedCounts,
    conjunct_failure_distribution: countBy(conjunctFailures),
    correct_role_versus_genuine_ambiguity_split: countBy(
      traces.map(({ correct_role_ambiguity_audit_class }) =>
        correct_role_ambiguity_audit_class)),
    missing_diagnostic_edges: traces.flatMap((trace) => {
      const missing = [];
      if (trace.field_paths.some(({ chain_id }) => chain_id == null)) {
        missing.push({ material_record_id: trace.material_record_id, edge: 'segment_to_chain' });
      }
      if (trace.field_paths.some(({ section_id }) => section_id == null)) {
        missing.push({ material_record_id: trace.material_record_id, edge: 'row_to_section' });
      }
      return missing;
    }),
    recommended_mechanisms_ranked_by_affected_record_count:
      Object.entries(affectedCounts)
        .map(([cause, affected_record_count]) => ({ cause, affected_record_count }))
        .sort((left, right) =>
          right.affected_record_count - left.affected_record_count
          || left.cause.localeCompare(right.cause)),
  };
}
