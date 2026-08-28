/** SYNTHETIC FIXTURES ONLY. V2 JSON-schema <-> Zod parity and V1 non-regression. */
import { describe, expect, it } from 'vitest';

import {
  ForgewingContributionRoleSchema,
  ForgewingPricingInterpretationProposalV2Schema,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA,
  PRICING_INTERPRETATION_V2_CONDITIONAL_FIELD_RULES,
} from '@/lib/forgewing/runtime/structuredOutput';

const V2 = PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA;
const fieldProps = V2.properties.fieldInterpretations.items.properties;

function proposal(field: Record<string, unknown>) {
  return { proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: 'candidate-1', rowInterpretationState: 'observed', confidence: 0.8,
    fieldInterpretations: [field] };
}

describe('SYNTHETIC: V2 structured output parity', () => {
  it('declares the same contribution vocabulary as the Zod contract', () => {
    expect([...fieldProps.contributions.items.properties.contributionRole.enum])
      .toEqual([...ForgewingContributionRoleSchema.options]);
  });

  it('declares the same field interpretation states as the Zod contract', () => {
    expect([...fieldProps.interpretationState.enum]).toEqual([
      'observed', 'inferred', 'ambiguous', 'conflicting', 'insufficient_evidence']);
  });

  it('pins the V2 proposal version and requires the V2 top-level shape', () => {
    expect([...V2.properties.proposalVersion.enum])
      .toEqual([FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION]);
    expect([...V2.required]).toEqual(['proposalVersion', 'candidateId',
      'rowInterpretationState', 'confidence', 'fieldInterpretations']);
    expect(V2.additionalProperties).toBe(false);
    expect(V2.properties.fieldInterpretations.items.additionalProperties).toBe(false);
  });

  it('does not expose runtime-owned values on the provider surface', () => {
    for (const forbidden of ['authoredRawText', 'sourceObservationIds', 'sourceFieldRole',
      'sourceText', 'evidenceObservationIds']) {
      expect(Object.keys(fieldProps)).not.toContain(forbidden);
      expect(Object.keys(V2.properties)).not.toContain(forbidden);
    }
  });

  it('accepts a JSON-schema-shaped asserted field through the Zod contract', () => {
    const parsed = ForgewingPricingInterpretationProposalV2Schema.safeParse(proposal({
      sourceFieldId: 'forgewing-source-field-a', semanticRole: 'rate_like_amount',
      interpretationState: 'observed', confidence: 0.9,
      contributions: [{ observationId: 'obs-A', contributionRole: 'type_marker' },
        { observationId: 'obs-B', contributionRole: 'value_token' }],
      rationaleCodes: ['numeric_structure'],
    }));
    expect(parsed.success).toBe(true);
  });

  it('accepts a JSON-schema-shaped abstained field through the Zod contract', () => {
    const parsed = ForgewingPricingInterpretationProposalV2Schema.safeParse(proposal({
      sourceFieldId: 'forgewing-source-field-a', semanticRole: 'unknown',
      interpretationState: 'insufficient_evidence', confidence: null, contributions: [],
      rationaleCodes: ['missing_semantic_context'],
      missingEvidence: [{ code: 'missing_column_context' }],
    }));
    expect(parsed.success).toBe(true);
  });

  it('carries the conditional rules the JSON schema alone cannot express', () => {
    for (const rule of ['exactly one fieldInterpretations entry for every supplied sourceFieldId',
      'insufficient_evidence', 'contributions MUST be []', 'no member from another field',
      'Never return authoredRawText']) {
      expect(PRICING_INTERPRETATION_V2_CONDITIONAL_FIELD_RULES).toContain(rule);
    }
  });
});

describe('SYNTHETIC: V1 structured output is unchanged', () => {
  it('keeps the V1 primitive-grain shape and vocabulary intact', () => {
    expect([...PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA.required])
      .toEqual(['rowInterpretationState', 'confidence', 'interpretations']);
    const v1Item = PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA.properties.interpretations.items;
    expect([...v1Item.required]).toEqual(['sourceCellId', 'semanticRole', 'sourceText',
      'interpretationState', 'confidence', 'evidenceIds', 'rationaleCodes']);
    expect(Object.keys(v1Item.properties)).not.toContain('contributions');
    expect(Object.keys(v1Item.properties)).not.toContain('sourceFieldId');
  });

  it('keeps V1 and V2 as distinct objects', () => {
    expect(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA)
      .not.toBe(PRICING_INTERPRETATION_V2_OUTPUT_JSON_SCHEMA);
    expect(Object.keys(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA.properties))
      .not.toContain('fieldInterpretations');
  });
});
