import { describe, expect, it } from 'vitest';

import { parseTableContinuationModelOutput } from '@/lib/forgewing/runtime/structuredOutput';

describe('Forgewing table-continuation structured output', () => {
  it('accepts a bounded resolved relation with evidence from both sides', () => {
    expect(parseTableContinuationModelOutput(JSON.stringify({
      state: 'inferred',
      relation: 'same_table',
      evidenceIds: ['segment-prior', 'segment-next'],
      confidence: 0.75,
      rationaleCode: 'row_sequence_continues',
    }))).toMatchObject({ state: 'inferred', relation: 'same_table' });
  });

  it('preserves ambiguity separately from insufficient evidence', () => {
    expect(parseTableContinuationModelOutput(JSON.stringify({
      state: 'ambiguous',
      relation: 'ambiguous',
      evidenceIds: ['segment-prior', 'segment-next'],
      confidence: null,
      rationaleCode: 'mixed_evidence',
    })).state).toBe('ambiguous');
    expect(parseTableContinuationModelOutput(JSON.stringify({
      state: 'insufficient_evidence',
      evidenceIds: [],
      confidence: null,
      rationaleCode: 'insufficient_structure',
      missingEvidence: ['missing_column_context'],
    })).state).toBe('insufficient_evidence');
  });

  it('rejects state/relation mismatch, duplicate evidence, and unknown fields', () => {
    expect(() => parseTableContinuationModelOutput(JSON.stringify({
      state: 'ambiguous',
      relation: 'same_table',
      evidenceIds: ['segment-prior', 'segment-next'],
      confidence: null,
      rationaleCode: 'mixed_evidence',
    }))).toThrow('model_schema_rejected');
    expect(() => parseTableContinuationModelOutput(JSON.stringify({
      state: 'inferred',
      relation: 'same_table',
      evidenceIds: ['segment-prior', 'segment-prior'],
      confidence: 1,
      rationaleCode: 'column_structure_consistent',
    }))).toThrow('model_schema_rejected');
    expect(() => parseTableContinuationModelOutput(JSON.stringify({
      state: 'inferred',
      relation: 'same_table',
      evidenceIds: ['segment-prior', 'segment-next'],
      confidence: 1,
      rationaleCode: 'column_structure_consistent',
      chainOfThought: 'hidden',
    }))).toThrow('model_schema_rejected');
  });

  it('does not parse markdown or model prose', () => {
    expect(() => parseTableContinuationModelOutput('```json\n{}\n```'))
      .toThrow('invalid_model_json');
  });

  it('accepts schema_changed as a bounded separation rationale', () => {
    expect(parseTableContinuationModelOutput(JSON.stringify({
      state: 'inferred',
      relation: 'separate_tables',
      evidenceIds: ['segment-prior', 'segment-next'],
      confidence: 0.9,
      rationaleCode: 'schema_changed',
    })).rationaleCode).toBe('schema_changed');
  });
});
