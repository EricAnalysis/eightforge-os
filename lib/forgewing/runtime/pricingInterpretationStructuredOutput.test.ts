import { describe, expect, it } from 'vitest';

import {
  parsePricingInterpretationModelOutput,
  PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA,
} from './structuredOutput';

const valid = {
  rowInterpretationState: 'observed', confidence: 0.8,
  interpretations: [{ sourceCellId: 'cell-rate', semanticRole: 'rate_like_amount',
    sourceText: '$12.50', interpretationState: 'observed', confidence: 0.8,
    evidenceIds: ['cell-rate'], rationaleCodes: ['explicit_currency_marker'] }],
};

describe('pricing interpretation structured output', () => {
  it('accepts bounded descriptive interpretations without normalized values', () => {
    expect(parsePricingInterpretationModelOutput(JSON.stringify(valid))).toEqual(valid);
  });

  it('rejects malformed JSON, unknown fields, and normalized candidates', () => {
    expect(() => parsePricingInterpretationModelOutput('{')).toThrow('invalid_model_json');
    expect(() => parsePricingInterpretationModelOutput(JSON.stringify({ ...valid, canonicalRate: 12.5 })))
      .toThrow('model_schema_rejected');
    expect(() => parsePricingInterpretationModelOutput(JSON.stringify({
      ...valid,
      interpretations: [{ ...valid.interpretations[0], normalizedCandidate: '12.50' }],
    }))).toThrow('model_schema_rejected');
  });

  it('requires honest ambiguity, conflict, and insufficient-evidence shapes', () => {
    expect(() => parsePricingInterpretationModelOutput(JSON.stringify({
      ...valid, rowInterpretationState: 'ambiguous',
    }))).toThrow('model_schema_rejected');
    expect(() => parsePricingInterpretationModelOutput(JSON.stringify({
      ...valid, rowInterpretationState: 'conflicting',
    }))).toThrow('model_schema_rejected');
    expect(parsePricingInterpretationModelOutput(JSON.stringify({
      rowInterpretationState: 'insufficient_evidence', confidence: null,
      interpretations: [], missingEvidence: ['missing_column_context'],
    })).rowInterpretationState).toBe('insufficient_evidence');
  });

  it('keeps the provider schema structural and local Zod responsible for bounds', () => {
    const serialized = JSON.stringify(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA);
    for (const unsupported of ['minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength']) {
      expect(serialized).not.toContain(`"${unsupported}"`);
    }
  });
});
