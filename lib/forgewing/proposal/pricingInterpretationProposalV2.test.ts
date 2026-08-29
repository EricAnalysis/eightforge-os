/**
 * SYNTHETIC FIXTURES ONLY. Generic invented observation ids and text. These
 * tests exercise the V2 contract shape and deterministic identity; they are not
 * corpus evidence, not measurement, and not promotion evidence.
 */
import { describe, expect, it } from 'vitest';

import {
  deriveSourceFieldId,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  FORGEWING_SOURCE_FIELD_ID_PREFIX,
  ForgewingContributionRoleSchema,
  ForgewingPricingInterpretationProposalV2Schema,
  ForgewingSourceFieldInputSchema,
  ForgewingSourceFieldRoleSchema,
  isValueBearingContributionRole,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
} from '@/lib/forgewing/proposal/schemaVersion';

const IDENTITY = {
  sourceDocumentId: 'synthetic-document',
  sourceArtifactId: 'synthetic-artifact',
  physicalPageNumber: 7,
  rowObservationId: 'synthetic-row',
  sourceFieldRole: 'rate',
  sourceObservationIds: ['obs-A', 'obs-B'],
} as const;

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
    candidateId: 'synthetic-candidate',
    rowInterpretationState: 'observed',
    confidence: 0.8,
    fieldInterpretations: [{
      sourceFieldId: 'synthetic-field',
      semanticRole: 'rate_like_amount',
      interpretationState: 'observed',
      confidence: 0.9,
      contributions: [
        { observationId: 'obs-A', contributionRole: 'type_marker' },
        { observationId: 'obs-B', contributionRole: 'value_token' },
      ],
      rationaleCodes: ['numeric_structure'],
    }],
    ...overrides,
  };
}

describe('SYNTHETIC: Forgewing pricing proposal V2 contract', () => {
  it('is versioned separately from V1 and never reuses the V1 constant', () => {
    expect(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION)
      .toBe('forgewing-pricing-interpretation-proposal-v2');
    expect(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION)
      .toBe('forgewing-pricing-interpretation-proposal-v1');
    expect(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION)
      .not.toBe(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION);
  });

  it('rejects a proposal carrying the V1 version', () => {
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(
      proposal({ proposalVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION }),
    ).success).toBe(false);
  });

  it('accepts an asserted field interpretation with contributions', () => {
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(proposal()).success).toBe(true);
  });

  it('does not accept provider-echoed source text or evidence membership', () => {
    for (const extra of [
      { authoredRawText: 'synthetic authored text' },
      { sourceText: 'synthetic primitive text' },
      { evidenceObservationIds: ['obs-A', 'obs-B'] },
      { sourceFieldRole: 'rate' },
    ]) {
      const withExtra = proposal();
      Object.assign(withExtra.fieldInterpretations[0]!, extra);
      expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(withExtra).success).toBe(false);
    }
  });

  it('round-trips every generic contribution role and rejects unknown roles', () => {
    for (const role of ForgewingContributionRoleSchema.options) {
      expect(ForgewingContributionRoleSchema.safeParse(role).success).toBe(true);
    }
    expect(ForgewingContributionRoleSchema.options).toEqual([
      'type_marker', 'value_token', 'component_part', 'semantic_head', 'semantic_modifier',
      'placeholder_absence', 'connector', 'structural_noise', 'unknown_contribution',
    ]);
    for (const role of ['currency_marker', 'numeric_magnitude', 'unit_text', 'description_text', '']) {
      expect(ForgewingContributionRoleSchema.safeParse(role).success).toBe(false);
    }
  });

  it('marks only value-bearing roles as incompatible with absence', () => {
    expect(isValueBearingContributionRole('value_token')).toBe(true);
    expect(isValueBearingContributionRole('component_part')).toBe(true);
    for (const role of ['type_marker', 'semantic_head', 'semantic_modifier', 'connector',
      'structural_noise', 'unknown_contribution', 'placeholder_absence'] as const) {
      expect(isValueBearingContributionRole(role)).toBe(false);
    }
  });

  it('keeps deterministic source-field roles distinct from asserted semantic roles', () => {
    expect(ForgewingSourceFieldRoleSchema.options).toContain('rate');
    expect(ForgewingSourceFieldRoleSchema.safeParse('rate_like_amount').success).toBe(false);
    const field = ForgewingSourceFieldInputSchema.safeParse({
      sourceFieldId: 'synthetic-field', sourceFieldRole: 'rate',
      authoredRawText: 'synthetic authored text', sourceObservationIds: ['obs-A'],
      physicalPageNumber: 7,
    });
    expect(field.success).toBe(true);
    expect(Object.keys(field.success ? field.data : {})).not.toContain('semanticRole');
  });

  it('requires per-field abstention to carry missing evidence and no contributions', () => {
    const abstained = proposal({ rowInterpretationState: 'insufficient_evidence', confidence: null,
      fieldInterpretations: [{ sourceFieldId: 'synthetic-field', semanticRole: 'unknown',
        interpretationState: 'insufficient_evidence', confidence: null, contributions: [],
        rationaleCodes: ['missing_semantic_context'],
        missingEvidence: [{ code: 'missing_column_context' }] }] });
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(abstained).success).toBe(true);

    const withContributions = proposal({ fieldInterpretations: [{
      sourceFieldId: 'synthetic-field', semanticRole: 'unknown',
      interpretationState: 'insufficient_evidence', confidence: null,
      contributions: [{ observationId: 'obs-A', contributionRole: 'type_marker' }],
      rationaleCodes: ['missing_semantic_context'],
      missingEvidence: [{ code: 'missing_column_context' }] }] });
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(withContributions).success)
      .toBe(false);

    const withoutMissingEvidence = proposal({ fieldInterpretations: [{
      sourceFieldId: 'synthetic-field', semanticRole: 'unknown',
      interpretationState: 'insufficient_evidence', confidence: null, contributions: [],
      rationaleCodes: ['missing_semantic_context'] }] });
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(withoutMissingEvidence).success)
      .toBe(false);
  });

  it('forbids missingEvidence on an asserted field state', () => {
    const asserted = proposal();
    Object.assign(asserted.fieldInterpretations[0]!, {
      missingEvidence: [{ code: 'missing_column_context' }],
    });
    expect(ForgewingPricingInterpretationProposalV2Schema.safeParse(asserted).success).toBe(false);
  });

  it('carries no normalized numeric value anywhere in the contract', () => {
    const serialized = JSON.stringify(proposal());
    for (const forbidden of ['normalizedValue', 'numericAmount', 'parsedRate']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('SYNTHETIC: V2 source field identity determinism', () => {
  it('is stable for identical immutable inputs', () => {
    expect(deriveSourceFieldId(IDENTITY)).toBe(deriveSourceFieldId(IDENTITY));
    expect(deriveSourceFieldId(IDENTITY)).toMatch(
      new RegExp(`^${FORGEWING_SOURCE_FIELD_ID_PREFIX}[0-9a-f]{64}$`),
    );
  });

  it('canonicalizes member order so the same membership set yields one identity', () => {
    expect(deriveSourceFieldId({ ...IDENTITY, sourceObservationIds: ['obs-B', 'obs-A'] }))
      .toBe(deriveSourceFieldId(IDENTITY));
  });

  it('separates different membership, role, row, page, artifact, and document', () => {
    const base = deriveSourceFieldId(IDENTITY);
    for (const variant of [
      { sourceObservationIds: ['obs-A', 'obs-C'] },
      { sourceObservationIds: ['obs-A'] },
      { sourceFieldRole: 'unit' as const },
      { rowObservationId: 'synthetic-row-other' },
      { physicalPageNumber: 8 },
      { sourceArtifactId: 'synthetic-artifact-other' },
      { sourceDocumentId: 'synthetic-document-other' },
    ]) {
      expect(deriveSourceFieldId({ ...IDENTITY, ...variant })).not.toBe(base);
    }
  });

  it('never derives identity from model output or authored text', () => {
    const inputs = Object.keys(IDENTITY);
    for (const forbidden of ['semanticRole', 'confidence', 'authoredRawText',
      'columnIndex', 'boundingBox', 'extractionSnapshotId']) {
      expect(inputs).not.toContain(forbidden);
    }
  });

  it('fails closed on empty or duplicated membership', () => {
    expect(() => deriveSourceFieldId({ ...IDENTITY, sourceObservationIds: [] })).toThrow();
    expect(() => deriveSourceFieldId({ ...IDENTITY, sourceObservationIds: ['obs-A', 'obs-A'] }))
      .toThrow();
  });
});
