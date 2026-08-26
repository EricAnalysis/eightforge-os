/**
 * Forgewing pricing interpretation proposal V2 contract (Phase A).
 *
 * V2 reasons at AUTHORED SOURCE FIELD grain: one semantic assertion per
 * authored cell, carrying a per-anchor contribution over that field's exact
 * primitive evidence membership. V1 (`forgewing-pricing-interpretation-proposal-v1`)
 * is untouched and remains the only contract any runtime consumes.
 *
 * Deliberate separations enforced by this module:
 *   - `sourceFieldRole` is deterministic source structure; `semanticRole` is a
 *     model assertion. Neither implies the other.
 *   - Evidence MEMBERSHIP is runtime-owned and derived from the frozen source
 *     field; CONTRIBUTION is the model's assertion over that membership.
 *   - `authoredRawText` is deterministic display text only: never a citable
 *     evidence anchor, never returned by the provider, never semantic truth.
 *
 * Phase A is contract + deterministic validation only. No provider wiring, no
 * numeric value extraction, no canonical or authority participation.
 */
import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  ForgewingMissingEvidenceSchema,
  ForgewingPricingInterpretationRationaleCodeSchema,
  ForgewingPricingSemanticRoleSchema,
} from '@/lib/forgewing/proposal/schema';

/** V2 is versioned separately. The V1 constant is never reused or mutated. */
export const FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION =
  'forgewing-pricing-interpretation-proposal-v2' as const;

/** Identity prefix for runtime-derived source field identities. */
export const FORGEWING_SOURCE_FIELD_ID_PREFIX = 'forgewing-source-field-' as const;

const boundedIdentifier = z.string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, 'identifier must not contain surrounding whitespace');

/**
 * Deterministic structural placement recorded by table reconstruction. This is
 * source metadata, NOT a semantic conclusion, and must never award semantic
 * correctness to a model assertion.
 */
export const ForgewingSourceFieldRoleSchema = z.enum([
  'category',
  'description',
  'unit',
  'origin_destination',
  'rate',
  'quantity',
  'item_number',
  'extended_amount',
  'unknown',
]);

/**
 * Generic, cross-domain contribution vocabulary. Task profiles may NARROW this
 * set; they must not extend it, so contribution semantics stay comparable
 * across pricing, units, dates, and future clause-grain tasks.
 *
 *   type_marker         signals the field's kind, carries no value ($, USD, Per)
 *   value_token         carries the field's value in whole
 *   component_part      carries part of one indivisible value (fragmented numerics/dates)
 *   semantic_head       primary meaning-bearing text
 *   semantic_modifier   qualifies the head
 *   placeholder_absence marks absence; explicitly NOT zero and NOT a value
 *   connector           punctuation or joiner with no independent meaning
 *   structural_noise    layout or extraction artifact
 *   unknown_contribution model cannot characterise this anchor
 */
export const ForgewingContributionRoleSchema = z.enum([
  'type_marker',
  'value_token',
  'component_part',
  'semantic_head',
  'semantic_modifier',
  'placeholder_absence',
  'connector',
  'structural_noise',
  'unknown_contribution',
]);

/** Contribution roles asserting the field's value; mutually exclusive with absence. */
const VALUE_BEARING_CONTRIBUTION_ROLES: ReadonlySet<string> = new Set([
  'value_token',
  'component_part',
]);

export const ForgewingFieldInterpretationStateSchema = z.enum([
  'observed',
  'inferred',
  'ambiguous',
  'conflicting',
  'insufficient_evidence',
]);

const observationIdList = z.array(boundedIdentifier)
  .min(1)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length, 'observation ids must be distinct');

/**
 * Deterministic source-field input. Every member is runtime-derived from frozen
 * extraction output; none of it establishes semantic correctness.
 */
export const ForgewingSourceFieldInputSchema = z.object({
  sourceFieldId: boundedIdentifier,
  sourceFieldRole: ForgewingSourceFieldRoleSchema,
  /** Deterministic display reconstruction. Not an evidence object, not citable. */
  authoredRawText: z.string().min(1).max(4_000),
  sourceObservationIds: observationIdList,
  physicalPageNumber: z.number().int().positive(),
}).strict();

export const ForgewingSourceFieldContextSchema = z.object({
  sourceDocumentId: boundedIdentifier,
  sourceArtifactId: boundedIdentifier,
  rowObservationId: boundedIdentifier,
  physicalPageNumber: z.number().int().positive(),
}).strict();

export type ForgewingSourceFieldInput = z.infer<typeof ForgewingSourceFieldInputSchema>;
export type ForgewingSourceFieldContext = z.infer<typeof ForgewingSourceFieldContextSchema>;
export type ForgewingContributionRole = z.infer<typeof ForgewingContributionRoleSchema>;
export type ForgewingSourceFieldRole = z.infer<typeof ForgewingSourceFieldRoleSchema>;

/**
 * Derives a stable source field identity.
 *
 * Identity inputs (exactly these, canonicalised):
 *   sourceDocumentId, sourceArtifactId, physicalPageNumber, rowObservationId,
 *   sourceFieldRole, sorted sourceObservationIds.
 *
 * Deliberately excluded: model output, semantic role, confidence, provider
 * response, authored text, geometry, column index, and extraction snapshot id
 * (so re-extracting identical bytes yields an identical field identity).
 */
export function deriveSourceFieldId(params: {
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  rowObservationId: string;
  sourceFieldRole: ForgewingSourceFieldRole;
  sourceObservationIds: readonly string[];
}): string {
  const memberIds = [...params.sourceObservationIds];
  if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
    throw new Error('forgewing_source_field_identity_requires_distinct_members');
  }
  return `${FORGEWING_SOURCE_FIELD_ID_PREFIX}${hashCanonical({
    sourceDocumentId: params.sourceDocumentId,
    sourceArtifactId: params.sourceArtifactId,
    physicalPageNumber: params.physicalPageNumber,
    rowObservationId: params.rowObservationId,
    sourceFieldRole: params.sourceFieldRole,
    sourceObservationIds: memberIds.sort((left, right) => left.localeCompare(right, 'en-US')),
  })}`;
}

const contributionSchema = z.object({
  observationId: boundedIdentifier,
  contributionRole: ForgewingContributionRoleSchema,
}).strict();

/**
 * Asserted field interpretation. The provider supplies ONLY assertions: it
 * never echoes authoredRawText, primitive raw text, or evidence membership.
 */
const assertedFieldInterpretationSchema = z.object({
  sourceFieldId: boundedIdentifier,
  semanticRole: ForgewingPricingSemanticRoleSchema,
  interpretationState: z.enum(['observed', 'inferred', 'ambiguous', 'conflicting']),
  confidence: z.number().min(0).max(1).nullable(),
  contributions: z.array(contributionSchema).min(1).max(16),
  rationaleCodes: z.array(ForgewingPricingInterpretationRationaleCodeSchema)
    .min(1)
    .max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
}).strict();

/** Per-field abstention. One uninterpretable field never erases its siblings. */
const abstainedFieldInterpretationSchema = z.object({
  sourceFieldId: boundedIdentifier,
  semanticRole: z.literal('unknown'),
  interpretationState: z.literal('insufficient_evidence'),
  confidence: z.null(),
  contributions: z.array(contributionSchema).length(0),
  rationaleCodes: z.array(ForgewingPricingInterpretationRationaleCodeSchema)
    .min(1)
    .max(4)
    .refine((codes) => new Set(codes).size === codes.length, 'rationale codes must be distinct'),
  missingEvidence: z.array(ForgewingMissingEvidenceSchema).min(1).max(6),
}).strict();

export const ForgewingFieldInterpretationSchema = z.discriminatedUnion('interpretationState', [
  assertedFieldInterpretationSchema,
  abstainedFieldInterpretationSchema,
]);

/** Provider-facing V2 output surface: assertions only. */
export const ForgewingPricingInterpretationProposalV2Schema = z.object({
  proposalVersion: z.literal(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION),
  candidateId: boundedIdentifier,
  rowInterpretationState: ForgewingFieldInterpretationStateSchema,
  confidence: z.number().min(0).max(1).nullable(),
  fieldInterpretations: z.array(ForgewingFieldInterpretationSchema).min(1).max(16),
}).strict();

export type ForgewingFieldInterpretation = z.infer<typeof ForgewingFieldInterpretationSchema>;
export type ForgewingPricingInterpretationProposalV2 =
  z.infer<typeof ForgewingPricingInterpretationProposalV2Schema>;

export function isValueBearingContributionRole(role: ForgewingContributionRole): boolean {
  return VALUE_BEARING_CONTRIBUTION_ROLES.has(role);
}
