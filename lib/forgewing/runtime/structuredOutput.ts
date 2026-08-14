import { z } from 'zod';

import {
  ForgewingMissingEvidenceCodeSchema,
  ForgewingRegionLabelSchema,
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
