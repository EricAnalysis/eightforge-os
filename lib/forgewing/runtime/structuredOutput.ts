import { z } from 'zod';

import {
  ForgewingColumnMappingRationaleCodeSchema,
  ForgewingMissingEvidenceCodeSchema,
  ForgewingObservationArbitrationRationaleCodeSchema,
  ForgewingObservationArbitrationRelationSchema,
  ForgewingPricingInterpretationRationaleCodeSchema,
  ForgewingPricingSemanticRoleSchema,
  ForgewingProposedSemanticColumnRoleSchema,
  ForgewingRegionLabelSchema,
  ForgewingTableContinuationRationaleCodeSchema,
} from '@/lib/forgewing/proposal/schema';

const evidenceIds = (minimum: number, maximum?: number) => z.array(z.string().min(1).max(200))
  .min(minimum)
  .max(maximum ?? 200)
  .refine((ids) => new Set(ids).size === ids.length, 'evidence IDs must be distinct');

const pricingInterpretationItemSchema = z.object({
  sourceCellId: z.string().min(1).max(200),
  semanticRole: ForgewingPricingSemanticRoleSchema,
  sourceText: z.string().min(1).max(2_000)
    .refine((value) => value.trim().length > 0, 'source text must not be whitespace-only'),
  interpretationState: z.enum(['observed', 'inferred', 'ambiguous', 'conflicting']),
  confidence: z.number().min(0).max(1).nullable(),
  evidenceIds: evidenceIds(1, 16),
  rationaleCodes: z.array(ForgewingPricingInterpretationRationaleCodeSchema)
    .min(1).max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
}).strict();

export const PricingInterpretationModelOutputSchema = z.discriminatedUnion(
  'rowInterpretationState',
  [
    z.object({
      rowInterpretationState: z.enum(['observed', 'inferred', 'ambiguous', 'conflicting']),
      confidence: z.number().min(0).max(1).nullable(),
      interpretations: z.array(pricingInterpretationItemSchema).min(1).max(16),
    }).strict(),
    z.object({
      rowInterpretationState: z.literal('insufficient_evidence'),
      confidence: z.null(),
      interpretations: z.array(pricingInterpretationItemSchema).length(0),
      missingEvidence: z.array(ForgewingMissingEvidenceCodeSchema).min(1).max(6),
    }).strict(),
  ],
).superRefine((output, context) => {
  if (output.rowInterpretationState === 'ambiguous' && output.interpretations.length < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['interpretations'],
      message: 'ambiguous pricing output requires multiple interpretations' });
  }
  if (output.rowInterpretationState === 'conflicting'
    && new Set(output.interpretations.flatMap((item) => item.evidenceIds)).size < 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['interpretations'],
      message: 'conflicting pricing output requires distinct evidence' });
  }
});

export type PricingInterpretationModelOutput = z.infer<
  typeof PricingInterpretationModelOutputSchema
>;

/**
 * Provider-facing conditional rules paired with the strict local union above.
 * Keep this beside the schema so prompt wording cannot silently drift from the
 * accepted field/state combinations.
 */
export const PRICING_INTERPRETATION_CONDITIONAL_FIELD_RULES = `OUTPUT FIELD RULES:
- If rowInterpretationState is "insufficient_evidence", confidence MUST be null, interpretations MUST be [], and missingEvidence MUST be present with at least one allowed value.
- If rowInterpretationState is "observed", "inferred", "ambiguous", or "conflicting", missingEvidence MUST NOT appear in the JSON object at all. Do not emit it as null, [], or an empty string. The property must be omitted.

Compact structural examples:
VALID: {"rowInterpretationState":"ambiguous","confidence":0.5,"interpretations":[...]} (no missingEvidence property)
VALID: {"rowInterpretationState":"insufficient_evidence","confidence":null,"interpretations":[],"missingEvidence":["missing_column_context"]}
INVALID: {"rowInterpretationState":"ambiguous","confidence":0.5,"interpretations":[...],"missingEvidence":["missing_column_context"]}` as const;

export function parsePricingInterpretationModelOutput(
  raw: string,
): PricingInterpretationModelOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('invalid_model_json');
  }
  const parsed = PricingInterpretationModelOutputSchema.safeParse(value);
  if (!parsed.success) throw new Error('model_schema_rejected');
  return parsed.data;
}

const PRICING_INTERPRETATION_ROLE_VALUES = [
  'category_like_text', 'description_like_text', 'unit_like_text', 'rate_like_amount',
  'quantity_like_amount', 'item_number_like_text', 'extended_amount_like_text', 'unknown',
] as const;

const PRICING_INTERPRETATION_RATIONALE_VALUES = [
  'explicit_currency_marker', 'explicit_unit_token', 'header_or_column_context',
  'textual_description_pattern', 'numeric_structure', 'multiple_plausible_roles',
  'incompatible_values', 'missing_semantic_context', 'source_text_only',
] as const;

export const PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rowInterpretationState', 'confidence', 'interpretations'],
  properties: {
    rowInterpretationState: {
      type: 'string',
      enum: ['observed', 'inferred', 'ambiguous', 'conflicting', 'insufficient_evidence'],
    },
    confidence: { type: ['number', 'null'] },
    interpretations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['sourceCellId', 'semanticRole', 'sourceText', 'interpretationState',
          'confidence', 'evidenceIds', 'rationaleCodes'],
        properties: {
          sourceCellId: { type: 'string' },
          semanticRole: { type: 'string', enum: PRICING_INTERPRETATION_ROLE_VALUES },
          sourceText: { type: 'string' },
          interpretationState: { type: 'string', enum: ['observed', 'inferred', 'ambiguous', 'conflicting'] },
          confidence: { type: ['number', 'null'] },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          rationaleCodes: { type: 'array',
            items: { type: 'string', enum: PRICING_INTERPRETATION_RATIONALE_VALUES } },
        },
      },
    },
    missingEvidence: {
      type: 'array',
      items: { type: 'string', enum: [
        'missing_source_observation', 'missing_physical_page_proof',
        'insufficient_table_context', 'conflicting_observations',
        'missing_column_context', 'truncated_input',
      ] },
    },
  },
} as const;

const PRICING_INTERPRETATION_V2_CONTRIBUTION_ROLE_VALUES = [
  'type_marker', 'value_token', 'component_part', 'semantic_head', 'semantic_modifier',
  'placeholder_absence', 'connector', 'structural_noise', 'unknown_contribution',
] as const;

const PRICING_INTERPRETATION_MISSING_EVIDENCE_VALUES = [
  'missing_source_observation', 'missing_physical_page_proof',
  'insufficient_table_context', 'conflicting_observations',
  'missing_column_context', 'truncated_input',
] as const;

/**
 * Evaluation-only V2 field-grain output contract. Mirrors
 * `ForgewingPricingInterpretationProposalV2Schema`. The V1 constant above is
 * untouched and remains the only schema any production caller uses.
 *
 * Conditional shape (abstention) is expressed in
 * `PRICING_INTERPRETATION_V2_CONDITIONAL_FIELD_RULES` rather than a JSON Schema
 * union, matching the proven V1 approach.
 */
export const PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposalVersion', 'candidateId', 'rowInterpretationState', 'confidence',
    'fieldInterpretations'],
  properties: {
    proposalVersion: { type: 'string',
      enum: ['forgewing-pricing-interpretation-proposal-v2'] },
    candidateId: { type: 'string' },
    rowInterpretationState: { type: 'string',
      enum: ['observed', 'inferred', 'ambiguous', 'conflicting', 'insufficient_evidence'] },
    confidence: { type: ['number', 'null'] },
    fieldInterpretations: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['sourceFieldId', 'semanticRole', 'interpretationState', 'confidence',
          'contributions', 'rationaleCodes'],
        properties: {
          sourceFieldId: { type: 'string' },
          semanticRole: { type: 'string', enum: PRICING_INTERPRETATION_ROLE_VALUES },
          interpretationState: { type: 'string',
            enum: ['observed', 'inferred', 'ambiguous', 'conflicting', 'insufficient_evidence'] },
          confidence: { type: ['number', 'null'] },
          contributions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['observationId', 'contributionRole'],
              properties: {
                observationId: { type: 'string' },
                contributionRole: { type: 'string',
                  enum: PRICING_INTERPRETATION_V2_CONTRIBUTION_ROLE_VALUES },
              },
            },
          },
          rationaleCodes: { type: 'array',
            items: { type: 'string', enum: PRICING_INTERPRETATION_RATIONALE_VALUES } },
          missingEvidence: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['code'],
              properties: {
                code: { type: 'string',
                  enum: PRICING_INTERPRETATION_MISSING_EVIDENCE_VALUES },
                description: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export const PRICING_INTERPRETATION_V2_CONDITIONAL_FIELD_RULES = `V2 OUTPUT FIELD RULES:
- proposalVersion MUST be exactly "forgewing-pricing-interpretation-proposal-v2".
- candidateId MUST be the supplied candidate identifier.
- ROW RULE: if rowInterpretationState is "insufficient_evidence", the row-level confidence MUST be null. Otherwise row-level confidence MUST be a number between 0 and 1, or null.
- Emit exactly one fieldInterpretations entry for every supplied sourceFieldId. Never add, omit, or repeat one. At least 1 and at most 16 entries.
- sourceFieldId MUST be copied exactly from a supplied field. Never invent or edit one.
- If a field's interpretationState is "insufficient_evidence": semanticRole MUST be exactly "unknown", confidence MUST be null, contributions MUST be [], and missingEvidence MUST be present with 1 to 6 allowed codes.
- Otherwise: interpretationState MUST be one of "observed", "inferred", "ambiguous", "conflicting"; missingEvidence MUST NOT appear in that field object at all (not null, not [], omit the property); confidence MUST be a number between 0 and 1, or null; and contributions MUST contain exactly one entry per supplied member observationId of that field — same set, 1 to 16 entries, no duplicates, no omissions, no extras, no member from another field.
- rationaleCodes MUST contain 1 to 4 distinct allowed codes on every field, abstaining or not.
- One observation MUST NOT be given both placeholder_absence and a value-bearing role (value_token or component_part).
- Never return authoredRawText, sourceObservationIds, sourceFieldRole, or primitive raw text.` as const;

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
