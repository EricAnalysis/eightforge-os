import { describe, expect, it } from 'vitest';

import { parseRegionClassificationModelOutput } from '@/lib/forgewing/runtime/structuredOutput';

describe('Forgewing provider output boundary', () => {
  it('rejects markdown-wrapped JSON and unknown fields', () => {
    expect(() => parseRegionClassificationModelOutput('```json\n{}\n```'))
      .toThrow('invalid_model_json');
    expect(() => parseRegionClassificationModelOutput(JSON.stringify({
      state: 'observed',
      classification: 'table',
      evidenceIds: ['segment-1'],
      confidence: 1,
      provenance: { page: 1 },
    }))).toThrow('model_schema_rejected');
  });

  it('requires two distinct references for conflict', () => {
    expect(() => parseRegionClassificationModelOutput(JSON.stringify({
      state: 'conflicting',
      evidenceIds: ['cell-1', 'cell-1'],
      confidence: null,
    }))).toThrow('model_schema_rejected');
  });
});

