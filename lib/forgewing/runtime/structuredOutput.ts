import { z } from 'zod';

import {
  ForgewingColumnMappingRationaleCodeSchema,
  ForgewingMissingEvidenceCodeSchema,
  ForgewingObservationArbitrationRationaleCodeSchema,
  ForgewingObservationArbitrationRelationSchema,
  ForgewingProposedSemanticColumnRoleSchema,
  ForgewingRegionLabelSchema,
  ForgewingTableContinuationRationaleCodeSchema,
} from '@/lib/forgewing/proposal/schema';

const evidenceIds = (minimum: number, maximum?: number) => z.array(z.string().min(1).max(200))
  .min(minimum)
  .max(maximum ?? 200)
  .refine((ids) => new Set(ids).size === ids.length, 'evidence IDs must be distinct');

const common = {
  confidence: z.number().min(0).max(1).nullable(),
  rationale: z.string().min(1).max(400).optional(),
} as const;

const observationArbitrationCommon = {
  confidence: z.number().min(0).max(1).nullable(),
  rationaleCodes: z.array(ForgewingObservationArbitrationRationaleCodeSchema)
    .min(1)
    .max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
} as const;

export const ObservationArbitrationModelOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('inferred'),
    relation: ForgewingObservationArbitrationRelationSchema,
    preferredCandidateId: z.string().min(1).max(200).optional(),
    evidenceIds: evidenceIds(2, 2),
    ...observationArbitrationCommon,
  }).strict(),
  z.object({
    state: z.literal('insufficient_evidence'),
    confidence: z.null(),
    evidenceIds: evidenceIds(0, 0),
    missingEvidence: z.array(ForgewingMissingEvidenceCodeSchema).min(1).max(6),
    rationaleCodes: z.array(ForgewingObservationArbitrationRationaleCodeSchema)
      .min(1)
      .max(4)
      .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
  }).strict(),
]);

export type ObservationArbitrationModelOutput = z.infer<
  typeof ObservationArbitrationModelOutputSchema
>;

export function parseObservationArbitrationModelOutput(
  raw: string,
): ObservationArbitrationModelOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_model_json');
  }
  const parsed = ObservationArbitrationModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

const OBSERVATION_ARBITRATION_RELATIONS = [
  'prefer_candidate_a',
  'prefer_candidate_b',
  'preserve_both',
  'genuinely_conflicting',
] as const;

const OBSERVATION_ARBITRATION_RATIONALES = [
  'text_completeness_difference',
  'ocr_corruption_detected',
  'geometry_consistent',
  'geometry_conflict',
  'value_conflict',
  'complementary_fragments',
  'candidate_contains_other',
  'source_quality_difference',
  'mixed_evidence',
  'insufficient_structure',
  'unresolvable_conflict',
] as const;

export const OBSERVATION_ARBITRATION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'evidenceIds', 'confidence', 'rationaleCodes'],
  properties: {
    state: { type: 'string', enum: ['inferred', 'insufficient_evidence'] },
    relation: { type: 'string', enum: OBSERVATION_ARBITRATION_RELATIONS },
    preferredCandidateId: { type: 'string' },
    evidenceIds: {
      type: 'array',
      maxItems: 2,
      uniqueItems: true,
      items: { type: 'string' },
    },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    rationaleCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { type: 'string', enum: OBSERVATION_ARBITRATION_RATIONALES },
    },
    missingEvidence: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [
          'missing_source_observation',
          'missing_physical_page_proof',
          'insufficient_table_context',
          'conflicting_observations',
          'missing_column_context',
          'truncated_input',
        ],
      },
    },
  },
} as const;

export const RegionClassificationModelOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['observed', 'inferred']),
    classification: ForgewingRegionLabelSchema,
    evidenceIds: evidenceIds(1),
    ...common,
  }).strict(),
  z.object({
    state: z.enum(['ambiguous', 'conflicting']),
    evidenceIds: evidenceIds(2),
    ...common,
  }).strict(),
  z.object({
    state: z.literal('unresolved'),
    evidenceIds: evidenceIds(1),
    ...common,
  }).strict(),
  z.object({
    state: z.literal('insufficient_evidence'),
    evidenceIds: evidenceIds(0, 0),
    missingEvidence: z.array(ForgewingMissingEvidenceCodeSchema).min(1).max(6),
    ...common,
  }).strict(),
]);

export type RegionClassificationModelOutput = z.infer<
  typeof RegionClassificationModelOutputSchema
>;

export function parseRegionClassificationModelOutput(
  raw: string,
): RegionClassificationModelOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_model_json');
  }
  const parsed = RegionClassificationModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

export const REGION_CLASSIFICATION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'evidenceIds', 'confidence'],
  properties: {
    state: {
      type: 'string',
      enum: ['observed', 'inferred', 'ambiguous', 'unresolved', 'conflicting', 'insufficient_evidence'],
    },
    classification: {
      type: 'string',
      enum: ['table', 'prose', 'header', 'footnote', 'rate_schedule', 'continuation', 'signature_block', 'unknown'],
    },
    evidenceIds: { type: 'array', items: { type: 'string' } },
    confidence: { type: ['number', 'null'] },
    rationale: { type: 'string' },
    missingEvidence: {
      type: 'array',
      items: {
        type: 'string',
        enum: [
          'missing_source_observation',
          'missing_physical_page_proof',
          'insufficient_table_context',
          'conflicting_observations',
          'missing_column_context',
          'truncated_input',
        ],
      },
    },
  },
} as const;

const continuationCommon = {
  confidence: z.number().min(0).max(1).nullable(),
  rationaleCode: ForgewingTableContinuationRationaleCodeSchema,
} as const;

export const TableContinuationModelOutputSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.enum(['observed', 'inferred']),
    relation: z.enum(['same_table', 'separate_tables']),
    evidenceIds: evidenceIds(2, 60),
    ...continuationCommon,
  }).strict(),
  z.object({
    state: z.literal('ambiguous'),
    relation: z.literal('ambiguous'),
    evidenceIds: evidenceIds(2, 60),
    ...continuationCommon,
  }).strict(),
  z.object({
    state: z.literal('insufficient_evidence'),
    evidenceIds: evidenceIds(0, 0),
    missingEvidence: z.array(ForgewingMissingEvidenceCodeSchema).min(1).max(6),
    ...continuationCommon,
  }).strict(),
]);

export type TableContinuationModelOutput = z.infer<
  typeof TableContinuationModelOutputSchema
>;

export function parseTableContinuationModelOutput(
  raw: string,
): TableContinuationModelOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_model_json');
  }
  const parsed = TableContinuationModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

export const TABLE_CONTINUATION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'evidenceIds', 'confidence', 'rationaleCode'],
  properties: {
    state: {
      type: 'string',
      enum: ['observed', 'inferred', 'ambiguous', 'insufficient_evidence'],
    },
    relation: {
      type: 'string',
      enum: ['same_table', 'separate_tables', 'ambiguous'],
    },
    evidenceIds: {
      type: 'array',
      maxItems: 60,
      uniqueItems: true,
      items: { type: 'string' },
    },
    confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    rationaleCode: {
      type: 'string',
      enum: [
        'repeated_header_consistent',
        'column_structure_consistent',
        'row_sequence_continues',
        'prior_row_incomplete',
        'next_page_header_restart',
        'title_reset',
        'column_semantics_changed',
        'schema_changed',
        'section_break_detected',
        'mixed_evidence',
        'insufficient_structure',
      ],
    },
    missingEvidence: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: [
          'missing_source_observation',
          'missing_physical_page_proof',
          'insufficient_table_context',
          'conflicting_observations',
          'missing_column_context',
          'truncated_input',
        ],
      },
    },
  },
} as const;

const columnMappingCommon = {
  columnId: z.string().min(1).max(200),
  columnIndex: z.number().int().nonnegative().max(10_000),
  confidence: z.number().min(0).max(1).nullable(),
  rationaleCodes: z.array(ForgewingColumnMappingRationaleCodeSchema)
    .min(1)
    .max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
} as const;

const ColumnMappingModelEntrySchema = z.discriminatedUnion('state', [
  z.object({
    ...columnMappingCommon,
    state: z.literal('observed'),
    proposedRole: ForgewingProposedSemanticColumnRoleSchema,
    evidenceIds: evidenceIds(1, 96),
  }).strict(),
  z.object({
    ...columnMappingCommon,
    state: z.literal('inferred'),
    proposedRole: ForgewingProposedSemanticColumnRoleSchema,
    evidenceIds: evidenceIds(1, 96),
  }).strict(),
  z.object({
    ...columnMappingCommon,
    state: z.literal('ambiguous'),
    candidateRoles: z.array(ForgewingProposedSemanticColumnRoleSchema)
      .min(1)
      .max(12)
      .refine((roles) => new Set(roles).size === roles.length, 'candidate roles must be distinct'),
    evidenceIds: evidenceIds(2, 96),
  }).strict(),
  z.object({
    ...columnMappingCommon,
    state: z.literal('insufficient_evidence'),
    confidence: z.null(),
    evidenceIds: evidenceIds(0, 0),
    missingEvidence: z.array(ForgewingMissingEvidenceCodeSchema).min(1).max(6),
  }).strict(),
]);

export const ColumnMappingModelOutputSchema = z.object({
  columnMappings: z.array(ColumnMappingModelEntrySchema)
    .min(1)
    .max(12)
    .refine(
      (mappings) => new Set(mappings.map(({ columnId }) => columnId)).size === mappings.length
        && new Set(mappings.map(({ columnIndex }) => columnIndex)).size === mappings.length,
      'column mapping identities and indices must be distinct',
    ),
}).strict();

export type ColumnMappingModelOutput = z.infer<typeof ColumnMappingModelOutputSchema>;

export function parseColumnMappingModelOutput(raw: string): ColumnMappingModelOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_model_json');
  }
  const parsed = ColumnMappingModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

const COLUMN_MAPPING_ROLE_VALUES = [
  'description',
  'row_label',
  'quantity',
  'unit',
  'rate',
  'extension',
  'origin',
  'destination',
  'origin_destination',
  'category',
  'code',
  'identifier',
] as const;

const COLUMN_MAPPING_RATIONALE_VALUES = [
  'header_semantics',
  'currency_pattern',
  'unit_pattern',
  'numeric_rate_pattern',
  'description_text_pattern',
  'category_repetition',
  'code_pattern',
  'neighboring_column_context',
  'mixed_evidence',
  'insufficient_structure',
] as const;

export const COLUMN_MAPPING_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['columnMappings'],
  properties: {
    columnMappings: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'columnId',
          'columnIndex',
          'state',
          'confidence',
          'rationaleCodes',
          'evidenceIds',
        ],
        properties: {
          columnId: { type: 'string' },
          columnIndex: { type: 'integer', minimum: 0, maximum: 10_000 },
          state: {
            type: 'string',
            enum: ['observed', 'inferred', 'ambiguous', 'insufficient_evidence'],
          },
          proposedRole: { type: 'string', enum: COLUMN_MAPPING_ROLE_VALUES },
          candidateRoles: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            uniqueItems: true,
            items: { type: 'string', enum: COLUMN_MAPPING_ROLE_VALUES },
          },
          confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 },
          rationaleCodes: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            uniqueItems: true,
            items: { type: 'string', enum: COLUMN_MAPPING_RATIONALE_VALUES },
          },
          evidenceIds: {
            type: 'array',
            maxItems: 96,
            uniqueItems: true,
            items: { type: 'string' },
          },
          missingEvidence: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            uniqueItems: true,
            items: {
              type: 'string',
              enum: [
                'missing_source_observation',
                'missing_physical_page_proof',
                'insufficient_table_context',
                'conflicting_observations',
                'missing_column_context',
                'truncated_input',
              ],
            },
          },
        },
      },
    },
  },
} as const;
