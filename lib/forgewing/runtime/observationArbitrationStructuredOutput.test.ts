import { describe, expect, it } from 'vitest';

import {
  parseObservationArbitrationModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

describe('Forgewing observation arbitration structured output', () => {
  it('accepts bounded inferred and insufficient-evidence output', () => {
    expect(parseObservationArbitrationModelOutput(JSON.stringify({
      state: 'inferred',
      relation: 'preserve_both',
      evidenceIds: ['candidate-a', 'candidate-b'],
      confidence: 0.7,
      rationaleCodes: ['complementary_fragments'],
    }))).toMatchObject({ relation: 'preserve_both' });
    expect(parseObservationArbitrationModelOutput(JSON.stringify({
      state: 'insufficient_evidence',
      evidenceIds: [],
      confidence: null,
      rationaleCodes: ['insufficient_structure'],
      missingEvidence: ['missing_source_observation'],
    }))).toMatchObject({ state: 'insufficient_evidence' });
  });

  it('fails closed on malformed, extra, and incomplete output', () => {
    expect(() => parseObservationArbitrationModelOutput('{')).toThrow('invalid_model_json');
    for (const value of [
      {
        state: 'inferred', relation: 'preserve_both', evidenceIds: ['candidate-a'],
        confidence: 0.7, rationaleCodes: ['complementary_fragments'],
      },
      {
        state: 'inferred', relation: 'resolved_a', evidenceIds: ['candidate-a', 'candidate-b'],
        confidence: 0.7, rationaleCodes: ['mixed_evidence'],
      },
      {
        state: 'insufficient_evidence', evidenceIds: [], confidence: null,
        rationaleCodes: ['insufficient_structure'], missingEvidence: [], extra: true,
      },
    ]) {
      expect(() => parseObservationArbitrationModelOutput(JSON.stringify(value)))
        .toThrow('model_schema_rejected');
    }
  });
});
