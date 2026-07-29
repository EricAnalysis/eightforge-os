import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  ConfidenceComponent,
  FragmentArtifactId,
  GridCellArtifact,
  NonEmpty,
  TableChainArtifact,
  TableSegmentArtifact,
  TableValueKind,
  VerifiedFieldId,
} from '@/lib/extraction/domain/types';
import { VerifiedFieldHandle } from '@/lib/extraction/domain/verifiedField';

export type SemanticColumnRole =
  | 'description'
  | 'row_label'
  | 'quantity'
  | 'unit'
  | 'rate'
  | 'extension'
  | 'origin'
  | 'destination'
  | 'origin_destination'
  | 'category'
  | 'code'
  | 'identifier'
  | 'other';

export interface SemanticRoleCandidate {
  readonly role: Exclude<SemanticColumnRole, 'other'>;
  readonly score: number;
  readonly evidence: readonly string[];
  readonly verified_field_ids: readonly VerifiedFieldId[];
  readonly dependency_hashes: readonly string[];
}

export interface InterpretationAssessment {
  readonly version: 'interpretation-confidence-v2';
  readonly verified_field_ids: NonEmpty<VerifiedFieldId>;
  readonly header_role: ConfidenceComponent;
  readonly arithmetic_consistency: ConfidenceComponent;
  readonly candidate_roles: readonly SemanticRoleCandidate[];
  readonly selected_role: SemanticColumnRole | null;
  readonly resolution_policy: {
    readonly minimum_score: number;
    readonly minimum_margin: number;
    readonly observed_top_score: number;
    readonly observed_margin: number;
  };
  readonly source_evidence: readonly {
    readonly verified_field_id: VerifiedFieldId;
    readonly raw_text: string;
    readonly source_fragment_ids: readonly string[];
    readonly page: number;
    readonly bounding_box: TableSegmentArtifact['bounding_box'];
    readonly dependency_hash: string;
  }[];
  readonly source_region: {
    readonly page: number;
    readonly bounding_box: TableSegmentArtifact['bounding_box'];
  };
  readonly uncertainties: readonly (
    | 'ambiguous_column_role'
    | 'arithmetic_mismatch'
  )[];
}

export const SEMANTIC_COLUMN_RULES = {
  'observed-column-evidence-v2': {
    version: '2',
    minimumScore: 0.7,
    minimumMargin: 0.2,
    crossPageColumnCenterTolerance: 0.04,
    headerAliases: {
      description: ['description', 'item description', 'work description', 'service'],
      row_label: ['row', 'row label', 'row number', 'line', 'line number', 'line no'],
      quantity: ['quantity', 'qty', 'estimated quantity'],
      unit: ['unit', 'uom', 'unit of measure'],
      rate: ['rate', 'unit price', 'unit rate', 'unit cost', 'price', 'cost'],
      extension: ['extension', 'extended cost', 'extended amount', 'amount', 'total amount'],
      origin: ['origin', 'from', 'source'],
      destination: ['destination', 'to'],
      origin_destination: [
        'origin destination',
        'origin and destination',
        'from to',
        'source destination',
      ],
      category: ['category', 'class', 'type'],
      code: ['code', 'item code', 'service code'],
      identifier: ['item', 'item no', 'item number', 'identifier', 'id'],
    } satisfies Record<Exclude<SemanticColumnRole, 'other'>, readonly string[]>,
    compatibleKinds: {
      description: ['free_text'],
      row_label: ['identifier', 'integer', 'free_text'],
      quantity: ['integer', 'decimal'],
      unit: ['unit_token', 'free_text'],
      rate: ['currency', 'decimal'],
      extension: ['currency', 'decimal'],
      origin: ['free_text', 'identifier', 'unit_token'],
      destination: ['free_text', 'identifier', 'unit_token'],
      origin_destination: ['free_text', 'identifier', 'unit_token'],
      category: ['identifier', 'unit_token', 'free_text'],
      code: ['identifier', 'integer', 'free_text'],
      identifier: ['identifier', 'integer', 'free_text'],
      other: ['unknown', 'boolean_like', 'date_like', 'free_text'],
    } satisfies Record<SemanticColumnRole, readonly TableValueKind[]>,
    unitVocabulary: [
      'ea', 'each', 'hr', 'hour', 'day', 'ls', 'lump sum', 'cy', 'cyd', 'sy',
      'syd', 'lf', 'ft', 'sf', 'ton', 'mile', 'mi', 'gal', 'acre', 'mo', 'month',
    ],
  },
} as const;

export type SemanticColumnRuleId = keyof typeof SEMANTIC_COLUMN_RULES;

export const SEMANTIC_COLUMN_INTERPRETER_MANIFEST = Object.freeze({
  name: 'semantic-column-role-interpreter',
  version: SEMANTIC_COLUMN_RULES['observed-column-evidence-v2'].version,
  configuration_hash: hashCanonical(SEMANTIC_COLUMN_RULES),
});

type MappingEvidence = {
  readonly headerFields: readonly VerifiedFieldHandle[];
  readonly cellFields: NonEmpty<VerifiedFieldHandle>;
  readonly sourceCells?: readonly GridCellArtifact[];
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
    for (const candidate of this.assessment.candidate_roles) {
      Object.freeze(candidate.evidence);
      Object.freeze(candidate.verified_field_ids);
      Object.freeze(candidate.dependency_hashes);
      Object.freeze(candidate);
    }
    for (const evidence of this.assessment.source_evidence) {
      Object.freeze(evidence.source_fragment_ids);
      Object.freeze(evidence.bounding_box);
      Object.freeze(evidence);
    }
    Object.freeze(this.assessment.candidate_roles);
    Object.freeze(this.assessment.source_evidence);
    Object.freeze(this.assessment.resolution_policy);
    Object.freeze(this.assessment.source_region);
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
    const conflictingCellValues = hasConflictingValuesPerCandidate(
      input.evidence.cellFields,
    );
    const candidates = scoreColumnRoles({
      rule,
      segment: input.segment,
      columnIndex: input.columnIndex,
      headerFields: input.evidence.headerFields,
      cellFields: input.evidence.cellFields,
    });
    const top = candidates[0];
    const runnerUp = candidates[1];
    const observedTopScore = top?.score ?? 0;
    const observedMargin = Number(
      (observedTopScore - (runnerUp?.score ?? 0)).toFixed(6),
    );
    const exactHeaderRoleCount = candidates.filter((candidate) =>
      candidate.evidence.some((item) => item.startsWith('header_exact_alias:'))).length;
    const resolved = !conflictingCellValues
      && exactHeaderRoleCount <= 1
      && top != null
      && observedTopScore >= rule.minimumScore
      && observedMargin >= rule.minimumMargin;
    const headerBasis = input.evidence.headerFields
      .flatMap((handle) => handle.field.source_fragment_ids)
      .map((id) => id as FragmentArtifactId);
    const topHasHeaderEvidence = top?.evidence.some((item) =>
      item.startsWith('header_')) ?? false;
    const headerRole: ConfidenceComponent =
      !conflictingCellValues && topHasHeaderEvidence && headerBasis[0] != null
      ? {
          state: 'observed',
          score: Math.min(1, observedTopScore),
          basis_artifact_ids: [headerBasis[0], ...headerBasis.slice(1)],
          diagnostics: top?.evidence.filter((item) => item.startsWith('header_')) ?? [],
        }
      : {
          state: 'not_available',
          score: null,
          basis_artifact_ids: [],
          diagnostics: conflictingCellValues
            ? ['conflicting_verified_fields_for_column_cell']
            : ['no_supported_observed_header_evidence'],
        };
    const sourceEvidence = [...input.evidence.headerFields, ...input.evidence.cellFields]
      .map((handle) => {
        const cell = input.evidence.sourceCells?.find((candidate) =>
          handle.field.source_fragment_ids.includes(candidate.id));
        return {
          verified_field_id: handle.field.id,
          raw_text: handle.field.raw_text,
          source_fragment_ids: [...handle.field.source_fragment_ids],
          page: cell?.page ?? input.segment.page,
          bounding_box: {
            ...(cell?.bounding_box ?? input.segment.bounding_box),
          },
          dependency_hash: hashCanonical({
            verified_field_id: handle.field.id,
            source_fragment_ids: handle.field.source_fragment_ids,
            raw_text: handle.field.raw_text,
            normalized_value: handle.field.normalized_value,
          }),
        };
      });
    const assessment: InterpretationAssessment = {
      version: 'interpretation-confidence-v2',
      verified_field_ids: allIds,
      header_role: headerRole,
      arithmetic_consistency: {
        state: 'not_applicable',
        score: null,
        basis_artifact_ids: [],
        diagnostics: ['column_role_assignment_does_not_calculate_values'],
      },
      candidate_roles: candidates,
      selected_role: resolved && top ? top.role : null,
      resolution_policy: {
        minimum_score: rule.minimumScore,
        minimum_margin: rule.minimumMargin,
        observed_top_score: observedTopScore,
        observed_margin: observedMargin,
      },
      source_evidence: sourceEvidence,
      source_region: {
        page: input.segment.page,
        bounding_box: input.segment.bounding_box,
      },
      uncertainties: resolved ? [] : ['ambiguous_column_role'],
    };
    const domainRole = resolved && top ? top.role : 'other';
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
  return value.normalize('NFKC').trim().toLowerCase()
    .replace(/[/_&-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type ColumnRule = typeof SEMANTIC_COLUMN_RULES[SemanticColumnRuleId];
type SupportedRole = Exclude<SemanticColumnRole, 'other'>;

function scoreColumnRoles(input: {
  readonly rule: ColumnRule;
  readonly segment: TableSegmentArtifact;
  readonly columnIndex: number;
  readonly headerFields: readonly VerifiedFieldHandle[];
  readonly cellFields: NonEmpty<VerifiedFieldHandle>;
}): SemanticRoleCandidate[] {
  const column = input.segment.column_hypotheses.find(
    ({ index }) => index === input.columnIndex,
  );
  if (!column) return [];
  const roles = Object.keys(input.rule.headerAliases) as SupportedRole[];
  const scores = new Map<SupportedRole, {
    score: number;
    evidence: string[];
  }>(roles.map((role) => [role, { score: 0, evidence: [] }]));
  const add = (role: SupportedRole, amount: number, evidence: string) => {
    const current = scores.get(role);
    if (!current || current.evidence.includes(evidence)) return;
    current.score += amount;
    current.evidence.push(evidence);
  };
  const observedHeaderValues = input.headerFields
    .map((handle) => handle.field.raw_text)
    .filter(Boolean);
  const normalizedHeaders = [
    ...observedHeaderValues.map(normalizeHeader),
    ...(observedHeaderValues.length > 1
      ? [normalizeHeader(observedHeaderValues.join(' '))]
      : []),
  ];
  for (const header of normalizedHeaders) {
    const exactRoles = roles.filter((role) =>
      input.rule.headerAliases[role].includes(header));
    for (const role of roles) {
      const aliases = input.rule.headerAliases[role];
      if (aliases.includes(header)) {
        add(role, 0.75, `header_exact_alias:${header}`);
        continue;
      }
      if (exactRoles.length > 0) continue;
      const contained = aliases.find((alias) =>
        alias.length >= 3 && (` ${header} `).includes(` ${alias} `));
      if (contained) add(role, 0.55, `header_phrase_alias:${contained}`);
    }
  }

  for (const role of roles) {
    const compatible = input.rule.compatibleKinds[role] as readonly TableValueKind[];
    const support = Math.max(0, ...column.value_kind_hypotheses
      .filter(({ kind }) => compatible.includes(kind))
      .map(({ measurement }) => measurement.value));
    if (support > 0) add(role, 0.25 * support, `body_value_kind:${support.toFixed(3)}`);
  }

  const normalizedCells = input.cellFields.map((handle) =>
    normalizeHeader(handle.field.raw_text));
  const unitRatio = normalizedCells.filter((value) =>
    (input.rule.unitVocabulary as readonly string[]).includes(value)).length
    / normalizedCells.length;
  if (unitRatio >= 0.6) add('unit', 0.45, `body_unit_vocabulary:${unitRatio.toFixed(3)}`);
  const numericLabelRatio = normalizedCells.filter((value) =>
    /^\d+[a-z]?$/.test(value) || /^[a-z]?\d+(?:[.-]\d+)*$/i.test(value)).length
    / normalizedCells.length;
  const columns = [...input.segment.column_hypotheses]
    .sort((left, right) => left.x0 - right.x0 || left.index - right.index);
  const position = columns.findIndex(({ index }) => index === input.columnIndex);
  const width = column.x1 - column.x0;
  const medianWidth = [...columns.map((candidate) => candidate.x1 - candidate.x0)]
    .sort((left, right) => left - right)[Math.floor(columns.length / 2)] ?? width;
  if (position === 0 && numericLabelRatio >= 0.6) {
    add('row_label', 0.45, `leftmost_numeric_label_shape:${numericLabelRatio.toFixed(3)}`);
  }
  if (position === 0 && width <= medianWidth && numericLabelRatio >= 0.4) {
    add('identifier', 0.25, 'leftmost_compact_identifier_column');
  }
  const longTextRatio = normalizedCells.filter((value) =>
    value.length >= 12 || value.includes(' ')).length / normalizedCells.length;
  if (longTextRatio >= 0.6) {
    add('description', 0.25, `repeated_long_text_shape:${longTextRatio.toFixed(3)}`);
  }
  const previous = columns[position - 1];
  const previousKinds = new Set(previous?.value_kind_hypotheses.map(({ kind }) => kind) ?? []);
  if (
    previous
    && (previousKinds.has('unit_token') || previousKinds.has('free_text'))
    && column.value_kind_hypotheses.some(({ kind }) => kind === 'currency' || kind === 'decimal')
  ) {
    add('rate', 0.2, 'numeric_column_neighboring_unit_like_column');
  }
  const priorNumericColumns = columns.slice(0, Math.max(0, position))
    .filter((candidate) => candidate.value_kind_hypotheses.some(({ kind }) =>
      kind === 'integer' || kind === 'decimal' || kind === 'currency')).length;
  if (
    priorNumericColumns >= 2
    && column.value_kind_hypotheses.some(({ kind }) => kind === 'currency')
  ) {
    add('extension', 0.25, 'currency_after_multiple_numeric_columns');
  }

  const verifiedFieldIds = [
    ...input.headerFields.map((handle) => handle.field.id),
    ...input.cellFields.map((handle) => handle.field.id),
  ];
  const dependencyHashes = [...input.headerFields, ...input.cellFields].map((handle) =>
    hashCanonical({
      verified_field_id: handle.field.id,
      source_fragment_ids: handle.field.source_fragment_ids,
    }));
  return [...scores.entries()]
    .map(([role, value]) => ({
      role,
      score: Math.min(1, Number(value.score.toFixed(6))),
      evidence: value.evidence,
      verified_field_ids: verifiedFieldIds,
      dependency_hashes: dependencyHashes,
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) =>
      right.score - left.score || left.role.localeCompare(right.role));
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
