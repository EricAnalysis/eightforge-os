import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  ConfidenceComponent,
  FragmentArtifactId,
  NonEmpty,
  TableChainArtifact,
  TableSegmentArtifact,
  TableValueKind,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';
import { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';

export type SemanticColumnRole =
  | 'description'
  | 'quantity'
  | 'unit'
  | 'rate'
  | 'extension'
  | 'identifier'
  | 'other';

export interface InterpretationAssessment {
  readonly version: 'interpretation-confidence-v1';
  readonly verified_field_ids: NonEmpty<VerifiedFieldId>;
  readonly header_role: ConfidenceComponent;
  readonly arithmetic_consistency: ConfidenceComponent;
  readonly uncertainties: readonly (
    | 'ambiguous_column_role'
    | 'arithmetic_mismatch'
  )[];
}

export const SEMANTIC_COLUMN_RULES = {
  'observed-header-and-value-kind-v1': {
    version: '1',
    headerAliases: {
      description: ['description', 'item description', 'work description', 'service'],
      quantity: ['quantity', 'qty', 'estimated quantity'],
      unit: ['unit', 'uom', 'unit of measure'],
      rate: ['rate', 'unit price', 'unit rate', 'price'],
      extension: ['extension', 'extended cost', 'extended amount', 'amount'],
      identifier: ['item', 'item no', 'item number', 'code', 'identifier'],
    } satisfies Record<Exclude<SemanticColumnRole, 'other'>, readonly string[]>,
    compatibleKinds: {
      description: ['free_text'],
      quantity: ['integer', 'decimal'],
      unit: ['unit_token', 'free_text'],
      rate: ['currency', 'decimal'],
      extension: ['currency', 'decimal'],
      identifier: ['identifier', 'integer', 'free_text'],
      other: ['unknown', 'boolean_like', 'date_like', 'free_text'],
    } satisfies Record<SemanticColumnRole, readonly TableValueKind[]>,
  },
} as const;

export type SemanticColumnRuleId = keyof typeof SEMANTIC_COLUMN_RULES;

export const SEMANTIC_COLUMN_INTERPRETER_MANIFEST = Object.freeze({
  name: 'semantic-column-role-interpreter',
  version: SEMANTIC_COLUMN_RULES['observed-header-and-value-kind-v1'].version,
  configuration_hash: hashCanonical(SEMANTIC_COLUMN_RULES),
});

type MappingEvidence = {
  readonly headerFields: readonly VerifiedFieldHandle[];
  readonly cellFields: NonEmpty<VerifiedFieldHandle>;
};

const semanticColumnMappingConstructorToken: unique symbol =
  Symbol('semanticColumnMappingConstructorToken');

export class SemanticColumnMapping {
  private constructor(
    readonly id: string,
    readonly interpretation_snapshot_id: string,
    readonly table_chain_id: string,
    readonly column_index: number,
    readonly domain_role: SemanticColumnRole,
    readonly header_verified_field_ids: readonly VerifiedFieldId[],
    readonly cell_verified_field_ids: NonEmpty<VerifiedFieldId>,
    readonly assessment: InterpretationAssessment,
    readonly status: 'resolved' | 'ambiguous',
    readonly rule: {
      readonly id: SemanticColumnRuleId;
      readonly version: string;
    },
  ) {
    Object.freeze(this.header_verified_field_ids);
    Object.freeze(this.cell_verified_field_ids);
    Object.freeze(this.assessment.verified_field_ids);
    Object.freeze(this.assessment.uncertainties);
    Object.freeze(this.assessment);
    Object.freeze(this.rule);
    Object.freeze(this);
  }

  static create(input: {
    readonly constructorToken: typeof semanticColumnMappingConstructorToken;
    readonly interpretationSnapshotId: string;
    readonly chain: TableChainArtifact;
    readonly segment: TableSegmentArtifact;
    readonly columnIndex: number;
    readonly evidence: MappingEvidence;
    readonly ruleId: SemanticColumnRuleId;
  }): SemanticColumnMapping {
    if (input.constructorToken !== semanticColumnMappingConstructorToken) {
      throw new Error('SemanticColumnMapping can only be created by its interpretation factory.');
    }
    const rule = SEMANTIC_COLUMN_RULES[input.ruleId];
    const column = input.segment.column_hypotheses.find(
      (candidate) => candidate.index === input.columnIndex,
    );
    if (!column || !input.chain.segment_ids.includes(input.segment.id)) {
      throw new Error('Semantic column evidence must belong to the cited table chain.');
    }
    if (![...input.evidence.headerFields, ...input.evidence.cellFields]
      .every((handle) => handle instanceof VerifiedFieldHandle)) {
      throw new Error('Semantic column mapping requires verified-field handles.');
    }

    const headerIds = input.evidence.headerFields.map((handle) => handle.field.id);
    const cellIds = input.evidence.cellFields.map((handle) => handle.field.id);
    const firstCellId = cellIds[0];
    if (!firstCellId) throw new Error('Semantic column mapping requires cell evidence.');
    const nonEmptyCellIds: NonEmpty<VerifiedFieldId> = [firstCellId, ...cellIds.slice(1)];
    const allIds: NonEmpty<VerifiedFieldId> = headerIds[0] != null
      ? [headerIds[0], ...headerIds.slice(1), ...cellIds]
      : nonEmptyCellIds;
    const observedHeaderValues = input.evidence.headerFields
      .flatMap((handle) => handle.field.normalized_value.type === 'text'
        ? [handle.field.normalized_value.value]
        : []);
    const normalizedHeaders = [
      ...observedHeaderValues.map(normalizeHeader),
      ...(observedHeaderValues.length > 1
        ? [normalizeHeader(observedHeaderValues.join(' '))]
        : []),
    ];
    const headerRoles = new Set<SemanticColumnRole>();
    for (const header of normalizedHeaders) {
      for (const [role, aliases] of Object.entries(rule.headerAliases) as Array<
        [Exclude<SemanticColumnRole, 'other'>, readonly string[]]
      >) {
        if (aliases.includes(header)) headerRoles.add(role);
      }
    }
    const observedKinds = new Set(
      column.value_kind_hypotheses.map((hypothesis) => hypothesis.kind),
    );
    const candidateRole = headerRoles.size === 1
      ? [...headerRoles][0] ?? 'other'
      : 'other';
    const kindCompatible = rule.compatibleKinds[candidateRole]
      .some((kind) => observedKinds.has(kind));
    const conflictingCellValues = hasConflictingValuesPerCandidate(
      input.evidence.cellFields,
    );
    const resolved = headerRoles.size === 1 && kindCompatible && !conflictingCellValues;
    const headerBasis = input.evidence.headerFields
      .flatMap((handle) => handle.field.source_fragment_ids)
      .map((id) => id as FragmentArtifactId);
    const headerRole: ConfidenceComponent = resolved && headerBasis[0] != null
      ? {
          state: 'observed',
          score: 1,
          basis_artifact_ids: [headerBasis[0], ...headerBasis.slice(1)],
          diagnostics: ['exact_versioned_header_alias_and_compatible_value_kind'],
        }
      : {
          state: 'not_available',
          score: null,
          basis_artifact_ids: [],
          diagnostics: conflictingCellValues
            ? ['conflicting_verified_fields_for_column_cell']
            : headerRoles.size > 1
              ? ['conflicting_observed_header_roles']
              : ['unsupported_or_ambiguous_observed_header'],
        };
    const assessment: InterpretationAssessment = {
      version: 'interpretation-confidence-v1',
      verified_field_ids: allIds,
      header_role: headerRole,
      arithmetic_consistency: {
        state: 'not_applicable',
        score: null,
        basis_artifact_ids: [],
        diagnostics: ['column_role_assignment_does_not_calculate_values'],
      },
      uncertainties: resolved ? [] : ['ambiguous_column_role'],
    };
    const domainRole = resolved ? candidateRole : 'other';
    return new SemanticColumnMapping(
      opaqueIds.semanticColumnMapping({
        interpretation_snapshot_id: input.interpretationSnapshotId,
        table_chain_id: input.chain.id,
        column_index: input.columnIndex,
        domain_role: domainRole,
        header_verified_field_ids: headerIds,
        cell_verified_field_ids: nonEmptyCellIds,
        rule_id: input.ruleId,
        rule_version: rule.version,
      }),
      input.interpretationSnapshotId,
      input.chain.id,
      input.columnIndex,
      domainRole,
      Object.freeze([...headerIds]),
      Object.freeze([...nonEmptyCellIds]) as unknown as NonEmpty<VerifiedFieldId>,
      assessment,
      resolved ? 'resolved' : 'ambiguous',
      Object.freeze({ id: input.ruleId, version: rule.version }),
    );
  }
}

function normalizeHeader(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

function hasConflictingValuesPerCandidate(
  handles: NonEmpty<VerifiedFieldHandle>,
): boolean {
  const byFragment = new Map<string, string>();
  for (const handle of handles) {
    const value = hashCanonical(handle.field.normalized_value);
    for (const fragmentId of handle.field.source_fragment_ids) {
      const prior = byFragment.get(fragmentId);
      if (prior != null && prior !== value) return true;
      byFragment.set(fragmentId, value);
    }
  }
  return false;
}

export function createSemanticColumnMapping(input: {
  readonly interpretationSnapshotId: string;
  readonly chain: TableChainArtifact;
  readonly segment: TableSegmentArtifact;
  readonly columnIndex: number;
  readonly evidence: MappingEvidence;
  readonly ruleId: SemanticColumnRuleId;
}): SemanticColumnMapping {
  return SemanticColumnMapping.create({
    ...input,
    constructorToken: semanticColumnMappingConstructorToken,
  });
}
