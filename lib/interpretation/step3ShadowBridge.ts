import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  Step3InterpretationBridge,
  Step3InterpretationBridgePayload,
} from '@/lib/extraction/domain/step3InterpretationBridge';
import type { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';
import {
  SEMANTIC_COLUMN_INTERPRETER_MANIFEST,
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

export const buildStep3SemanticInterpretation: Step3InterpretationBridge =
  async (input): Promise<Step3InterpretationBridgePayload> => {
    const byFragment = handlesByFragment(input.verified_field_handles);
    const interpretationManifestHash = hashCanonical({
      semantic_column_mapping: SEMANTIC_COLUMN_INTERPRETER_MANIFEST,
    });
    const interpretationSnapshotId = opaqueIds.interpretationSnapshot({
      extraction_snapshot_id: input.extraction_snapshot_id,
      interpreter_manifest_hash: interpretationManifestHash,
      entity_resolver_version: 'not-applicable-step3',
    });
    let mappings: Array<ReturnType<typeof createSemanticColumnMapping>>;
    try {
      mappings = input.chains.flatMap((chain) =>
        chain.segment_ids.flatMap((segmentId) => {
          const segment = input.segments.find((candidate) => candidate.id === segmentId);
          if (!segment) return [];
          return segment.column_hypotheses.flatMap((column) => {
            const headerFields = uniqueHandles(
              column.header.fragment_ids.flatMap((id) => byFragment.get(id) ?? []),
            );
            const cellFields = uniqueHandles(
              column.value_kind_hypotheses.flatMap((hypothesis) =>
                hypothesis.measurement.basis_artifact_ids.flatMap(
                  (id) => byFragment.get(id) ?? [],
                )),
            );
            const firstCell = cellFields[0];
            if (!firstCell) return [];
            return [createSemanticColumnMapping({
              interpretationSnapshotId,
              chain,
              segment,
              columnIndex: column.index,
              evidence: {
                headerFields,
                cellFields: [firstCell, ...cellFields.slice(1)],
              },
              ruleId: 'observed-header-and-value-kind-v1',
            })];
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
    const records = mappings.flatMap((mapping, index) => {
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
        status: mappings.some((mapping) => mapping.status === 'ambiguous')
          ? 'partial' : 'complete',
        output_root_hash: outputRootHash,
        published_at: input.published_at,
      },
      semantic_column_mappings: mappings.map((mapping) => ({
        id: mapping.id,
        table_chain_id: mapping.table_chain_id,
        column_index: mapping.column_index,
        domain_role: mapping.domain_role,
        assessment: mapping.assessment,
        status: mapping.status,
        interpretation_rule_id: mapping.rule.id,
        interpretation_rule_version: mapping.rule.version,
        header_verified_field_ids: mapping.header_verified_field_ids,
        cell_verified_field_ids: mapping.cell_verified_field_ids,
      })),
      interpretation_records: records,
    };
  };
