import { z } from 'zod';

import {
  ForgewingMissingEvidenceCodeSchema,
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
